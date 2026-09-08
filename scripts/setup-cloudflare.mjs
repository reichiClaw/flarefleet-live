#!/usr/bin/env node
// One-shot installer: creates the Cloudflare resources, fills wrangler.jsonc,
// applies D1 migrations and deploys. Safe to re-run: existing resources are
// reused, only placeholders/values you confirm are changed.
//
//   npm run setup:cloudflare
//   npm run setup:cloudflare -- --yes --base-url https://fleet.example.com --email-from fleet@example.com
//   npm run setup:cloudflare -- --skip-deploy

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { resolveBindings, wrangler as wranglerRaw } from "./resolve-bindings.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = resolve(ROOT, "wrangler.jsonc");

const args = parseArgs(process.argv.slice(2));
const nonInteractive = !!args.yes;
let rl = nonInteractive ? null : createInterface({ input: stdin, output: stdout });
// Buffer input lines so answers work both on a TTY and when piped in; when
// stdin ends (Ctrl-D, exhausted pipe) fall back to defaults instead of hanging.
const lineQueue = [];
let waiter = null;
rl?.on("line", (line) => (waiter ? waiter(line) : lineQueue.push(line)));
rl?.on("close", () => {
  rl = null;
  waiter?.(null);
});
function prompt(text) {
  if (!rl) return Promise.resolve(null);
  stdout.write(text);
  if (lineQueue.length) return Promise.resolve(lineQueue.shift());
  return new Promise((resolveLine) => {
    waiter = (line) => {
      waiter = null;
      resolveLine(line);
    };
  });
}

const c = {
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};
const step = (n, msg) => console.log(`\n${c.bold(`[${n}/5] ${msg}`)}`);
const ok = (msg) => console.log(`  ${c.green("✔")} ${msg}`);
const warn = (msg) => console.log(`  ${c.yellow("!")} ${msg}`);
const fail = (msg) => {
  console.error(`\n${c.red("✖")} ${msg}`);
  process.exit(1);
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}

async function ask(question, fallback) {
  if (!rl) return fallback;
  const suffix = fallback !== undefined && fallback !== "" ? ` ${c.dim(`[${fallback}]`)}` : "";
  const answer = ((await prompt(`  ${question}${suffix}: `)) ?? "").trim();
  return answer || fallback;
}

async function confirm(question, fallback = true) {
  if (!rl) return fallback;
  const answer = ((await prompt(`  ${question} ${c.dim(fallback ? "[Y/n]" : "[y/N]")}: `)) ?? "").trim().toLowerCase();
  if (!answer) return fallback;
  return answer.startsWith("y") || answer.startsWith("j");
}

function wrangler(cmdArgs, opts = {}) {
  try {
    return wranglerRaw(cmdArgs, opts);
  } catch (err) {
    fail(err.message);
  }
}

function readConfig() {
  if (!existsSync(CONFIG)) fail(`wrangler.jsonc not found at ${CONFIG}`);
  return readFileSync(CONFIG, "utf8");
}

function setVar(text, name, value) {
  const re = new RegExp(`("${name}"\\s*:\\s*)"[^"]*"`);
  if (!re.test(text)) fail(`Could not find "${name}" in wrangler.jsonc`);
  return text.replace(re, `$1${JSON.stringify(value)}`);
}

