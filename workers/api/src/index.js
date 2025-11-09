/**
 * Mailhop API Worker (Cloudflare Workers + D1/SQLite)
 * ---------------------------------------------------
 * Purpose: CRUD for email aliases used by the email-routing worker,
 *          plus a read-only endpoint for email_logs.
 *
 * Expected D1 schema:
 *
 *   CREATE TABLE aliases (
 *     id         INTEGER PRIMARY KEY AUTOINCREMENT,
 *     address    TEXT UNIQUE NOT NULL COLLATE NOCASE, -- alias (e.g., "user@example.com")
 *     forward_to TEXT NOT NULL,                        -- destination (e.g., "destination@example.net")
 *     notes      TEXT,
 *     created_at INTEGER NOT NULL,                     -- unix seconds
 *     allow_plus INTEGER NOT NULL DEFAULT 1            -- 1 = user+tag@... allowed
 *   );
 *
 *   CREATE INDEX idx_address    ON aliases(address);
 *   CREATE INDEX idx_forward_to ON aliases(forward_to);
 *
 *   CREATE TABLE email_logs (
 *     id         INTEGER PRIMARY KEY AUTOINCREMENT,
 *     ts         INTEGER NOT NULL,       -- unix seconds
 *     message_id TEXT,
 *     from_addr  TEXT,
 *     to_addr    TEXT,
 *     route      TEXT,
 *     base_addr  TEXT,
 *     dest_addr  TEXT,
 *     result     TEXT,
 *     size_bytes INTEGER,
 *     error      TEXT
 *   );
 *
 * Endpoints:
 *   GET    /aliases                               → list all aliases
 *   GET    /aliases/by-destination?email=...      → list aliases by forward_to
 *   GET    /aliases/:address                      → fetch single alias
 *   POST   /aliases                               → create {address, forward_to, notes?, allow_plus?}
 *   PATCH  /aliases/:address                      → update {forward_to?, notes?, allow_plus?}
 *   DELETE /aliases/:address                      → delete alias by address
 *   GET    /logs?limit=50                         → latest email_logs (descending by ts)
 *   GET    /                                      → API description
 *
 * Notes:
 * - All emails are normalized to lowercase (case-insensitive behavior).
 * - created_at and ts are stored as unix **seconds**.
 * - allow_plus is an integer 0/1.
 * - D1 binding must be exposed as `env.DB` in wrangler local config.
 * - API auth is controlled by `env.MAILHOP_API_KEY` (secret).
 */

/// ─────────────────────────────────────────────────────────────────────────────
/// Authentication
/// ─────────────────────────────────────────────────────────────────────────────

/**
 * checkAuth(request, env)
 * -----------------------
 * Enforces a simple Bearer token check:
 *
 *   - If env.MAILHOP_API_KEY is NOT set → no auth required (dev mode).
 *   - If it IS set → require:
 *         Authorization: Bearer <MAILHOP_API_KEY>
 */
function checkAuth(request, env) {
  const requiredKey = env.MAILHOP_API_KEY;

  // If no key configured, skip auth (useful for local dev).
  if (!requiredKey) return true;

  const authHeader = request.headers.get("authorization") || "";
  const expected = `Bearer ${requiredKey}`;

  return authHeader === expected;
}

/// ─────────────────────────────────────────────────────────────────────────────
/// Helpers
/// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a JSON response with permissive CORS.
 * You can tighten CORS later (e.g. set a specific origin).
 */
function json(data, { status = 200 } = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type,authorization",
    },
  });
}

/** Normalize an email: trim + lowercase (emails are case-insensitive). */
function toEmail(s) {
  return (s || "").trim().toLowerCase();
}

/** Current unix time in **seconds** (D1 stores this as INTEGER). */
function nowSecs() {
  return Math.floor(Date.now() / 1000);
}

/**
 * Safe JSON body reader with a clear 400 error if parsing fails.
 * Attaches `err.status = 400` so the caller can use it in a generic handler.
 */
async function readJSON(request) {
  try {
    return await request.json();
  } catch {
    const err = new Error("Invalid JSON body");
    err.status = 400;
    throw err;
  }
}

/// ─────────────────────────────────────────────────────────────────────────────
/// Route handlers: aliases
/// ─────────────────────────────────────────────────────────────────────────────

/** GET /aliases → list all aliases. */
async function listAliases(env) {
  const result = await env.DB.prepare(
    "SELECT id, address, forward_to, notes, created_at, allow_plus FROM aliases ORDER BY address"
  ).all();

  return json(result.results ?? []);
}

