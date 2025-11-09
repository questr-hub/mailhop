#!/usr/bin/env node

/**
 * Mailhop CLI
 * -----------
 * A small Node.js CLI for talking to the Mailhop API Worker.
 *
 * Features:
 * - List aliases
 * - Find aliases by destination
 * - Create / delete aliases
 * - Update alias settings (forward_to, allow_plus, notes)
 * - Inspect a single alias (pretty print)
 * - View recent email routing logs (colorized)
 *
 * Config via env:
 * - MAILHOP_API_URL   → base URL of your API (workers.dev or custom)
 * - MAILHOP_API_TOKEN → Bearer token (same as MAILHOP_API_KEY in CF)
 */

const API_URL = process.env.MAILHOP_API_URL || "http://localhost:8787";
const API_TOKEN = process.env.MAILHOP_API_TOKEN || null;

/**
 * Basic request helper to call the Mailhop API.
 * - Adds Content-Type JSON header.
 * - Adds Authorization header when MAILHOP_API_TOKEN is set.
 * - Throws on non-2xx responses with status + text body.
 */
async function request(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}),
    ...options.headers,
  };

  const res = await fetch(`${API_URL}${path}`, { ...options, headers });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }

  // API always returns JSON
  return res.json();
}

/**
 * Simple ANSI colors for nicer terminal output.
 * (No external deps; works in most modern terminals.)
 */
const COLORS = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  bold: "\x1b[1m",
};

/** Colorize a status/result string for quick visual scanning. */
function colorizeStatus(result) {
  const r = (result || "").toLowerCase();
  if (r.includes("forwarded") || r.includes("ok")) {
    return COLORS.green + result + COLORS.reset;
  }
  if (r.includes("rejected") || r.includes("skipped")) {
    return COLORS.yellow + result + COLORS.reset;
  }
  if (r.includes("error") || r.includes("failed")) {
    return COLORS.red + result + COLORS.reset;
  }
  return COLORS.cyan + result + COLORS.reset;
}

//
// ── Alias commands ─────────────────────────────────────────────────────────────
//

/**
 * List all aliases.
 * Uses GET /aliases.
 */
async function listAliases() {
  const aliases = await request("/aliases");

  if (!aliases.length) {
    console.log("No aliases found");
    return;
  }

  console.log("\nAliases:");
  console.log("─".repeat(80));
  for (const alias of aliases) {
    console.log(`${alias.address} → ${alias.forward_to}`);
    if (alias.notes) {
      console.log(`  Notes: ${alias.notes}`);
    }
    console.log(
      `  Allow + addressing: ${alias.allow_plus ? "✅ yes" : "❌ no"}`
    );
    if (alias.created_at) {
      console.log(
        `  Created: ${new Date(alias.created_at * 1000).toLocaleString()}`
      );
    }
    console.log();
  }
  console.log(`Total: ${aliases.length} alias(es)\n`);
}

/**
 * Find aliases that forward to a given destination.
 * Uses GET /aliases/by-destination?email=...
 */
async function findByDestination(email) {
  const aliases = await request(
    `/aliases/by-destination?email=${encodeURIComponent(email)}`
  );

  if (!aliases.length) {
    console.log(`No aliases found forwarding to ${email}`);
    return;
  }

  console.log(`\nAliases forwarding to ${email}:`);
  console.log("─".repeat(80));
  for (const alias of aliases) {
    console.log(`  ${alias.address} → ${alias.forward_to}`);
    if (alias.notes) {
      console.log(`    Notes: ${alias.notes}`);
    }
  }
  console.log(`\nTotal: ${aliases.length} alias(es)\n`);
}

/**
 * Inspect a single alias.
 * Uses GET /aliases/:address.
 */
