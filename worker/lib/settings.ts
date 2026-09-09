import type { Language, PublicSettings, Settings } from "@shared/types";
import type { Env } from "../env";
import { all, now, stmt } from "./db";
import { emailAvailable } from "./email";

export const DEFAULT_SETTINGS: Settings = {
  org_name: "FlareFleet",
  default_language: "de",
  public_base_url: "",
  min_photos_check_in: 1,
  min_photos_loan: 1,
  min_photos_return: 1,
  min_photos_check_out: 1,
  signature_required_check_in: false,
  signature_required_return: false,
  signature_required_check_out: false,
  default_loan_days: 7,
  public_qr_page: true,
  email_enabled: true,
  email_from: "",
  overdue_digest_recipients: "",
  pdf_footer: "",
};

const CACHE_KEY = "settings:v1";

/** True when PUBLIC_BASE_URL is an explicit public address (not empty, not a local dev URL). */
export function isUsableBaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  return !/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?\/?$/i.test(url.trim());
}

export async function loadSettings(env: Env): Promise<Settings> {
  const cached = await env.KV.get<Settings>(CACHE_KEY, "json");
  if (cached) return { ...DEFAULT_SETTINGS, ...cached };
  const rows = await all<{ key: string; value: string }>(env.DB, "SELECT key, value FROM settings");
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    try {
      merged[r.key] = JSON.parse(r.value);
    } catch {
      merged[r.key] = r.value;
    }
  }
  if (!merged.public_base_url) merged.public_base_url = env.PUBLIC_BASE_URL;
  const s = merged as unknown as Settings;
  await env.KV.put(CACHE_KEY, JSON.stringify(s), { expirationTtl: 300 });
  return s;
}

export async function saveSettings(env: Env, patch: Partial<Settings>, actorId: string): Promise<Settings> {
  const ts = now();
  const statements = Object.entries(patch).map(([k, v]) =>
    stmt(
      env.DB,
      "INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
      k,
      JSON.stringify(v),
      actorId,
      ts,
    ),
  );
  if (statements.length) await env.DB.batch(statements);
  await env.KV.delete(CACHE_KEY);
  return loadSettings(env);
}

export function publicSettings(s: Settings, env: Env): PublicSettings {
  const { overdue_digest_recipients: _a, pdf_footer: _b, email_from: _c, ...pub } = s;
  return { ...pub, email_enabled: emailAvailable(env, s) };
}

export function settingsLanguage(s: Settings): Language {
  return s.default_language === "en" ? "en" : "de";
}