/** GET /aliases/by-destination?email=... → list aliases by forward_to. */
async function listByDestination(env, url) {
  const email = toEmail(url.searchParams.get("email"));
  if (!email) {
    return json({ error: "email parameter required" }, { status: 400 });
  }

  const result = await env.DB.prepare(
    "SELECT id, address, forward_to, notes, created_at, allow_plus FROM aliases WHERE forward_to = ? ORDER BY address"
  ).bind(email).all();

  return json(result.results ?? []);
}

/** GET /aliases/:address → fetch a single alias row. */
async function getAlias(env, url) {
  const raw = url.pathname.split("/").pop() || "";
  const addressParam = toEmail(decodeURIComponent(raw));
  if (!addressParam) {
    return json({ error: "Email address required" }, { status: 400 });
  }

  const row = await env.DB.prepare(
    "SELECT id, address, forward_to, notes, created_at, allow_plus FROM aliases WHERE address = ? LIMIT 1"
  ).bind(addressParam).first();

  if (!row) {
    return json({ error: "Alias not found" }, { status: 404 });
  }

  return json(row);
}

/** POST /aliases → create a new alias. */
async function createAlias(env, request) {
  const data = await readJSON(request);

  const address = toEmail(data.address);
  const forward_to = toEmail(data.forward_to);
  const notes = typeof data.notes === "string" ? data.notes : null;

  // allow_plus can be boolean or 0/1; normalize to integer 0 or 1.
  const allow_plus =
    typeof data.allow_plus === "undefined" ? 1 : (data.allow_plus ? 1 : 0);

  // Required field validation.
  if (!address || !forward_to) {
    return json(
      { error: "address and forward_to are required" },
      { status: 400 }
    );
  }

  // Minimal sanity checks; not full RFC validation.
  if (!address.includes("@") || !forward_to.includes("@")) {
    return json({ error: "Invalid email address" }, { status: 400 });
  }

  try {
    await env.DB.prepare(
      "INSERT INTO aliases (address, forward_to, notes, created_at, allow_plus) VALUES (?, ?, ?, ?, ?)"
    )
      .bind(address, forward_to, notes, nowSecs(), allow_plus)
      .run();

    return json({
      success: true,
      alias: { address, forward_to, notes, allow_plus },
    });
  } catch (err) {
    // Most likely a UNIQUE constraint violation on address.
    return json({ error: "Alias already exists" }, { status: 409 });
  }
}

/**
 * PATCH /aliases/:address
 * Update forward_to / notes / allow_plus for a specific alias.
 */
async function updateAlias(env, request, url) {
  const raw = url.pathname.split("/").pop() || "";
  const addressParam = toEmail(decodeURIComponent(raw));
  if (!addressParam) {
    return json({ error: "Email address required" }, { status: 400 });
  }

  const data = await readJSON(request);

  const updates = [];
  const binds = [];

  if (typeof data.forward_to !== "undefined") {
    const v = toEmail(data.forward_to);
    if (!v || !v.includes("@")) {
      return json(
        { error: "forward_to must be a valid email" },
        { status: 400 }
      );
    }
    updates.push("forward_to = ?");
    binds.push(v);
  }

  if (typeof data.notes !== "undefined") {
    const v = data.notes === null ? null : String(data.notes);
    updates.push("notes = ?");
    binds.push(v);
  }

  if (typeof data.allow_plus !== "undefined") {
    const v = data.allow_plus ? 1 : 0;
    updates.push("allow_plus = ?");
    binds.push(v);
  }

  if (updates.length === 0) {
    return json(
      { error: "No updatable fields provided (forward_to, notes, allow_plus)" },
      { status: 400 }
    );
  }

  // WHERE condition bind added last.
  binds.push(addressParam);

  const sql = `UPDATE aliases SET ${updates.join(", ")} WHERE address = ?`;
  const res = await env.DB.prepare(sql).bind(...binds).run();

  if (res.meta.changes === 0) {
    return json({ error: "Alias not found" }, { status: 404 });
  }

  // Return the updated row for convenience (CLI / UI friendly).
  const row = await env.DB.prepare(
    "SELECT id, address, forward_to, notes, created_at, allow_plus FROM aliases WHERE address = ? LIMIT 1"
  ).bind(addressParam).first();

  return json({ success: true, alias: row });
}