function getVar(text, name) {
  const m = text.match(new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`));
  return m ? m[1] : "";
}

function workerName(text) {
  return getVar(text, "name") || "flarefleet";
}

// ---------------------------------------------------------------------------

console.log(c.bold("\nFlareFleet – Cloudflare installer"));
console.log(c.dim("Creates D1, KV and R2, writes wrangler.jsonc, applies migrations and deploys.\n"));

let config = readConfig();
const name = workerName(config);

// 1. Auth ------------------------------------------------------------------
step(1, "Checking Cloudflare login");
let who = wrangler(["whoami"], { allowFail: true });
if (who.status !== 0 || /not authenticated|You are not logged in/i.test(who.text)) {
  warn("Not logged in. Opening the browser for `wrangler login`…");
  wrangler(["login"], { inherit: true });
  who = wrangler(["whoami"]);
}
const accountLine = who.text.split("\n").find((l) => /│.*│.*│/.test(l) && !/Account Name/i.test(l));
ok(accountLine ? `Logged in (${accountLine.replace(/│/g, "|").replace(/\s+/g, " ").trim()})` : "Logged in");

// 2. Resources -------------------------------------------------------------
step(2, "D1 database, KV namespace, R2 bucket");
try {
  const r = await resolveBindings({ log: (m) => ok(m) });
  if (!r.created.length && !Object.keys(r.sources).length) ok("wrangler.jsonc already points at existing resources");
  config = readConfig();
} catch (err) {
  fail(err.message);
}

// 3. Variables -------------------------------------------------------------
step(3, "Application settings");
const currentBase = getVar(config, "PUBLIC_BASE_URL");
const currentFrom = getVar(config, "EMAIL_FROM");
const currentEnabled = getVar(config, "EMAIL_ENABLED") !== "false";

let baseUrl = args.baseUrl ?? (await ask("Public URL (custom domain, or leave empty to use the workers.dev URL)", /localhost/.test(currentBase) ? "" : currentBase));
if (baseUrl) baseUrl = baseUrl.replace(/\/+$/, "");
if (baseUrl && !/^https?:\/\//.test(baseUrl)) baseUrl = `https://${baseUrl}`;

let emailEnabled = args.emailFrom ? true : args.noEmail ? false : await confirm("Enable e-mail (requires a domain onboarded in Cloudflare Email Service)?", currentEnabled);
let emailFrom = currentFrom;
if (emailEnabled) {
  emailFrom = args.emailFrom ?? (await ask("Sender address (must be on the onboarded domain)", /example\.com$/.test(currentFrom) ? "" : currentFrom));
  if (!emailFrom || !emailFrom.includes("@")) {
    warn("No valid sender address given – e-mail will be disabled. You can enable it later in wrangler.jsonc.");
    emailEnabled = false;
  }
}
config = setVar(config, "EMAIL_ENABLED", emailEnabled ? "true" : "false");
if (emailEnabled) config = setVar(config, "EMAIL_FROM", emailFrom);
if (baseUrl) config = setVar(config, "PUBLIC_BASE_URL", baseUrl);

writeFileSync(CONFIG, config);
ok("wrangler.jsonc updated");
if (emailEnabled) {
  warn(
    `Make sure the domain of ${emailFrom} is onboarded: dashboard → Compute → Email Service → Email Sending → Onboard Domain.\n` +
      "    Until then, sends fail (the app still works; passwords are shown on screen).",
  );
}

// 4. Migrations ------------------------------------------------------------
step(4, "Applying D1 migrations (remote)");
wrangler(["d1", "migrations", "apply", "DB", "--remote", "--config", "wrangler.jsonc"], { inherit: true });
ok("Schema is up to date");

// 5. Deploy ----------------------------------------------------------------
step(5, "Build and deploy");
if (args.skipDeploy) {
  warn("Skipped (--skip-deploy). Run `npm run deploy` when ready.");
} else {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const build = spawnSync(npm, ["run", "build"], { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
  if (build.status !== 0) fail("Build failed");

  let deploy = wrangler(["deploy"]);
  process.stdout.write(deploy.stdout);
  const urlMatch = deploy.text.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i);
  const deployedUrl = urlMatch ? urlMatch[0] : null;

  // No custom URL given: point PUBLIC_BASE_URL at the workers.dev URL and deploy once more.
  if (!baseUrl && deployedUrl && getVar(config, "PUBLIC_BASE_URL") !== deployedUrl) {
    config = setVar(config, "PUBLIC_BASE_URL", deployedUrl);
    writeFileSync(CONFIG, config);
    ok(`PUBLIC_BASE_URL set to ${deployedUrl}; redeploying so links and QR labels use it`);
    deploy = wrangler(["deploy"]);
  }
  baseUrl = baseUrl || deployedUrl || getVar(config, "PUBLIC_BASE_URL");
  ok(`Deployed: ${baseUrl}`);
}

rl?.close();

console.log(`
${c.bold(c.green("Done."))}

Next steps:
  1. Open ${c.bold(baseUrl || "your Worker URL")} – the setup screen creates the first super admin.
  2. Settings → categories → partners → users → import the delivery list.
${baseUrl && !/workers\.dev/.test(baseUrl) ? `  3. Attach the custom domain: dashboard → Workers & Pages → ${name} → Settings → Domains & Routes → Add → Custom domain (${baseUrl.replace(/^https?:\/\//, "")}).\n` : ""}
Later updates: git pull && npm install && npm run db:migrate && npm run deploy
`);