async function inspectAlias(address) {
  const alias = await request(`/aliases/${encodeURIComponent(address)}`);

  console.log("\nAlias details:");
  console.log("─".repeat(60));
  console.log(`Address:       ${alias.address}`);
  console.log(`Forward to:    ${alias.forward_to}`);
  console.log(
    `Allow +:       ${alias.allow_plus ? "✅ yes (plus addresses route)" : "❌ no (plus disabled)"}`
  );
  console.log(
    `Created:       ${
      alias.created_at
        ? new Date(alias.created_at * 1000).toLocaleString()
        : "unknown"
    }`
  );
  console.log(`ID:            ${alias.id}`);
  if (alias.notes) {
    console.log(`Notes:         ${alias.notes}`);
  }
  console.log();
}

/**
 * Create a new alias.
 * Uses POST /aliases with body { address, forward_to, notes?, allow_plus? }.
 *
 * allowPlus is a boolean:
 * - true  → allow user+tag@... (plus addressing)
 * - false → only exact user@... accepted
 */
async function createAlias(address, forwardTo, notes, allowPlus) {
  await request("/aliases", {
    method: "POST",
    body: JSON.stringify({
      address,
      forward_to: forwardTo,
      notes,
      allow_plus: allowPlus,
    }),
  });

  console.log(
    `✓ Created alias: ${address} → ${forwardTo} (plus=${allowPlus ? "on" : "off"})`
  );
}

/**
 * Delete an alias by address.
 * Uses DELETE /aliases/:address.
 */
async function deleteAlias(address) {
  await request(`/aliases/${encodeURIComponent(address)}`, {
    method: "DELETE",
  });
  console.log(`✓ Deleted alias: ${address}`);
}

/**
 * Update an alias.
 * Uses PATCH /aliases/:address with any of:
 *   - forward_to
 *   - notes
 *   - allow_plus
 *
 * All parameters are optional; at least one must be provided.
 */
