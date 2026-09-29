import type { Env } from "./env";
import { all, now, stmt } from "./lib/db";
import { loadSettings, settingsLanguage } from "./lib/settings";
import { sendEmail } from "./lib/email";
import { t } from "./lib/i18n";
import { generateProtocolPdf } from "./services/pdf";
import type { MediaRow } from "./services/media";

/** Hourly: retry failed/pending PDFs, purge stale staged uploads. */
export async function hourly(env: Env): Promise<void> {
  const pending = await all<{ id: string }>(
    env.DB,
    "SELECT id FROM protocols WHERE pdf_status IN ('pending','failed') AND pdf_attempts < 5 ORDER BY created_at LIMIT 20",
  );
  for (const p of pending) await generateProtocolPdf(env, p.id);

  const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString();
  const stale = await all<MediaRow>(
    env.DB,
    "SELECT * FROM media WHERE attached_at IS NULL AND discarded_at IS NULL AND kind IN ('photo','signature') AND created_at < ? LIMIT 100",
    cutoff,
  );
  for (const m of stale) {
    await env.MEDIA.delete(m.r2_key).catch(() => undefined);
    await stmt(env.DB, "UPDATE media SET discarded_at = ? WHERE id = ?", now(), m.id).run();
  }
}

/** Daily: overdue-return digest to the configured recipients. */
export async function daily(env: Env): Promise<void> {
  const settings = await loadSettings(env);
  const recipients = settings.overdue_digest_recipients.split(/[,;\s]+/).filter((r) => r.includes("@"));
  if (!recipients.length || !settings.email_enabled) return;
  const lang = settingsLanguage(settings);
  const overdue = await all<{ borrower_name: string; expected_return_at: string; internal_number: string; manufacturer: string; model: string; license_plate: string }>(
    env.DB,
    `SELECT l.borrower_name, l.expected_return_at, v.internal_number, v.manufacturer, v.model, v.license_plate
     FROM loans l JOIN vehicles v ON v.id = l.vehicle_id
     WHERE l.status = 'active' AND l.expected_return_at < ? ORDER BY l.expected_return_at`,
    now(),
  );
  if (!overdue.length) return;
  const lines = overdue.map(
    (o) => `- ${o.internal_number} ${o.manufacturer} ${o.model}${o.license_plate ? ` (${o.license_plate})` : ""} · ${o.borrower_name} · ${new Date(o.expected_return_at).toLocaleDateString(lang === "de" ? "de-DE" : "en-GB")}`,
  );
  const base = settings.public_base_url;
  await sendEmail(
    env,
    recipients,
    t(lang, "email.overdue.subject", { org: settings.org_name, count: overdue.length }),
    `${t(lang, "email.overdue.intro")}\n\n${lines.join("\n")}\n\n${base}/loans`,
  );
}
