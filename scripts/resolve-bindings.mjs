#!/usr/bin/env node
// Makes sure wrangler.jsonc points at real Cloudflare resources before
// migrations/deploy run. Placeholders (or missing ids) are resolved in this order:
//
//   1. environment variables  D1_DATABASE_ID, KV_NAMESPACE_ID, R2_BUCKET_NAME
//      (set them as Workers Builds "build variables" to pin resources)
//   2. the bindings of the already deployed Worker (needs CLOUDFLARE_API_TOKEN +
//      CLOUDFLARE_ACCOUNT_ID in the environment, as in Workers Builds)
//   3. existing resources with the configured names (wrangler d1 list / kv namespace list)
//   4. creating new resources
//
// Running it when the ids are already valid is a no-op. Used by `npm run deploy`
// and by the installer, so that force-updating a fork from upstream (which resets
// wrangler.jsonc to placeholders) never breaks the next deploy.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = resolve(ROOT, "wrangler.jsonc");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KV_ID_RE = /^[0-9a-f]{32}$/i;

export function wrangler(cmdArgs, { inherit = false, allowFail = false } = {}) {
  const res = spawnSync(process.platform === "win32" ? "npx.cmd" : "npx", ["wrangler", ...cmdArgs], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["inherit", "pipe", "pipe"],
    shell: process.platform === "win32",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  const out = { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
  out.text = `${out.stdout}\n${out.stderr}`;
  if (res.status !== 0 && !allowFail) {
    console.error(out.text);
    throw new Error(`wrangler ${cmdArgs.join(" ")} failed`);
  }
  return out;
}

export function extractJson(text) {
  const starts = ["[", "{"].map((ch) => text.indexOf(ch)).filter((i) => i >= 0);
  if (!starts.length) return null;
  const start = Math.min(...starts);
  const end = Math.max(text.lastIndexOf("]"), text.lastIndexOf("}"));
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function getStr(text, re) {
  const m = text.match(re);
  return m ? m[1] : "";
}

export function readBindings(text) {
  return {
    workerName: getStr(text, /"name"\s*:\s*"([^"]*)"/) || "flarefleet",
    d1Name: getStr(text, /"database_name"\s*:\s*"([^"]*)"/) || "flarefleet-db",
    d1Id: getStr(text, /"database_id"\s*:\s*"([^"]*)"/),
    kvId: getStr(text, /"kv_namespaces"[\s\S]*?"binding"\s*:\s*"KV"[\s\S]*?"id"\s*:\s*"([^"]*)"/),
    r2Bucket: getStr(text, /"r2_buckets"[\s\S]*?"bucket_name"\s*:\s*"([^"]*)"/) || "flarefleet-media",
  };
}

function writeBindings(text, { d1Id, kvId, r2Bucket }) {
  let out = text;
  if (d1Id) out = out.replace(/("database_id"\s*:\s*)"[^"]*"/, `$1"${d1Id}"`);
  if (kvId) out = out.replace(/("kv_namespaces"[\s\S]*?"binding"\s*:\s*"KV"[\s\S]*?"id"\s*:\s*)"[^"]*"/, `$1"${kvId}"`);
  if (r2Bucket) out = out.replace(/("r2_buckets"[\s\S]*?"bucket_name"\s*:\s*)"[^"]*"/, `$1"${r2Bucket}"`);
  return out;
}