async function updateAlias(address, { forwardTo, notes, allowPlus }) {
  const payload = {};

  if (typeof forwardTo !== "undefined") {
    payload.forward_to = forwardTo;
  }
  if (typeof notes !== "undefined") {
    payload.notes = notes;
  }
  if (typeof allowPlus !== "undefined") {
    payload.allow_plus = allowPlus;
  }

  if (Object.keys(payload).length === 0) {
    throw new Error(
      "No fields to update. Use --forward-to=, --allow-plus=, or --notes="
    );
  }

  const res = await request(`/aliases/${encodeURIComponent(address)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });

  console.log("✓ Updated alias:");
  console.log(`  ${res.alias.address} → ${res.alias.forward_to}`);
  console.log(
    `  Allow + addressing: ${res.alias.allow_plus ? "✅ yes" : "❌ no"}`
  );
  if (res.alias.notes) {
    console.log(`  Notes: ${res.alias.notes}`);
  }
}

//
// ── Logs command ───────────────────────────────────────────────────────────────
//

/**
 * View recent email_logs entries.
 * Uses GET /logs/recent?limit=...
 * Output is colorized for status readability.
 */
async function viewLogs(limit = 50) {
  const logs = await request(`/logs/recent?limit=${limit}`);

  if (!logs.length) {
    console.log("No email logs found");
    return;
  }

  console.log(`\nRecent ${logs.length} email logs:`);
  console.log("─".repeat(100));

  for (const row of logs) {
    const ts = new Date(row.ts * 1000).toLocaleString();
    const result = colorizeStatus(row.result || "unknown");

    console.log(
      `${COLORS.dim}${ts}${COLORS.reset} | ${row.from_addr || "?"} → ${
        row.to_addr || "?"
      }`
    );
    console.log(`  ${COLORS.bold}${result}${COLORS.reset}`);

    if (row.dest_addr) {
      console.log(
        `  ${COLORS.cyan}Routed:${COLORS.reset} ${row.route || "-"} → ${
          row.dest_addr
        }`
      );
    }
    if (row.error) {
      console.log(`${COLORS.red}  Error:${COLORS.reset} ${row.error}`);
    }

    console.log();
  }
}

//
// ── Help / CLI wiring ─────────────────────────────────────────────────────────
//

/** Show CLI usage and flags. */
function showHelp() {
  console.log(`mailhop - manage Mailhop aliases and view mail logs

Usage:
  mailhop list
      List all aliases.

  mailhop find <email>
      Find aliases that forward to the given destination email.

  mailhop inspect <alias>
      Show details for a single alias (forward target, plus setting, notes).

  mailhop create <alias> <forward-to> [notes] [--no-plus]
      Create a new alias.
      By default, plus addressing is ENABLED (user+tag@... will route).
      Use --no-plus to disable plus addressing for this alias.

  mailhop update <alias> [--forward-to=<email>] [--allow-plus=true|false] [--notes=<text>]
      Update alias properties.
      Examples:
        mailhop update alias@example.com --allow-plus=false
        mailhop update alias@example.com --forward-to=new-destination@example.net
        mailhop update alias@example.com --notes="for github signups"

  mailhop delete <alias>
      Delete an alias.

  mailhop logs [limit]
      Show recent email routing logs (default limit = 50).

Environment:
  MAILHOP_API_URL     API base URL (default: http://localhost:8787)
  MAILHOP_API_TOKEN   Bearer token for authenticated API access
`);
}

/**
 * Very small arg parser for the update command flags:
 *   --forward-to=email
 *   --allow-plus=true|false
 *   --notes=some text
 */
function parseUpdateFlags(args) {
  const out = {
    forwardTo: undefined,
    allowPlus: undefined,
    notes: undefined,
  };

  for (const arg of args) {
    if (arg.startsWith("--forward-to=")) {
      out.forwardTo = arg.slice("--forward-to=".length);
    } else if (arg.startsWith("--allow-plus=")) {
      const val = arg.slice("--allow-plus=".length).toLowerCase();
      out.allowPlus =
        val === "true" || val === "1" || val === "yes" || val === "on";
    } else if (arg.startsWith("--notes=")) {
      out.notes = arg.slice("--notes=".length);
    }
  }

  return out;
}

/** CLI entry point. */
async function main() {
  const [, , cmd, ...args] = process.argv;

  try {
    switch (cmd) {
      case "list":
        await listAliases();
        break;

      case "find": {
        const email = args[0];
        if (!email) {
          throw new Error("Usage: mailhop find <email>");
        }
        await findByDestination(email);
        break;
      }

      case "inspect": {
        const address = args[0];
        if (!address) {
          throw new Error("Usage: mailhop inspect <alias>");
        }
        await inspectAlias(address);
        break;
      }

      case "create": {
        const [address, forwardTo, notes, ...rest] = args;
        if (!address || !forwardTo) {
          throw new Error(
            "Usage: mailhop create <alias> <forward-to> [notes] [--no-plus]"
          );
        }
        // By default allow plus addressing unless explicitly disabled
        const allowPlus = !rest.includes("--no-plus");
        await createAlias(address, forwardTo, notes, allowPlus);
        break;
      }

      case "update": {
        const address = args[0];
        if (!address) {
          throw new Error(
            "Usage: mailhop update <alias> [--forward-to=<email>] [--allow-plus=true|false] [--notes=<text>]"
          );
        }
        const flags = parseUpdateFlags(args.slice(1));
        await updateAlias(address, flags);
        break;
      }

      case "delete": {
        const address = args[0];
        if (!address) {
          throw new Error("Usage: mailhop delete <alias>");
        }
        await deleteAlias(address);
        break;
      }

      case "logs": {
        const limit = args[0] ? parseInt(args[0], 10) : 50;
        await viewLogs(limit);
        break;
      }

      case "help":
      case "--help":
      case "-h":
      default:
        showHelp();
        break;
    }
  } catch (err) {
    console.error(COLORS.red + "Error:" + COLORS.reset, err.message);
    process.exit(1);
  }
}

main();