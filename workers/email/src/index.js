/**
 * Mailhop Email Worker
 * --------------------
 * Routes inbound mail for a single domain based on aliases stored in D1.
 *
 * Key ideas:
 * - We only accept mail for ONE domain (env.DOMAIN).
 * - We support:
 *    - exact aliases:   user@example.com
 *    - plus addressing: user+tag@example.com  → user@example.com (if allow_plus=1)
 * - We log every message to:
 *    - console as structured JSON
 *    - D1 email_logs table (best-effort)
 *
 * Expected D1 schema (simplified):
 *
 *   CREATE TABLE aliases (
 *     id         INTEGER PRIMARY KEY AUTOINCREMENT,
 *     address    TEXT UNIQUE NOT NULL,   -- alias (e.g., "user@example.com")
 *     forward_to TEXT NOT NULL,          -- destination (e.g., "destination@example.net")
 *     notes      TEXT,
 *     created_at INTEGER NOT NULL,
 *     allow_plus INTEGER NOT NULL DEFAULT 1  -- 1 = plus-addressing enabled
 *   );
 *
 *   CREATE TABLE email_logs (
 *     id         INTEGER PRIMARY KEY AUTOINCREMENT,
 *     ts         INTEGER NOT NULL,       -- unix seconds
 *     message_id TEXT,
 *     from_addr  TEXT,
 *     to_addr    TEXT,
 *     route      TEXT,                   -- "exact" | "base+tag" | "none" | "invalid-domain" | "exception"
 *     base_addr  TEXT,                   -- base alias for plus addressing
 *     dest_addr  TEXT,                   -- final destination address
 *     result     TEXT,                   -- "forwarded" | "rejected" | "error"
 *     size_bytes INTEGER,
 *     error      TEXT
 *   );
 */

/// ─────────────────────────────────────────────────────────────────────────────
/// Utilities
/// ─────────────────────────────────────────────────────────────────────────────

/** Normalize arbitrary strings (emails, domains) to lowercase with no surrounding spaces. */
function norm(s) {
  return (s || "").trim().toLowerCase();
}

/**
 * Get the domain this worker is responsible for.
 * - Comes from Wrangler vars: env.DOMAIN
 * - Falls back to "example.com" if not set (so misconfig is obvious in logs).
 */
function getDomain(env) {
  const configured = env && env.DOMAIN ? norm(env.DOMAIN) : "";
  return configured || "example.com";
}

/**
 * Split an email address into { local, domain, full } parts.
 * If not valid (no "@"), returns empty local/domain but keeps full.
 */
function splitAddress(raw) {
  const full = norm(raw);
  const at = full.lastIndexOf("@");
  if (at < 1) {
    return { local: "", domain: "", full };
  }
  return {
    local: full.slice(0, at),
    domain: full.slice(at + 1),
    full,
  };
}

/** Return true if addr is in the same domain as env.DOMAIN. */
function isOurDomain(addr, env) {
  const { domain } = splitAddress(addr);
  return domain === getDomain(env);
}

/** Prevent routing loops: never forward back into our own domain. */
function wouldLoop(forwardTo, env) {
  return isOurDomain(forwardTo, env);
}

/**
 * Emit one JSON log line to console.
 * Cloudflare `wrangler tail` will show these.
 */
function logEvent(data) {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      ...data,
    })
  );
}

/**
 * Persist one log row into D1.
 * This is best-effort:
 * - we catch and ignore errors so mail flow is never blocked by logging failures.
 */