async function liveWorkerBindings(workerName) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) return null;
  try {
    const base = process.env.CLOUDFLARE_API_BASE_URL || "https://api.cloudflare.com/client/v4";
    const res = await fetch(`${base}/accounts/${account}/workers/scripts/${workerName}/settings`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = await res.json();
    const bindings = body?.result?.bindings ?? [];
    const find = (type, name) => bindings.find((b) => b.type === type && b.name === name);
    return {
      d1Id: find("d1", "DB")?.id ?? null,
      kvId: find("kv_namespace", "KV")?.namespace_id ?? null,
      r2Bucket: find("r2_bucket", "MEDIA")?.bucket_name ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Resolves placeholder ids in wrangler.jsonc. Returns a summary of what happened.
 * `log` receives human readable progress lines.
 */
export async function resolveBindings({ log = () => {}, createMissing = true } = {}) {
  const original = readFileSync(CONFIG, "utf8");
  const cfg = readBindings(original);
  const result = { d1Id: cfg.d1Id, kvId: cfg.kvId, r2Bucket: cfg.r2Bucket, changed: false, created: [], sources: {} };

  const needD1 = !UUID_RE.test(cfg.d1Id);
  const needKv = !KV_ID_RE.test(cfg.kvId);
  const envBucket = process.env.R2_BUCKET_NAME;
  const bucketOverride = envBucket && envBucket !== cfg.r2Bucket ? envBucket : null;

  if (!needD1 && !needKv && !bucketOverride) {
    // Ids present; still make sure the bucket exists (cheap, idempotent) when asked to create.
    if (createMissing) ensureBucket(cfg.r2Bucket, log, result);
    return result;
  }

  // 1. environment overrides
  if (needD1 && UUID_RE.test(process.env.D1_DATABASE_ID ?? "")) {
    result.d1Id = process.env.D1_DATABASE_ID;
    result.sources.d1 = "env D1_DATABASE_ID";
  }
  if (needKv && KV_ID_RE.test(process.env.KV_NAMESPACE_ID ?? "")) {
    result.kvId = process.env.KV_NAMESPACE_ID;
    result.sources.kv = "env KV_NAMESPACE_ID";
  }
  if (bucketOverride) {
    result.r2Bucket = bucketOverride;
    result.sources.r2 = "env R2_BUCKET_NAME";
  }

  // 2. bindings of the deployed Worker
  if ((needD1 && !result.sources.d1) || (needKv && !result.sources.kv)) {
    const live = await liveWorkerBindings(cfg.workerName);
    if (live) {
      if (needD1 && !result.sources.d1 && live.d1Id) {
        result.d1Id = live.d1Id;
        result.sources.d1 = "deployed Worker";
      }
      if (needKv && !result.sources.kv && live.kvId) {
        result.kvId = live.kvId;
        result.sources.kv = "deployed Worker";
      }
      if (!result.sources.r2 && live.r2Bucket && live.r2Bucket !== cfg.r2Bucket) {
        result.r2Bucket = live.r2Bucket;
        result.sources.r2 = "deployed Worker";
      }
    }
  }

  // 3. existing resources by name
  if (needD1 && !result.sources.d1) {
    const list = extractJson(wrangler(["d1", "list", "--json"], { allowFail: true }).stdout);
    const hit = Array.isArray(list) ? list.find((d) => d.name === cfg.d1Name) : null;
    if (hit?.uuid) {
      result.d1Id = hit.uuid;
      result.sources.d1 = `existing database "${cfg.d1Name}"`;
    }
  }
  if (needKv && !result.sources.kv) {
    const list = extractJson(wrangler(["kv", "namespace", "list"], { allowFail: true }).stdout);
    const title = `${cfg.workerName}-KV`;
    const hit = Array.isArray(list) ? list.find((n) => n.title === title) : null;
    if (hit?.id) {
      result.kvId = hit.id;
      result.sources.kv = `existing namespace "${title}"`;
    }
  }

  // 4. create
  if (needD1 && !result.sources.d1) {
    if (!createMissing) throw new Error(`No D1 database id for "${cfg.d1Name}" and creation disabled`);
    const created = wrangler(["d1", "create", cfg.d1Name]);
    const m = created.text.match(/"database_id"\s*:\s*"([0-9a-f-]{36})"/i) ?? created.text.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    if (!m) throw new Error("Could not read the database id from wrangler output:\n" + created.text);
    result.d1Id = m[1];
    result.sources.d1 = "created";
    result.created.push(`D1 database ${cfg.d1Name}`);
  }
  if (needKv && !result.sources.kv) {
    if (!createMissing) throw new Error("No KV namespace id and creation disabled");
    const created = wrangler(["kv", "namespace", "create", "KV"]);
    const m = created.text.match(/"id"\s*:\s*"([0-9a-f]{32})"/i) ?? created.text.match(/\b([0-9a-f]{32})\b/i);
    if (!m) throw new Error("Could not read the KV namespace id from wrangler output:\n" + created.text);
    result.kvId = m[1];
    result.sources.kv = "created";
    result.created.push(`KV namespace ${cfg.workerName}-KV`);
  }
  if (createMissing) ensureBucket(result.r2Bucket, log, result);

  const updated = writeBindings(original, result);
  if (updated !== original) {
    writeFileSync(CONFIG, updated);
    result.changed = true;
  }
  for (const [k, v] of Object.entries(result.sources)) log(`${k.toUpperCase()}: ${v}`);
  return result;
}

function ensureBucket(bucket, log, result) {
  const r2 = wrangler(["r2", "bucket", "create", bucket], { allowFail: true });
  if (r2.status === 0) {
    result.created.push(`R2 bucket ${bucket}`);
    log(`R2: created bucket "${bucket}"`);
  } else if (/already exists|already own|10004/i.test(r2.text)) {
    // fine
  } else if (/not enabled|enable R2|Please enable|10042/i.test(r2.text)) {
    throw new Error(
      "R2 is not enabled on this account yet. Open https://dash.cloudflare.com → R2 Object Storage → Get started (free, one-time), then retry.",
    );
  } else {
    console.error(r2.text);
    throw new Error(`Could not create the R2 bucket "${bucket}"`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  resolveBindings({ log: (m) => console.log(`  resolve-bindings: ${m}`) })
    .then((r) => {
      if (r.changed) console.log("  resolve-bindings: wrangler.jsonc updated");
    })
    .catch((err) => {
      console.error(`\n✖ ${err.message}`);
      process.exit(1);
    });
}
