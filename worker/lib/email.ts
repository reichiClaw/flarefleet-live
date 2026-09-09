import type { Settings } from "@shared/types";
import type { Env } from "../env";
import { loadSettings } from "./settings";

export interface Attachment {
  filename: string;
  type: string;
  content: Uint8Array;
}

export interface SendResult {
  ok: boolean;
  /** Short machine-readable reason when not ok (Email Service error code or local reason). */
  error?: string;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Sender address: the super-admin setting wins over the EMAIL_FROM var. */
export function emailFrom(env: Env, settings?: Pick<Settings, "email_from"> | null): string {
  return (settings?.email_from || env.EMAIL_FROM || "").trim();
}

/** True when the binding exists, sending is not switched off and a sender address is known. */
export function emailAvailable(env: Env, settings?: Pick<Settings, "email_from" | "email_enabled"> | null): boolean {
  if (!env.EMAIL || env.EMAIL_ENABLED === "false") return false;
  if (settings && !settings.email_enabled) return false;
  return emailFrom(env, settings).includes("@");
}

function textToHtml(text: string): string {
  const esc = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const linked = esc.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1">$1</a>');
  return `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;white-space:pre-wrap">${linked}</div>`;
}

/**
 * Sends an e-mail through the Cloudflare Email Service binding and reports why
 * it could not, instead of throwing: e-mail is a convenience, not part of the protocol.
 */
export async function sendEmailDetailed(
  env: Env,
  to: string | string[],
  subject: string,
  text: string,
  attachments: Attachment[] = [],
): Promise<SendResult> {
  const settings = await loadSettings(env).catch(() => null);
  if (!env.EMAIL) return { ok: false, error: "no_binding" };
  if (env.EMAIL_ENABLED === "false" || (settings && !settings.email_enabled)) return { ok: false, error: "disabled" };
  const from = emailFrom(env, settings);
  if (!from.includes("@")) return { ok: false, error: "no_sender" };
  const recipients = (Array.isArray(to) ? to : [to]).map((s) => s.trim()).filter(Boolean);
  if (!recipients.length) return { ok: false, error: "no_recipient" };
  try {
    await env.EMAIL.send({
      to: recipients,
      from: { email: from, name: settings?.org_name || env.APP_NAME },
      subject,
      text,
      html: textToHtml(text),
      attachments: attachments.map((a) => ({
        filename: a.filename,
        type: a.type,
        content: toBase64(a.content),
        disposition: "attachment",
      })),
    });
    return { ok: true };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    const error = e?.code || e?.message || String(err);
    console.error("email send failed", error);
    return { ok: false, error: String(error).slice(0, 200) };
  }
}

export async function sendEmail(env: Env, to: string | string[], subject: string, text: string, attachments: Attachment[] = []): Promise<boolean> {
  return (await sendEmailDetailed(env, to, subject, text, attachments)).ok;
}