/** DELETE /aliases/:address → remove an alias. */
async function deleteAlias(env, url) {
  const raw = url.pathname.split("/").pop() || "";
  const addressParam = toEmail(decodeURIComponent(raw));
  if (!addressParam) {
    return json({ error: "Email address required" }, { status: 400 });
  }

  const result = await env.DB.prepare(
    "DELETE FROM aliases WHERE address = ?"
  ).bind(addressParam).run();

  if (result.meta.changes === 0) {
    return json({ error: "Alias not found" }, { status: 404 });
  }

  return json({ success: true, deleted: addressParam });
}

/// ─────────────────────────────────────────────────────────────────────────────
/// Route handler: logs
/// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /logs?limit=50
 * Returns latest email_logs rows in reverse chronological order.
 * Intended for CLI consumption (mailhop logs N).
 */
async function listEmailLogs(env, url) {
  const rawLimit = url.searchParams.get("limit");
  let limit = Number.parseInt(rawLimit || "50", 10);

  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  if (limit > 500) limit = 500; // safety cap

  const result = await env.DB.prepare(
    "SELECT id, ts, message_id, from_addr, to_addr, route, base_addr, dest_addr, result, size_bytes, error FROM email_logs ORDER BY ts DESC, id DESC LIMIT ?"
  ).bind(limit).all();

  return json(result.results ?? []);
}

/// ─────────────────────────────────────────────────────────────────────────────
/// Router
/// ─────────────────────────────────────────────────────────────────────────────

export default {
  /**
   * Entry point for all HTTP requests.
   * The `env` parameter contains:
   *   - env.DB               → D1 binding (SQLite)
   *   - env.MAILHOP_API_KEY  → optional API auth secret
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight must be answered even if unauthorized.
    if (request.method === "OPTIONS") {
      return json({ ok: true });
    }

    // Authentication check for all non-preflight routes.
    if (!checkAuth(request, env)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "content-type": "text/plain" },
      });
    }

    try {
      // --- Aliases routes ---

      // GET /aliases
      if (request.method === "GET" && url.pathname === "/aliases") {
        return await listAliases(env);
      }

      // GET /aliases/by-destination?email=...
      if (
        request.method === "GET" &&
        url.pathname === "/aliases/by-destination"
      ) {
        return await listByDestination(env, url);
      }

      // GET /aliases/:address
      if (
        request.method === "GET" &&
        url.pathname.startsWith("/aliases/") &&
        url.pathname !== "/aliases/by-destination"
      ) {
        return await getAlias(env, url);
      }

      // POST /aliases
      if (request.method === "POST" && url.pathname === "/aliases") {
        return await createAlias(env, request);
      }

      // PATCH /aliases/:address
      if (request.method === "PATCH" && url.pathname.startsWith("/aliases/")) {
        return await updateAlias(env, request, url);
      }

      // DELETE /aliases/:address
      if (request.method === "DELETE" && url.pathname.startsWith("/aliases/")) {
        return await deleteAlias(env, url);
      }

      // --- Logs route ---

      // GET /logs?limit=N
      if (request.method === "GET" && url.pathname === "/logs") {
        return await listEmailLogs(env, url);
      }

      // --- Root route ---

      if (url.pathname === "/") {
        return json({
          name: "mailhop API",
          description:
            "Manage Mailhop email aliases and inspect email routing logs.",
          auth: {
            type: "Bearer token",
            env_var: "MAILHOP_API_KEY",
            header_example: "Authorization: Bearer <MAILHOP_API_KEY>",
          },
          endpoints: {
            "GET /aliases":
              "List all aliases (id, address, forward_to, notes, created_at, allow_plus)",
            "GET /aliases/:address":
              "Fetch a single alias by its full address",
            "GET /aliases/by-destination?email=…":
              "Find aliases pointing at a specific forward_to address",
            "POST /aliases":
              "Create alias {address, forward_to, notes?, allow_plus?}",
            "PATCH /aliases/:address":
              "Update fields (forward_to, notes, allow_plus)",
            "DELETE /aliases/:address": "Delete alias by address",
            "GET /logs?limit=50":
              "Fetch the most recent email_logs entries (for debugging / CLI)",
          },
        });
      }

      // 404 fallback for unknown paths.
      return new Response("Not found", { status: 404 });
    } catch (e) {
      // Centralized error handler for unexpected issues.
      const status = e && e.status ? e.status : 500;
      const message =
        e && e.message
          ? e.message
          : "Internal error while processing request";
      return json({ error: message }, { status });
    }
  },
};