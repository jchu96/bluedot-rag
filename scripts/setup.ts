#!/usr/bin/env node
/**
 * Interactive setup for bluedot-rag.
 *
 * Provisions the Cloudflare resources (D1, Vectorize) idempotently and
 * creates the Notion databases (Followups + Call Transcripts) in the
 * user's workspace. Writes secrets to .dev.vars and binding IDs to
 * wrangler.toml.
 *
 * Run: npm run setup
 */

import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

const D1_DB_NAME = "bluedot-rag-db";
const VECTORIZE_INDEX_NAME = "bluedot-rag-vectors";
const VECTORIZE_DIMENSIONS = 1536;
const VECTORIZE_METRIC = "cosine";

const rl = readline.createInterface({ input: stdin, output: stdout });

function header(text: string) {
  console.log(`\n\x1b[1m\x1b[36m${text}\x1b[0m`);
  console.log("=".repeat(text.length));
}

function ok(text: string) {
  console.log(`  \x1b[32m✓\x1b[0m ${text}`);
}

function info(text: string) {
  console.log(`    ${text}`);
}

function warn(text: string) {
  console.log(`  \x1b[33m⚠\x1b[0m ${text}`);
}

function fail(text: string): never {
  console.error(`  \x1b[31m✗\x1b[0m ${text}`);
  process.exit(1);
}

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(cmd: string, args: string[], input?: string): CliResult {
  const result = spawnSync(cmd, args, { encoding: "utf8", input });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/**
 * Push a secret to the deployed Worker by piping the value through stdin to
 * `wrangler secret put NAME`. Wrangler prompts interactively when stdin is a
 * TTY; we avoid the prompt by passing the value via stdin directly.
 */
function putSecret(name: string, value: string): CliResult {
  return runCli("npx", ["wrangler", "secret", "put", name], value);
}

/**
 * Parse `.dev.vars` into a map so later steps can offer to reuse previously-
 * entered values (KEY="value" or KEY=value, shell-ish). Non-existent file → {}.
 */
async function loadDevVars(): Promise<Record<string, string>> {
  if (!existsSync(".dev.vars")) return {};
  const raw = await readFile(".dev.vars", "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^([A-Z0-9_]+)\s*=\s*"?([^"]*)"?$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/** Mask a secret for display: first 4 + "…" + last 4. */
function mask(value: string): string {
  if (!value) return "";
  if (value.length <= 10) return "•".repeat(value.length);
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/**
 * Prompt for a value, offering to reuse an existing one if present.
 * User presses Enter to reuse; types anything else to override.
 */
async function promptReuse(
  label: string,
  existing: string | undefined,
  required = true,
): Promise<string> {
  if (existing) {
    const ans = (
      await rl.question(`  ${label} [reuse \x1b[90m${mask(existing)}\x1b[0m] — Enter to keep, or paste new: `)
    ).trim();
    if (!ans) return existing;
    return ans;
  }
  const ans = (await rl.question(`  ${label}: `)).trim();
  if (!ans && required) fail(`${label} is required`);
  return ans;
}

/** Cross-platform open-in-browser. Non-fatal if it fails. */
function openUrl(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  const r = runCli(cmd, [url]);
  if (r.status !== 0) {
    info(`(Couldn't open browser automatically — visit ${url} manually.)`);
  }
}

/**
 * Read the current Notion data source IDs from wrangler.toml so we can offer
 * to reuse existing Notion DBs across re-runs (avoids duplicate DB creation).
 */
async function readTomlVars(): Promise<Record<string, string>> {
  if (!existsSync("wrangler.toml")) return {};
  const raw = await readFile("wrangler.toml", "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"([^"]*)"/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

async function step1_checkWranglerAuth(): Promise<void> {
  header("[1/10] Checking wrangler authentication");
  const r = runCli("npx", ["wrangler", "whoami"]);
  if (r.status !== 0) {
    fail(
      "Not logged in. Run `npx wrangler login` then re-run setup.\n" +
        `wrangler said: ${r.stderr || r.stdout}`,
    );
  }
  const emailMatch = r.stdout.match(/email\s+([^\s]+)/i);
  ok(`Logged in${emailMatch ? ` as ${emailMatch[1]}` : ""}`);
}

async function step2_provisionD1(): Promise<string> {
  header("[2/10] Provisioning Cloudflare D1");
  const list = runCli("npx", ["wrangler", "d1", "list", "--json"]);
  if (list.status !== 0) fail(`Failed to list D1 databases: ${list.stderr || list.stdout}`);

  let dbs: Array<{ name: string; uuid: string }> = [];
  try {
    dbs = JSON.parse(list.stdout);
  } catch {
    fail(`Could not parse \`wrangler d1 list --json\` output`);
  }

  const existing = dbs.find((d) => d.name === D1_DB_NAME);
  if (existing) {
    ok(`Using existing D1 database \`${D1_DB_NAME}\` (id: ${existing.uuid})`);
    return existing.uuid;
  }

  info(`Creating D1 database \`${D1_DB_NAME}\`...`);
  const create = runCli("npx", ["wrangler", "d1", "create", D1_DB_NAME]);
  if (create.status !== 0) fail(`Failed to create D1: ${create.stderr || create.stdout}`);

  const idMatch = create.stdout.match(/database_id\s*=\s*"([0-9a-f-]+)"/);
  if (!idMatch) fail(`Could not parse database_id from create output`);
  ok(`Created D1 database (id: ${idMatch[1]})`);
  return idMatch[1];
}

async function step3_provisionVectorize(): Promise<void> {
  header("[3/10] Provisioning Cloudflare Vectorize");
  const list = runCli("npx", ["wrangler", "vectorize", "list", "--json"]);
  if (list.status !== 0) fail(`Failed to list Vectorize indexes: ${list.stderr || list.stdout}`);

  let indexes: Array<{ name: string }> = [];
  try {
    indexes = JSON.parse(list.stdout);
  } catch {
    fail(`Could not parse \`wrangler vectorize list --json\` output`);
  }

  if (indexes.find((i) => i.name === VECTORIZE_INDEX_NAME)) {
    ok(`Using existing Vectorize index \`${VECTORIZE_INDEX_NAME}\``);
    return;
  }

  info(`Creating Vectorize index \`${VECTORIZE_INDEX_NAME}\`...`);
  const create = runCli("npx", [
    "wrangler",
    "vectorize",
    "create",
    VECTORIZE_INDEX_NAME,
    `--dimensions=${VECTORIZE_DIMENSIONS}`,
    `--metric=${VECTORIZE_METRIC}`,
  ]);
  if (create.status !== 0) fail(`Failed to create Vectorize: ${create.stderr || create.stdout}`);
  ok(`Created Vectorize index (${VECTORIZE_DIMENSIONS}d, ${VECTORIZE_METRIC})`);
}

async function step4_writeWranglerTomlAndMigrate(d1Id: string): Promise<void> {
  header("[4/10] Updating wrangler.toml + applying database migration");

  let toml = await readFile("wrangler.toml", "utf8");

  // Replace D1 database_id and database_name
  toml = toml.replace(
    /(\[\[d1_databases\]\][\s\S]*?)database_name\s*=\s*"[^"]*"/,
    `$1database_name = "${D1_DB_NAME}"`,
  );
  toml = toml.replace(
    /(\[\[d1_databases\]\][\s\S]*?)database_id\s*=\s*"[^"]*"/,
    `$1database_id = "${d1Id}"`,
  );

  // Replace Vectorize index_name
  toml = toml.replace(
    /(\[\[vectorize\]\][\s\S]*?)index_name\s*=\s*"[^"]*"/,
    `$1index_name = "${VECTORIZE_INDEX_NAME}"`,
  );

  await writeFile("wrangler.toml", toml, "utf8");
  ok(`Wrote D1 + Vectorize bindings to wrangler.toml`);

  info(`Applying migrations to ${D1_DB_NAME}...`);
  const migrate = runCli("npx", [
    "wrangler",
    "d1",
    "migrations",
    "apply",
    D1_DB_NAME,
    "--remote",
  ]);
  if (migrate.status !== 0) {
    fail(`Migration failed: ${migrate.stderr || migrate.stdout}`);
  }
  ok(`Migrations applied`);
}

async function step5_setupNotion(
  existing: {
    notionToken?: string;
    transcriptsDataSourceId?: string;
    followupsDataSourceId?: string;
  },
): Promise<{
  token: string;
  transcriptsDbId: string;
  followupsDbId: string;
  transcriptsDataSourceId: string;
  followupsDataSourceId: string;
}> {
  header("[5/10] Notion setup");

  // If both data source IDs are already configured, offer to reuse the existing DBs.
  if (
    existing.transcriptsDataSourceId &&
    existing.followupsDataSourceId &&
    !existing.transcriptsDataSourceId.startsWith("test-") &&
    !existing.followupsDataSourceId.startsWith("test-")
  ) {
    info(`Detected existing Notion databases in wrangler.toml:`);
    info(`  Followups data source:   ${existing.followupsDataSourceId}`);
    info(`  Transcripts data source: ${existing.transcriptsDataSourceId}`);
    const ans = (
      await rl.question("  Reuse these, or create fresh ones? [reuse/new]: ")
    )
      .trim()
      .toLowerCase();
    if (ans === "" || ans === "reuse" || ans === "r" || ans === "y") {
      const token = await promptReuse(
        "Notion integration token (needed for writing to the existing DBs)",
        existing.notionToken,
      );
      ok(`Reusing existing databases — skipping Notion DB creation`);
      return {
        token,
        transcriptsDbId: "",
        followupsDbId: "",
        transcriptsDataSourceId: existing.transcriptsDataSourceId,
        followupsDataSourceId: existing.followupsDataSourceId,
      };
    }
  }

  info("You'll need:");
  info("  - A Notion integration token (https://www.notion.so/profile/integrations)");
  info("  - A parent page ID (the page where the new databases will live)");
  info("  - The integration must be SHARED with that page (Add Connections in page menu)");

  const openIntegrations = (
    await rl.question("\n  Open Notion integrations page in browser? (y/N): ")
  )
    .trim()
    .toLowerCase();
  if (openIntegrations === "y" || openIntegrations === "yes") {
    openUrl("https://www.notion.so/profile/integrations");
  }

  const token = await promptReuse(
    "Notion integration token",
    existing.notionToken,
  );
  const parent = (await rl.question("  Parent page ID (UUID with or without dashes): ")).trim();
  if (!parent) fail("Parent page ID is required");

  const parentId = normalizeUuid(parent);

  const followups = await createNotionDatabase(token, parentId, "Followups", {
    Name: { title: {} },
    Status: {
      select: {
        options: [
          { name: "Inbox", color: "yellow" },
          { name: "Triaged", color: "blue" },
          { name: "Doing", color: "purple" },
          { name: "Waiting", color: "orange" },
          { name: "Done", color: "green" },
        ],
      },
    },
    Priority: {
      select: {
        options: [
          { name: "P0", color: "red" },
          { name: "P1", color: "orange" },
          { name: "P2", color: "default" },
        ],
      },
    },
    Due: { date: {} },
    Owner: { rich_text: {} },
    Source: {
      select: {
        options: [
          { name: "Bluedot", color: "blue" },
          { name: "Manual", color: "default" },
        ],
      },
    },
    "Source Link": { url: {} },
    "Meeting Title": { rich_text: {} },
    "Video ID": { rich_text: {} },
  });
  ok(`Created Followups database`);

  const transcripts = await createNotionDatabase(token, parentId, "Call Transcripts", {
    Name: { title: {} },
    Date: { date: {} },
    Participants: { multi_select: { options: [] } },
    Summary: { rich_text: {} },
    "Action Items": { rich_text: {} },
    "Video ID": { rich_text: {} },
    Language: { rich_text: {} },
  });
  ok(`Created Call Transcripts database`);

  return {
    token,
    transcriptsDbId: transcripts.databaseId,
    followupsDbId: followups.databaseId,
    transcriptsDataSourceId: transcripts.dataSourceId,
    followupsDataSourceId: followups.dataSourceId,
  };
}

function normalizeUuid(input: string): string {
  const clean = input.replace(/-/g, "");
  if (clean.length !== 32) fail(`UUID must be 32 hex chars (got ${clean.length})`);
  return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-${clean.slice(12, 16)}-${clean.slice(16, 20)}-${clean.slice(20, 32)}`;
}

async function createNotionDatabase(
  token: string,
  parentId: string,
  title: string,
  properties: Record<string, unknown>,
): Promise<{ databaseId: string; dataSourceId: string }> {
  // Create with default title-only properties first
  const create = await fetch("https://api.notion.com/v1/databases", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2025-09-03",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { type: "page_id", page_id: parentId },
      title: [{ type: "text", text: { content: title } }],
    }),
  });
  if (!create.ok) {
    const text = await create.text();
    if (create.status === 401 || create.status === 404) {
      fail(
        `Notion ${create.status}: parent page not shared with integration.\n` +
          `Open the parent page in Notion → ⋯ menu → "Add Connections" → select your integration.\n` +
          `Body: ${text}`,
      );
    }
    fail(`Notion create database failed (${create.status}): ${text}`);
  }
  const dbResp = (await create.json()) as {
    id: string;
    data_sources?: Array<{ id: string }>;
  };
  const databaseId = dbResp.id;
  const dataSourceId = dbResp.data_sources?.[0]?.id;
  if (!dataSourceId) fail(`No data source on newly created database ${title}`);

  // Update data source to add the schema
  const update = await fetch(`https://api.notion.com/v1/data_sources/${dataSourceId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": "2025-09-03",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ properties }),
  });
  if (!update.ok) {
    const text = await update.text();
    fail(`Notion update data source failed (${update.status}): ${text}`);
  }

  return { databaseId, dataSourceId };
}

async function step6_openaiKey(existing?: string): Promise<string> {
  header("[6/10] OpenAI API key");
  const key = await promptReuse("OpenAI API key (sk-...)", existing);
  if (!key.startsWith("sk-")) fail(`Key must start with sk-`);

  // Validate via models.list (cheap, ~1 KB response)
  info("Validating key against /v1/models...");
  const resp = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!resp.ok) {
    const text = await resp.text();
    fail(`OpenAI rejected the key (${resp.status}): ${text.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { data: Array<{ id: string }> };
  const hasModel = data.data.some((m) => m.id === "gpt-4.1-nano");
  if (!hasModel) {
    warn(
      `gpt-4.1-nano not present in your account's available models — defaulting will fail. ` +
        `Set OPENAI_EXTRACTION_MODEL after setup to a model you have access to.`,
    );
  } else {
    ok(`Key valid; gpt-4.1-nano available`);
  }
  return key;
}

async function step8_setupMcpOAuth(
  existing: {
    githubClientId?: string;
    githubClientSecret?: string;
    allowedUsers?: string;
  },
): Promise<{
  kvNamespaceId: string;
  allowedUsers: string;
  githubClientId: string;
  githubClientSecret: string;
} | null> {
  header("[8/10] Setting up MCP OAuth (GitHub)");

  const enableAnswer = (
    await rl.question(
      "  Enable MCP server with GitHub OAuth? Needed for querying calls from Claude.ai (Y/n): ",
    )
  )
    .trim()
    .toLowerCase();
  if (enableAnswer === "n" || enableAnswer === "no") {
    warn("Skipping MCP setup. You can re-run this script later to add it.");
    return null;
  }

  // KV namespace for OAuth state + tokens.
  info("Looking for existing OAUTH_KV namespace...");
  const listKv = runCli("npx", ["wrangler", "kv", "namespace", "list"]);
  let kvId = "";
  try {
    const parsed = JSON.parse(listKv.stdout) as Array<{ id: string; title: string }>;
    const match = parsed.find((n) => n.title === "OAUTH_KV");
    if (match) {
      kvId = match.id;
      ok(`Using existing OAUTH_KV namespace (id ${kvId})`);
    }
  } catch {
    // fallthrough to create
  }
  if (!kvId) {
    info("Creating OAUTH_KV namespace...");
    const create = runCli("npx", [
      "wrangler",
      "kv",
      "namespace",
      "create",
      "OAUTH_KV",
    ]);
    const m = create.stdout.match(/id\s*=\s*"([0-9a-f]+)"/i);
    if (!m) {
      fail(
        `Could not parse namespace id from wrangler output:\n${create.stdout}\n${create.stderr}`,
      );
    }
    kvId = m[1];
    ok(`Created OAUTH_KV namespace (id ${kvId})`);
  }

  // GitHub OAuth app walkthrough
  const hasExistingCreds = !!(existing.githubClientId && existing.githubClientSecret);
  if (!hasExistingCreds) {
    console.log("");
    console.log("  You'll need a GitHub OAuth App. If you don't have one:");
    console.log("    1. Go to https://github.com/settings/developers");
    console.log("    2. Click \"New OAuth App\"");
    console.log("    3. Application name: something like `bluedot-rag MCP`");
    console.log(
      "    4. Homepage URL: your worker URL (e.g. `https://bluedot-rag.<account>.workers.dev`)",
    );
    console.log(
      "    5. Authorization callback URL: the same worker URL + `/auth/github/callback`",
    );
    console.log("    6. Generate a client secret and copy both values.");
    console.log("");

    const openAns = (
      await rl.question(
        "  Open https://github.com/settings/developers in browser now? (Y/n): ",
      )
    )
      .trim()
      .toLowerCase();
    if (openAns !== "n" && openAns !== "no") {
      openUrl("https://github.com/settings/developers");
      info("Create the OAuth App, then come back here to paste the values.");
    }
  }

  const githubClientId = await promptReuse(
    "GitHub OAuth App — Client ID",
    existing.githubClientId,
  );
  const githubClientSecret = await promptReuse(
    "GitHub OAuth App — Client Secret",
    existing.githubClientSecret,
  );
  const allowedUsers = await promptReuse(
    "Allowed GitHub usernames (comma-separated; case-insensitive)",
    existing.allowedUsers,
  );

  return {
    kvNamespaceId: kvId,
    allowedUsers,
    githubClientId,
    githubClientSecret,
  };
}

async function step7_writeConfig(input: {
  d1Id: string;
  notionToken: string;
  openaiKey: string;
  transcriptsDataSourceId: string;
  followupsDataSourceId: string;
  mcp?: {
    kvNamespaceId: string;
    allowedUsers: string;
    githubClientId: string;
    githubClientSecret: string;
  } | null;
}): Promise<void> {
  header("[7/10] Writing config");

  // .dev.vars
  const devVarsLines = [
    `OPENAI_API_KEY="${input.openaiKey}"`,
    `NOTION_INTEGRATION_KEY="${input.notionToken}"`,
    `BLUEDOT_WEBHOOK_SECRET="whsec_set_after_bluedot_config"`,
  ];
  if (input.mcp) {
    devVarsLines.push(
      `GITHUB_CLIENT_ID="${input.mcp.githubClientId}"`,
      `GITHUB_CLIENT_SECRET="${input.mcp.githubClientSecret}"`,
    );
  }
  const devVars = devVarsLines.join("\n") + "\n";
  await writeFile(".dev.vars", devVars, "utf8");
  ok(`Wrote .dev.vars`);

  // Update wrangler.toml [vars] for the Notion data source IDs
  let toml = await readFile("wrangler.toml", "utf8");
  toml = toml.replace(
    /NOTION_TRANSCRIPTS_DATA_SOURCE_ID\s*=\s*"[^"]*"/,
    `NOTION_TRANSCRIPTS_DATA_SOURCE_ID = "${input.transcriptsDataSourceId}"`,
  );
  toml = toml.replace(
    /NOTION_FOLLOWUPS_DATA_SOURCE_ID\s*=\s*"[^"]*"/,
    `NOTION_FOLLOWUPS_DATA_SOURCE_ID = "${input.followupsDataSourceId}"`,
  );

  if (input.mcp) {
    // Set ALLOWED_USERS in [vars]
    if (/ALLOWED_USERS\s*=\s*"[^"]*"/.test(toml)) {
      toml = toml.replace(
        /ALLOWED_USERS\s*=\s*"[^"]*"/,
        `ALLOWED_USERS = "${input.mcp.allowedUsers}"`,
      );
    } else {
      toml = toml.replace(
        /(\[vars\][^\[]*?)(\n\[)/,
        `$1ALLOWED_USERS = "${input.mcp.allowedUsers}"\n$2`,
      );
    }

    // Set KV binding id
    const kvBinding = `[[kv_namespaces]]\nbinding = "OAUTH_KV"\nid = "${input.mcp.kvNamespaceId}"\n`;
    if (/\[\[kv_namespaces\]\]/.test(toml)) {
      toml = toml.replace(
        /\[\[kv_namespaces\]\]\s*\nbinding = "OAUTH_KV"\s*\nid = "[^"]*"/,
        kvBinding.trim(),
      );
    } else {
      toml += `\n${kvBinding}`;
    }
  }

  await writeFile("wrangler.toml", toml, "utf8");
  ok(`Wrote bindings + vars to wrangler.toml`);
}

/**
 * Push every collected secret to the deployed Worker via `wrangler secret put`
 * with the value piped on stdin. Skips cleanly if the user declines, and
 * returns whether all known secrets were actually synced.
 */
async function step9_syncSecretsToProd(input: {
  openaiKey: string;
  notionToken: string;
  mcp: {
    kvNamespaceId: string;
    allowedUsers: string;
    githubClientId: string;
    githubClientSecret: string;
  } | null;
}): Promise<boolean> {
  header("[9/10] Syncing secrets to production Worker");

  const ans = (
    await rl.question(
      "  Push these secrets to Cloudflare now? (Y/n — skip if you only run local dev): ",
    )
  )
    .trim()
    .toLowerCase();
  if (ans === "n" || ans === "no") {
    warn("Skipped. Your .dev.vars is written; prod secrets unchanged.");
    return false;
  }

  const targets: Array<{ name: string; value: string }> = [
    { name: "OPENAI_API_KEY", value: input.openaiKey },
    { name: "NOTION_INTEGRATION_KEY", value: input.notionToken },
  ];
  if (input.mcp) {
    targets.push(
      { name: "GITHUB_CLIENT_ID", value: input.mcp.githubClientId },
      { name: "GITHUB_CLIENT_SECRET", value: input.mcp.githubClientSecret },
    );
  }

  let ok_count = 0;
  for (const t of targets) {
    info(`Setting ${t.name}...`);
    const r = putSecret(t.name, t.value);
    if (r.status !== 0) {
      warn(
        `Failed to set ${t.name} (wrangler exited ${r.status}). You can run \`npx wrangler secret put ${t.name}\` manually. Details:\n${(r.stderr || r.stdout).slice(0, 400)}`,
      );
      continue;
    }
    ok(`${t.name} pushed`);
    ok_count++;
  }

  return ok_count === targets.length;
}

/**
 * Offer to run `wrangler deploy` for the user. Captures the printed worker URL
 * from wrangler's output (the line that starts with `https://...workers.dev`).
 */
async function step10_offerDeploy(): Promise<string | null> {
  header("[10/10] Deploy to Cloudflare");
  const ans = (
    await rl.question("  Run `npx wrangler deploy` now? (Y/n): ")
  )
    .trim()
    .toLowerCase();
  if (ans === "n" || ans === "no") {
    warn("Skipped. Run `npx wrangler deploy` yourself when ready.");
    return null;
  }

  info("Deploying...");
  const r = runCli("npx", ["wrangler", "deploy"]);
  if (r.status !== 0) {
    warn(
      `Deploy failed (wrangler exited ${r.status}). Output:\n${(r.stderr || r.stdout).slice(0, 600)}`,
    );
    return null;
  }
  // wrangler prints the URL on a line like "  https://<name>.<account>.workers.dev"
  const urlMatch = r.stdout.match(/https:\/\/[^\s]+\.workers\.dev/);
  const url = urlMatch ? urlMatch[0] : null;
  ok(`Deployed${url ? ` at ${url}` : ""}`);
  return url;
}

function printFinalSummary(args: {
  notion: {
    transcriptsDbId: string;
    followupsDbId: string;
    transcriptsDataSourceId: string;
    followupsDataSourceId: string;
  };
  mcp: {
    allowedUsers: string;
    githubClientId: string;
  } | null;
  pushedAll: boolean;
  workerUrl: string | null;
}): void {
  const { notion, mcp, pushedAll, workerUrl } = args;
  const url = workerUrl ?? "https://<your-worker>.workers.dev";

  console.log("\n\x1b[1m\x1b[32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m");
  console.log("\x1b[1m\x1b[32m Setup complete\x1b[0m");
  console.log("\x1b[1m\x1b[32m━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\x1b[0m\n");

  // Worker URL block
  if (workerUrl) {
    console.log(`\x1b[1mWorker:\x1b[0m ${workerUrl}`);
  } else {
    console.log(`\x1b[1mWorker:\x1b[0m (not yet deployed — run \`npx wrangler deploy\`)`);
  }

  // Notion links if DBs were newly created
  if (notion.followupsDbId || notion.transcriptsDbId) {
    console.log("");
    console.log("\x1b[1mNotion databases:\x1b[0m");
    if (notion.followupsDbId) {
      console.log(`  Followups:        https://www.notion.so/${notion.followupsDbId.replace(/-/g, "")}`);
    }
    if (notion.transcriptsDbId) {
      console.log(`  Call Transcripts: https://www.notion.so/${notion.transcriptsDbId.replace(/-/g, "")}`);
    }
  }

  // Bluedot webhook setup
  console.log("");
  console.log("\x1b[1m1. Point Bluedot at your webhook\x1b[0m");
  console.log(`   In Bluedot → Settings → Webhooks → Add endpoint:`);
  console.log(`     URL:     \x1b[36m${url}/\x1b[0m`);
  console.log(`     Events:  meeting.transcript.created, meeting.summary.created`);
  console.log(`   Bluedot will show a Signing Secret. Save it:`);
  console.log(`     \x1b[90mnpx wrangler secret put BLUEDOT_WEBHOOK_SECRET\x1b[0m`);

  // Remaining secrets if any weren't pushed
  if (!pushedAll) {
    console.log("");
    console.log("\x1b[1m2. Push any remaining prod secrets\x1b[0m");
    console.log("   You skipped some during setup. Run:");
    console.log("     \x1b[90mnpx wrangler secret put OPENAI_API_KEY\x1b[0m");
    console.log("     \x1b[90mnpx wrangler secret put NOTION_INTEGRATION_KEY\x1b[0m");
    if (mcp) {
      console.log("     \x1b[90mnpx wrangler secret put GITHUB_CLIENT_ID\x1b[0m");
      console.log("     \x1b[90mnpx wrangler secret put GITHUB_CLIENT_SECRET\x1b[0m");
    }
  }

  // Claude.ai connection (MCP only)
  if (mcp) {
    const step = pushedAll ? 2 : 3;
    console.log("");
    console.log(`\x1b[1m${step}. Connect to Claude.ai\x1b[0m`);
    console.log(`   In Claude.ai → Settings → Connectors, add this MCP server URL:`);
    console.log(`     \x1b[36m${url}/mcp\x1b[0m`);
    console.log(`   You'll be redirected to GitHub to sign in.`);
    console.log(`   Allowed GitHub usernames: \x1b[36m${mcp.allowedUsers}\x1b[0m`);
  }

  console.log("");
  console.log("\x1b[1mQuick checks:\x1b[0m");
  console.log(`  Tail logs:  \x1b[90mnpx wrangler tail\x1b[0m`);
  console.log(`  Run tests:  \x1b[90mnpx vitest run\x1b[0m`);
  if (workerUrl) {
    console.log(`  Health:     \x1b[90mcurl ${workerUrl}/\x1b[0m`);
  }
  console.log("");
}

async function main(): Promise<void> {
  console.log("\n\x1b[1mbluedot-rag — Setup\x1b[0m");
  console.log("====================");
  console.log("Provisions Cloudflare D1 + Vectorize and Notion databases for the pipeline.\n");

  if (!existsSync("wrangler.toml")) {
    fail(`wrangler.toml not found. Run from the repo root.`);
  }

  // Load prior state so steps can offer to reuse values.
  const dev = await loadDevVars();
  const tomlVars = await readTomlVars();

  await step1_checkWranglerAuth();
  const d1Id = await step2_provisionD1();
  await step3_provisionVectorize();
  await step4_writeWranglerTomlAndMigrate(d1Id);

  const notion = await step5_setupNotion({
    notionToken: dev.NOTION_INTEGRATION_KEY,
    transcriptsDataSourceId: tomlVars.NOTION_TRANSCRIPTS_DATA_SOURCE_ID,
    followupsDataSourceId: tomlVars.NOTION_FOLLOWUPS_DATA_SOURCE_ID,
  });
  const openaiKey = await step6_openaiKey(dev.OPENAI_API_KEY);
  const mcp = await step8_setupMcpOAuth({
    githubClientId: dev.GITHUB_CLIENT_ID,
    githubClientSecret: dev.GITHUB_CLIENT_SECRET,
    allowedUsers: tomlVars.ALLOWED_USERS,
  });
  await step7_writeConfig({
    d1Id,
    notionToken: notion.token,
    openaiKey,
    transcriptsDataSourceId: notion.transcriptsDataSourceId,
    followupsDataSourceId: notion.followupsDataSourceId,
    mcp,
  });

  // Step 9: push the collected secrets to the deployed Worker.
  const pushedAll = await step9_syncSecretsToProd({
    openaiKey,
    notionToken: notion.token,
    mcp,
  });

  // Step 10: optional auto-deploy.
  const workerUrl = await step10_offerDeploy();

  printFinalSummary({ notion, mcp, pushedAll, workerUrl });
  rl.close();
}

main().catch((err) => {
  console.error(`\nUnhandled error: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