async function persistLog(env, entry) {
  try {
    await env.DB.prepare(
      `INSERT INTO email_logs
       (ts, message_id, from_addr, to_addr, route, base_addr, dest_addr, result, size_bytes, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        Math.floor(Date.now() / 1000),
        entry.id || null,
        entry.from || null,
        entry.to || null,
        entry.route || null,
        entry.base || null,
        entry.dest || null,
        entry.result || null,
        Number(entry.size ?? 0),
        entry.error ? String(entry.error).slice(0, 2000) : null
      )
      .run();
  } catch {
    // Intentionally ignore logging errors
  }
}

/// ─────────────────────────────────────────────────────────────────────────────
/// Worker entrypoint
/// ─────────────────────────────────────────────────────────────────────────────

export default {
  /**
   * Email handler called by Cloudflare's Email Routing.
   * @param {EmailMessage} message - the inbound email
   * @param {Object} env          - environment bindings (D1, vars, etc.)
   */
  async email(message, env) {
    // Basic metadata we’ll reuse in all logs
    const rcpt = splitAddress(message.to);
    const domain = getDomain(env);
    const msgMeta = {
      id: message.headers.get("Message-Id") || crypto.randomUUID(),
      from: message.from,
      to: message.to,
      size: message.rawSize,
      domain,
    };

    try {
      // 0) Sanity check: only accept mail for our configured domain
      if (!rcpt.local || rcpt.domain !== domain) {
        const entry = {
          ...msgMeta,
          route: "invalid-domain",
          result: "rejected",
          error: `recipient domain ${rcpt.domain || "<none>"} does not match worker domain ${domain}`,
        };
        logEvent(entry);
        await persistLog(env, entry);
        await message.setReject("550 Invalid recipient for this domain");
        return;
      }

      // 1️⃣ Exact match: look for full alias row (user@example.com)
      const exact = await env.DB
        .prepare(
          "SELECT address, forward_to, allow_plus FROM aliases WHERE address = ? LIMIT 1"
        )
        .bind(rcpt.full)
        .first();

      if (exact) {
        if (wouldLoop(exact.forward_to, env)) {
          const entry = {
            ...msgMeta,
            route: "exact",
            dest: exact.forward_to,
            result: "rejected",
            error: "routing loop detected (forward_to is in our own domain)",
          };
          logEvent(entry);
          await persistLog(env, entry);
          await message.setReject("550 Routing loop detected");
          return;
        }

        try {
          await message.forward(exact.forward_to);
          const entry = {
            ...msgMeta,
            route: "exact",
            dest: exact.forward_to,
            result: "forwarded",
          };
          logEvent(entry);
          await persistLog(env, entry);
        } catch (err) {
          const entry = {
            ...msgMeta,
            route: "exact",
            dest: exact.forward_to,
            result: "error",
            error: String(err),
          };
          logEvent(entry);
          await persistLog(env, entry);
          await message.setReject("550 Destination not verified");
        }
        return;
      }

      // 2️⃣ Plus addressing: user+tag@example.com → user@example.com
      const plusIdx = rcpt.local.indexOf("+");
      if (plusIdx > -1) {
        const baseLocal = rcpt.local.slice(0, plusIdx);
        const base = `${baseLocal}@${rcpt.domain}`;

        const baseRow = await env.DB
          .prepare(
            "SELECT address, forward_to, allow_plus FROM aliases WHERE address = ? LIMIT 1"
          )
          .bind(base)
          .first();

        // Only route if base alias exists AND allow_plus=1
        if (baseRow && Number(baseRow.allow_plus) === 1) {
          if (wouldLoop(baseRow.forward_to, env)) {
            const entry = {
              ...msgMeta,
              route: "base+tag",
              base,
              dest: baseRow.forward_to,
              result: "rejected",
              error: "routing loop detected (forward_to is in our own domain)",
            };
            logEvent(entry);
            await persistLog(env, entry);
            await message.setReject("550 Routing loop detected");
            return;
          }

          try {
            await message.forward(baseRow.forward_to);
            const entry = {
              ...msgMeta,
              route: "base+tag",
              base,
              dest: baseRow.forward_to,
              result: "forwarded",
            };
            logEvent(entry);
            await persistLog(env, entry);
          } catch (err) {
            const entry = {
              ...msgMeta,
              route: "base+tag",
              base,
              dest: baseRow.forward_to,
              result: "error",
              error: String(err),
            };
            logEvent(entry);
            await persistLog(env, entry);
            await message.setReject("550 Destination not verified");
          }
          return;
        }
      }

      // 3️⃣ No match at all → reject
      {
        const entry = {
          ...msgMeta,
          route: "none",
          result: "rejected",
          error: "no matching alias or plus-base alias found",
        };
        logEvent(entry);
        await persistLog(env, entry);
        await message.setReject(
          `550 No such user at ${domain || "this domain"}`
        );
      }
    } catch (err) {
      // Last-resort error handler
      const entry = {
        ...msgMeta,
        route: "exception",
        result: "error",
        error: String(err),
      };
      logEvent(entry);
      await persistLog(env, entry);
      await message.setReject("550 Internal error");
    }
  },
};