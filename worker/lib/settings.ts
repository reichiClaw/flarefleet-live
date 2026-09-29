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

/** Settings as they sit in D1, including keys the app resolves instead of exposing. */
export interface StoredSettings extends Settings {
  /** URL the app was reached at during first-run setup. Weakest source for public_base_url. */
  public_base_url_detected: string;
}

const DEFAULT_STORED: StoredSettings = { ...DEFAULT_SETTINGS, public_base_url_detected: "" };

const CACHE_KEY = "settings:v2";

export async function clearSettingsCache(env: Env): Promise<void> {
  await env.KV.delete(CACHE_KEY);
}

/** True when PUBLIC_BASE_URL is an explicit public address (not empty, not a local dev URL). */
export function isUsableBaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  return !/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?\/?$/i.test(url.trim());
}

export type BaseUrlSource = "setting" | "config" | "detected" | "none";

function clean(url: unknown): string {
  return typeof url === "string" ? url.trim().replace(/\/+$/, "") : "";
}

/**
 * The app setting wins over PUBLIC_BASE_URL from the deploy configuration, which
 * wins over the URL seen at first-run setup. Without that order a deployment that
 * recorded its workers.dev address could never be moved to a custom domain by
 * changing the configuration.
 */
export function resolveBaseUrl(env: Env, stored: Pick<StoredSettings, "public_base_url" | "public_base_url_detected">): { url: string; source: BaseUrlSource } {
  const setting = clean(stored.public_base_url);
  if (setting) return { url: setting, source: "setting" };
  if (isUsableBaseUrl(env.PUBLIC_BASE_URL)) return { url: clean(env.PUBLIC_BASE_URL), source: "config" };
  const detected = clean(stored.public_base_url_detected);
  if (detected) return { url: detected, source: "detected" };
  return { url: "", source: "none" };
}

/** Raw stored values, i.e. what the super admin edits in Settings. */
export async function loadStoredSettings(env: Env): Promise<StoredSettings> {
  const cached = await env.KV.get<StoredSettings>(CACHE_KEY, "json");
  if (cached) return { ...DEFAULT_STORED, ...cached };
  const rows = await all<{ key: string; value: string }>(env.DB, "SELECT key, value FROM settings");
  const merged: Record<string, unknown> = { ...DEFAULT_STORED };
  for (const r of rows) {
    try {
      merged[r.key] = JSON.parse(r.value);
    } catch {
      merged[r.key] = r.value;
    }
  }
  const s = merged as unknown as StoredSettings;
  await env.KV.put(CACHE_KEY, JSON.stringify(s), { expirationTtl: 300 });
  return s;
}

/** Values the app works with. Resolved after the cache read, so a deploy takes effect at once. */
export function resolveSettings(env: Env, stored: StoredSettings): Settings {
  const { public_base_url_detected: _detected, ...s } = stored;
  return { ...s, public_base_url: resolveBaseUrl(env, stored).url };
}

export async function loadSettings(env: Env): Promise<Settings> {
  return resolveSettings(env, await loadStoredSettings(env));
}

/** Address for links in e-mails and QR labels; a request can always speak for itself. */
export function baseUrlFor(settings: Pick<Settings, "public_base_url">, requestUrl: string): string {
  return settings.public_base_url || new URL(requestUrl).origin;
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
  await clearSettingsCache(env);
  return loadSettings(env);
}

export function publicSettings(s: Settings, env: Env): PublicSettings {
  const { overdue_digest_recipients: _a, pdf_footer: _b, email_from: _c, ...pub } = s;
  return { ...pub, email_enabled: emailAvailable(env, s) };
}

export function settingsLanguage(s: Settings): Language {
  return s.default_language === "en" ? "en" : "de";
}
