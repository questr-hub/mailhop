#!/usr/bin/env node

/**
 * Mailhop CLI
 * ===========
 * This CLI talks to the Mailhop API (Cloudflare Worker) and also provides
 * some developer helpers for working with the Workers themselves.
 *
 * Commands:
 *   list             → List all aliases
 *   find             → Find aliases by destination email
 *   create           → Create a new alias
 *   delete           → Delete an alias
 *   inspect          → Show details for a single alias
 *   update           → Update forward_to / notes / allow_plus
 *   logs             → Show recent email routing logs
 *   preflight        → Check local Worker configs (API + email)
 *   deploy-all       → Deploy both Workers via wrangler
 *
 * This file is an ES module because package.json has `"type": "module"`,
 * so we use `import` instead of `require`.
 */

/**
 * ────────────────────────────────────────────────────────────────
 * Configuration: env vars
 * ────────────────────────────────────────────────────────────────
 *
 * These come from your shell environment, not from any config file:
 *
 *   MAILHOP_API_URL
 *     - Base URL of the Mailhop API Worker.
 *     - Defaults to "http://localhost:8787" for local dev.
 *
 *   MAILHOP_API_TOKEN
 *     - Optional Bearer token sent as:
 *         Authorization: Bearer <MAILHOP_API_TOKEN>
 *     - Must match MAILHOP_API_KEY secret stored in the Worker (if used).
 *
 *   MAILHOP_ROOT
 *     - Used only by dev helpers (preflight / deploy-all).
 *     - Should point at your project root which contains "workers/".
 *     - Defaults to process.cwd() (current working directory).
 */

const API_URL = process.env.MAILHOP_API_URL || "http://localhost:8787";
const API_TOKEN = process.env.MAILHOP_API_TOKEN || "";
const MAILHOP_ROOT = process.env.MAILHOP_ROOT || process.cwd();

/**
 * Built-in Node modules used:
 *  - child_process.exec: to run wrangler commands in preflight/deploy-all
 *  - fs/promises: to check for and read wrangler.local.jsonc files
 *  - path: to build cross-platform paths for workers/api and workers/email
 */

import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

// Promisified exec so we can `await` shell commands.
const exec = promisify(execCallback);

/**
 * ────────────────────────────────────────────────────────────────
 * Low-level helpers
 * ────────────────────────────────────────────────────────────────
 */

/**
 * Perform an HTTP request against the Mailhop API.
 * - Uses global fetch (available in Node 18+).
 * - Adds JSON headers and Authorization if MAILHOP_API_TOKEN is set.
 * - Throws a friendly Error if the response is not OK.
 */
async function request(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };

  if (API_TOKEN) {
    headers["Authorization"] = `Bearer ${API_TOKEN}`;
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    // Try to extract a structured JSON error, fall back to raw text.
    let detail = "";
    try {
      const body = await response.json();
      detail = body.error || JSON.stringify(body);
    } catch {
      detail = await response.text();
    }

    throw new Error(
      `API error: ${response.status} ${response.statusText}${
        detail ? ` - ${detail}` : ""
      }`
    );
  }

  return response.json();
}

/**
 * Run a shell command.
 * - Used only for wrangler in preflight/deploy-all.
 * - Prints the command being run.
 * - Streams stdout/stderr to the user.
 * - Throws on non-zero exit.
 */
async function runShellCommand(cmd, options = {}) {
  console.log(`\n$ ${cmd}`);
  try {
    const { stdout, stderr } = await exec(cmd, {
      ...options,
      shell: true, // allows "cd ... && wrangler ..." style commands
    });

    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  } catch (err) {
    if (err.stdout) process.stdout.write(err.stdout);
    if (err.stderr) process.stderr.write(err.stderr);
    throw new Error(`Command failed: ${cmd}`);
  }
}

/**
 * ────────────────────────────────────────────────────────────────
 * API-level commands (aliases, logs, etc.)
 * ────────────────────────────────────────────────────────────────
 */

