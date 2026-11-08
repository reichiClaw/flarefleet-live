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

/** 25 MiB is the total message limit and base64 transport adds about a third. */
export const MAX_ATTACHMENT_BYTES = 18 * 1024 * 1024;

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** The local `wrangler dev` simulator cannot pass binary attachments through. */
function cannotSerializeBinary(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return /serializ|DataCloneError|could not be cloned|structured/i.test(`${e?.code ?? ""} ${e?.message ?? ""}`);
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
  const total = attachments.reduce((n, a) => n + a.content.byteLength, 0);
  if (total > MAX_ATTACHMENT_BYTES) return { ok: false, error: "attachment_too_large" };

  // Attachments go out as raw bytes: a base64 string is delivered as-is, so the
  // recipient would get a text file with a .pdf name that no reader can open.
  const send = (asBase64: boolean) =>
    env.EMAIL!.send({
      to: recipients,
      from: { email: from, name: settings?.org_name || env.APP_NAME },
      subject,
      text,
      html: textToHtml(text),
      attachments: attachments.map((a) => ({
        filename: a.filename,
        type: a.type,
        content: asBase64 ? toBase64(a.content) : toArrayBuffer(a.content),
        disposition: "attachment" as const,
      })),
    });

  try {
    await send(false);
    return { ok: true };
  } catch (err) {
    if (attachments.length && cannotSerializeBinary(err)) {
      try {
        await send(true);
        return { ok: true };
      } catch {
        // fall through with the original error
      }
    }
    const e = err as { code?: string; message?: string };
    const error = e?.code || e?.message || String(err);
    console.error("email send failed", error);
    return { ok: false, error: String(error).slice(0, 200) };
  }
}

export async function sendEmail(env: Env, to: string | string[], subject: string, text: string, attachments: Attachment[] = []): Promise<boolean> {
  return (await sendEmailDetailed(env, to, subject, text, attachments)).ok;
}