/** List all aliases currently stored in the API. */
async function listAliases() {
  const aliases = await request("/aliases");

  if (!aliases || aliases.length === 0) {
    console.log("No aliases found");
    return;
  }

  console.log("\nAliases:");
  console.log("─".repeat(80));

  for (const alias of aliases) {
    const date = alias.created_at
      ? new Date(alias.created_at * 1000)
      : null;

    console.log(`${alias.address} → ${alias.forward_to}`);
    if (alias.notes) {
      console.log(`  Notes: ${alias.notes}`);
    }
    console.log(`  allow_plus: ${alias.allow_plus ? "true" : "false"}`);
    if (date) {
      console.log(`  Created: ${date.toLocaleString()}`);
    }
    console.log();
  }

  console.log(`Total: ${aliases.length} aliases`);
}

/** Find aliases that forward to a given destination address. */
async function findByDestination(email) {
  const aliases = await request(
    `/aliases/by-destination?email=${encodeURIComponent(email)}`
  );

  if (!aliases || aliases.length === 0) {
    console.log(`No aliases found forwarding to ${email}`);
    return;
  }

  console.log(`\nAliases forwarding to ${email}:`);
  console.log("─".repeat(80));

  for (const alias of aliases) {
    console.log(`  ${alias.address}`);
    if (alias.notes) {
      console.log(`    Notes: ${alias.notes}`);
    }
  }

  console.log(`\nTotal: ${aliases.length} aliases`);
}

/** Create a new alias row in the API. */
async function createAlias(address, forwardTo, notes) {
  await request("/aliases", {
    method: "POST",
    body: JSON.stringify({
      address,
      forward_to: forwardTo,
      notes: notes || undefined,
      // allow_plus omitted → API will use default (usually 1/true).
    }),
  });

  console.log(`✓ Created alias: ${address} → ${forwardTo}`);
}

/** Delete an alias by its address. */
async function deleteAlias(address) {
  await request(`/aliases/${encodeURIComponent(address)}`, {
    method: "DELETE",
  });

  console.log(`✓ Deleted alias: ${address}`);
}

/** Show detailed information for a single alias. */
async function inspectAlias(address) {
  const alias = await request(`/aliases/${encodeURIComponent(address)}`);

  if (!alias || !alias.address) {
    console.log(`Alias not found: ${address}`);
    return;
  }

  const date = alias.created_at
    ? new Date(alias.created_at * 1000)
    : null;

  console.log(`\nAlias: ${alias.address}`);
  console.log("─".repeat(80));
  console.log(`Forward to: ${alias.forward_to}`);
  console.log(`allow_plus: ${alias.allow_plus ? "true" : "false"}`);
  if (alias.notes) {
    console.log(`Notes: ${alias.notes}`);
  }
  if (date) {
    console.log(`Created: ${date.toLocaleString()}`);
  }
}

/**
 * Update an alias.
 * Supports flag-style arguments:
 *   --forward-to=<email>
 *   --allow-plus=<true|false|1|0>
 *   --notes=<text>
 */
async function updateAlias(address, flagArgs) {
  const payload = {};

  for (const arg of flagArgs) {
    if (arg.startsWith("--forward-to=")) {
      payload.forward_to = arg.slice("--forward-to=".length);
    } else if (arg.startsWith("--allow-plus=")) {
      const val = arg.slice("--allow-plus=".length).toLowerCase();
      payload.allow_plus = ["true", "1", "yes", "y"].includes(val) ? 1 : 0;
    } else if (arg.startsWith("--notes=")) {
      payload.notes = arg.slice("--notes=".length);
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  if (Object.keys(payload).length === 0) {
    throw new Error(
      "No fields to update. Use one or more of: --forward-to=, --allow-plus=, --notes="
    );
  }

  await request(`/aliases/${encodeURIComponent(address)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });

  console.log(`✓ Updated alias: ${address}`);
}

/**
 * Fetch and print recent email_logs entries.
 * Uses GET /logs?limit=N from the API.
 */
async function showLogs(limitArg) {
  const limit = Number.parseInt(limitArg || "20", 10);
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 20;
  const logs = await request(`/logs?limit=${safeLimit}`);

  if (!logs || logs.length === 0) {
    console.log("No email logs found");
    return;
  }

  for (const entry of logs) {
    const ts = entry.ts ? new Date(entry.ts * 1000) : null;
    const when = ts ? ts.toLocaleString() : "(no time)";
    console.log(
      `${when} | ${entry.from_addr || "unknown"} → ${
        entry.to_addr || "unknown"
      }`
    );
    console.log(`  result: ${entry.result || "unknown"}`);
    if (entry.route || entry.dest_addr || entry.base_addr) {
      console.log(
        `  route: ${entry.route || "-"}${
          entry.base_addr ? ` (base: ${entry.base_addr})` : ""
        }`
      );
      if (entry.dest_addr) {
        console.log(`  dest:  ${entry.dest_addr}`);
      }
    }
    if (entry.error) {
      console.log(`  error: ${entry.error}`);
    }
    console.log();
  }

  console.log(`Total: ${logs.length} log entries`);
}

/**
 * ────────────────────────────────────────────────────────────────
 * Developer helpers: preflight / deploy-all
 * ────────────────────────────────────────────────────────────────
 *
 * These assume a Mailhop project layout like:
 *
 *   MAILHOP_ROOT/
 *     workers/
 *       api/
 *         wrangler.local.jsonc
 *       email/
 *         wrangler.local.jsonc
 *
 * MAILHOP_ROOT defaults to the current working directory, but you can
 * override it in your shell:
 *
 *   export MAILHOP_ROOT=~/proj/mailhop
 */

/**
 * preflight()
 * -----------
 * For each worker (api/email):
 *  - checks that wrangler.local.jsonc exists
 *  - prints any detected D1 database_id
 *  - prints DOMAIN value if present
 */
async function preflight() {
  console.log("🧪 Mailhop preflight check\n");
  console.log(`Project root: ${MAILHOP_ROOT}\n`);

  const workers = ["api", "email"];

  for (const svc of workers) {
    const cfgPath = path.join(
      MAILHOP_ROOT,
      "workers",
      svc,
      "wrangler.local.jsonc"
    );

    console.log(`🔍 Checking ${svc} worker config…`);

    try {
      await fs.access(cfgPath);
    } catch {
      console.log(`  ❌ Missing config file: ${cfgPath}\n`);
      continue;
    }

    const content = await fs.readFile(cfgPath, "utf8");

    const dbMatch = content.match(
      /"database_id"\s*:\s*"([a-f0-9-]+)"/i
    );
    const domainMatch = content.match(
      /"DOMAIN"\s*:\s*"([^"]+)"/
    );

    console.log(`  ✅ Found: ${cfgPath}`);
    console.log(
      `  🗄️  D1 database id: ${dbMatch ? dbMatch[1] : "MISSING"}`
    );
    console.log(
      `  🌐 DOMAIN: ${domainMatch ? domainMatch[1] : "not set"}`
    );
    console.log();
  }

  console.log(
    "✅ Preflight complete. Fix any missing configs or values before deploying."
  );
}

/**
 * deployAll()
 * -----------
 * Deploys both API and Email workers using their local wrangler.local.jsonc:
 *
 *   cd workers/api   && wrangler deploy --config wrangler.local.jsonc
 *   cd workers/email && wrangler deploy --config wrangler.local.jsonc
 *
 * This function NEVER touches secrets; it just runs wrangler with your
 * existing local configuration.
 */
async function deployAll() {
  console.log("🚀 Deploying Mailhop workers…");

  const apiDir = path.join(MAILHOP_ROOT, "workers", "api");
  const emailDir = path.join(MAILHOP_ROOT, "workers", "email");

  // Deploy API worker
  await runShellCommand(
    `cd "${apiDir}" && wrangler deploy --config wrangler.local.jsonc`
  );

  // Deploy Email worker
  await runShellCommand(
    `cd "${emailDir}" && wrangler deploy --config wrangler.local.jsonc`
  );

  console.log("\n🎉 All workers deployed successfully.");
}

/**
 * ────────────────────────────────────────────────────────────────
 * Help text and CLI entrypoint
 * ────────────────────────────────────────────────────────────────
 */

/** Print usage info and list all available commands. */
function showHelp() {
  console.log("mailhop - Email alias management + developer helpers\n");
  console.log("Usage:");
  console.log("  mailhop list");
  console.log("      List all aliases");
  console.log();
  console.log("  mailhop find <email>");
  console.log("      Find aliases by destination (forward_to)");
  console.log();
  console.log("  mailhop create <alias> <forward-to> [notes]");
  console.log("      Create a new alias");
  console.log();
  console.log("  mailhop delete <alias>");
  console.log("      Delete an alias");
  console.log();
  console.log("  mailhop inspect <alias>");
  console.log("      Show full details for a single alias");
  console.log();
  console.log("  mailhop update <alias> [--forward-to=] [--allow-plus=] [--notes=]");
  console.log("      Update alias fields. Examples:");
  console.log("        mailhop update hello@example.com --allow-plus=false");
  console.log("        mailhop update hello@example.com --forward-to=me@inbox.example.net");
  console.log('        mailhop update hello@example.com --notes="for signups"');
  console.log();
  console.log("  mailhop logs [limit]");
  console.log("      Show recent email routing log entries (default: 20)");
  console.log();
  console.log("  mailhop preflight");
  console.log("      Check local worker configs under MAILHOP_ROOT (or current dir).");
  console.log();
  console.log("  mailhop deploy-all");
  console.log("      Deploy both API and Email workers via wrangler using wrangler.local.jsonc.");
  console.log();
  console.log("Environment variables:");
  console.log(`  MAILHOP_API_URL     API base URL (default: ${API_URL})`);
  console.log("  MAILHOP_API_TOKEN   API Bearer token (must match Worker MAILHOP_API_KEY, if set)");
  console.log(`  MAILHOP_ROOT        Project root for preflight/deploy-all (default: ${MAILHOP_ROOT})`);
}

/**
 * Main entrypoint:
 * - Parses process.argv to determine the command.
 * - Dispatches to the appropriate handler.
 * - Catches and prints errors in a friendly way.
 */
async function main() {
  const [, , command, ...args] = process.argv;

  try {
    switch (command) {
      case "list":
        await listAliases();
        break;

      case "find":
        if (!args[0]) {
          throw new Error("Usage: mailhop find <email-address>");
        }
        await findByDestination(args[0]);
        break;

      case "create":
        if (!args[0] || !args[1]) {
          throw new Error("Usage: mailhop create <alias> <forward-to> [notes]");
        }
        await createAlias(args[0], args[1], args[2]);
        break;

      case "delete":
        if (!args[0]) {
          throw new Error("Usage: mailhop delete <alias>");
        }
        await deleteAlias(args[0]);
        break;

      case "inspect":
        if (!args[0]) {
          throw new Error("Usage: mailhop inspect <alias>");
        }
        await inspectAlias(args[0]);
        break;

      case "update":
        if (!args[0]) {
          throw new Error(
            "Usage: mailhop update <alias> [--forward-to=] [--allow-plus=] [--notes=]"
          );
        }
        await updateAlias(args[0], args.slice(1));
        break;

      case "logs":
        await showLogs(args[0]);
        break;

      case "preflight":
        await preflight();
        break;

      case "deploy-all":
        await deployAll();
        break;

      case "help":
      case "--help":
      case "-h":
      case undefined:
        showHelp();
        break;

      default:
        showHelp();
        throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    console.error("\nError:", error.message);
    process.exit(1);
  }
}

// Run the CLI.
main();