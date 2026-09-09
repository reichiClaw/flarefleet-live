import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type PDFImage } from "pdf-lib";
import type { Language, ProtocolSnapshot, ProtocolType } from "@shared/types";
import type { Env } from "../env";
import { one, stmt } from "../lib/db";
import { t } from "../lib/i18n";
import { loadSettings } from "../lib/settings";
import { sendEmailDetailed } from "../lib/email";
import { storeGenerated, type MediaRow } from "./media";

interface ProtocolRow {
  id: string;
  number: string;
  type: ProtocolType;
  vehicle_id: string;
  performed_by: string;
  performed_at: string;
  odometer_km: number | null;
  operating_hours: number | null;
  condition: string | null;
  notes: string;
  status_before: string | null;
  status_after: string | null;
  snapshot: string;
  language: Language;
  pdf_status: string;
  pdf_media_id: string | null;
  pdf_attempts: number;
}

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 42;
const GRAY = rgb(0.45, 0.45, 0.45);
const DARK = rgb(0.1, 0.1, 0.1);
const LINE = rgb(0.85, 0.85, 0.85);
const ACCENT = rgb(0.06, 0.45, 0.85);

// Standard fonts only support WinAnsi; replace anything else.
function safe(s: unknown): string {
  return String(s ?? "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201E\u201D]/g, '"')
    .replace(/[^\u0000-\u00FF\u20AC\u2013\u2014\u2022\u00B7]/g, "?");
}

function fmtDate(iso: string | null | undefined, lang: Language, withTime = true): string {
  if (!iso) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(lang === "de" ? "de-DE" : "en-GB", {
    timeZone: "Europe/Berlin",
    dateStyle: "medium",
    ...(withTime ? { timeStyle: "short" } : {}),
  });
}

function fmtNum(n: number | null | undefined, lang: Language, unit = ""): string {
  if (n == null) return "–";
  return `${n.toLocaleString(lang === "de" ? "de-DE" : "en-GB")}${unit}`;
}

class Writer {
  doc: PDFDocument;
  page!: PDFPage;
  y = 0;
  font: PDFFont;
  bold: PDFFont;
  pages: PDFPage[] = [];
  lang: Language;
  footer: string;

  constructor(doc: PDFDocument, font: PDFFont, bold: PDFFont, lang: Language, footer: string) {
    this.doc = doc;
    this.font = font;
    this.bold = bold;
    this.lang = lang;
    this.footer = footer;
    this.newPage();
  }

  newPage() {
    this.page = this.doc.addPage(A4);
    this.pages.push(this.page);
    this.y = A4[1] - MARGIN;
  }

  ensure(height: number) {
    if (this.y - height < MARGIN + 30) this.newPage();
  }

  wrap(text: string, font: PDFFont, size: number, width: number): string[] {
    const out: string[] = [];
    for (const para of safe(text).split(/\r?\n/)) {
      const words = para.split(/\s+/).filter(Boolean);
      let line = "";
      for (const w of words) {
        const candidate = line ? `${line} ${w}` : w;
        if (font.widthOfTextAtSize(candidate, size) <= width) line = candidate;
        else {
          if (line) out.push(line);
          line = w;
        }
      }
      out.push(line);
    }
    return out.length ? out : [""];
  }

  text(text: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; x?: number; width?: number } = {}) {
    const size = opts.size ?? 10;
    const font = opts.bold ? this.bold : this.font;
    const x = opts.x ?? MARGIN;
    const width = opts.width ?? A4[0] - x - MARGIN;
    for (const line of this.wrap(text, font, size, width)) {
      this.ensure(size + 4);
      this.page.drawText(line, { x, y: this.y - size, size, font, color: opts.color ?? DARK });
      this.y -= size + 4;
    }
  }

  heading(text: string) {
    this.ensure(30);
    this.y -= 8;
    this.page.drawText(safe(text).toUpperCase(), { x: MARGIN, y: this.y - 9, size: 9, font: this.bold, color: ACCENT });
    this.y -= 14;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: A4[0] - MARGIN, y: this.y }, thickness: 0.6, color: LINE });
    this.y -= 8;
  }

  /** Two-column key/value rows. */
  kv(rows: [string, string][]) {
    const colX = MARGIN + 150;
    for (const [k, v] of rows) {
      const lines = this.wrap(v, this.font, 10, A4[0] - colX - MARGIN);
      this.ensure(lines.length * 14);
      this.page.drawText(safe(k), { x: MARGIN, y: this.y - 10, size: 9, font: this.font, color: GRAY });
      for (const line of lines) {
        this.page.drawText(line, { x: colX, y: this.y - 10, size: 10, font: this.font, color: DARK });
        this.y -= 14;
      }
    }
  }

  async image(bytes: Uint8Array, contentType: string, caption: string, maxW: number, maxH: number, x: number): Promise<number> {
    let img: PDFImage;
    try {
      img = contentType === "image/png" ? await this.doc.embedPng(bytes) : await this.doc.embedJpg(bytes);
    } catch {
      return 0;
    }
    const scale = Math.min(maxW / img.width, maxH / img.height, 1);
    const w = img.width * scale;
    const h = img.height * scale;
    this.page.drawImage(img, { x, y: this.y - h, width: w, height: h });
    if (caption) this.page.drawText(safe(caption).slice(0, 60), { x, y: this.y - h - 10, size: 7, font: this.font, color: GRAY });
    return h + (caption ? 12 : 0);
  }

  finish(generatedAt: string, number: string) {
    const total = this.pages.length;
    this.pages.forEach((p, i) => {
      const footer = safe(this.footer || t(this.lang, "pdf.generated", { date: fmtDate(generatedAt, this.lang) }));
      p.drawLine({ start: { x: MARGIN, y: MARGIN - 6 }, end: { x: A4[0] - MARGIN, y: MARGIN - 6 }, thickness: 0.5, color: LINE });
      p.drawText(footer, { x: MARGIN, y: MARGIN - 18, size: 7, font: this.font, color: GRAY });
      const pg = `${number} · ${t(this.lang, "pdf.page", { page: i + 1, total })}`;
      p.drawText(pg, { x: A4[0] - MARGIN - this.font.widthOfTextAtSize(pg, 7), y: MARGIN - 18, size: 7, font: this.font, color: GRAY });
    });
  }
}

async function loadMediaBytes(env: Env, m: MediaRow): Promise<Uint8Array | null> {
  const obj = await env.MEDIA.get(m.r2_key);
  if (!obj) return null;
  return new Uint8Array(await obj.arrayBuffer());
}

export async function renderProtocolPdf(env: Env, p: ProtocolRow, media: MediaRow[], orgName: string, footer: string): Promise<Uint8Array> {
  const snap = JSON.parse(p.snapshot) as ProtocolSnapshot;
  const lang = p.language;
  const doc = await PDFDocument.create();
  doc.setTitle(`${p.number} ${t(lang, `protocol.${p.type}`)}`);
  doc.setAuthor(orgName);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(doc, font, bold, lang, footer);

  // Header
  w.page.drawText(safe(orgName), { x: MARGIN, y: w.y - 12, size: 12, font: bold, color: GRAY });
  w.y -= 22;
  w.text(t(lang, `protocol.${p.type}`), { size: 18, bold: true });
  w.text(`${t(lang, "pdf.number")}: ${p.number}`, { size: 10, color: GRAY });
  w.y -= 4;

  w.heading(t(lang, "pdf.vehicle"));
  const v = snap.vehicle;
  w.kv([
    [t(lang, "pdf.internal_number"), `${v.internal_number}  (QR ${v.qr_code})`],
    [t(lang, "pdf.category"), v.category_name],
    [t(lang, "pdf.manufacturer_model"), `${v.manufacturer} ${v.model}`],
    ...(v.serial_number ? [[t(lang, "pdf.serial"), v.serial_number] as [string, string]] : []),
    ...(v.license_plate ? [[t(lang, "pdf.plate"), v.license_plate] as [string, string]] : []),
    ...(v.location ? [[t(lang, "pdf.location"), v.location] as [string, string]] : []),
    [
      t(lang, "pdf.status_change"),
      `${p.status_before ? t(lang, `status.${p.status_before}`) : "–"}  ->  ${p.status_after ? t(lang, `status.${p.status_after}`) : "–"}`,
    ],
  ]);

  w.heading(t(lang, "pdf.date"));
  w.kv([
    [t(lang, "pdf.date"), fmtDate(p.performed_at, lang)],
    [t(lang, "pdf.performed_by"), `${snap.performed_by.name} (${snap.performed_by.email})`],
  ]);

  if (snap.party && (snap.party.name || snap.party.company)) {
    const label = p.type === "check_in" ? "pdf.supplier" : p.type === "check_out" ? "pdf.recipient" : "pdf.borrower";
    w.heading(t(lang, label));
    const rows: [string, string][] = [];
    if (snap.party.name) rows.push([t(lang, label), snap.party.name]);
    if (snap.party.company && snap.party.company !== snap.party.name) rows.push([t(lang, "pdf.company"), snap.party.company]);
    if (snap.party.phone) rows.push([t(lang, "pdf.phone"), snap.party.phone]);
    if (snap.party.email) rows.push(["E-Mail", snap.party.email]);
    if (snap.loan) {
      rows.push([t(lang, "pdf.checked_out_at"), fmtDate(snap.loan.checked_out_at, lang)]);
      rows.push([t(lang, "pdf.expected_return"), fmtDate(snap.loan.expected_return_at, lang)]);
      if (snap.loan.actual_return_at) rows.push([t(lang, "pdf.actual_return"), fmtDate(snap.loan.actual_return_at, lang)]);
    }
    w.kv(rows);
  }

  const showReadings = v.meter_mode !== "none" && (snap.readings.odometer_km != null || snap.readings.operating_hours != null);
  if (showReadings) {
    w.heading(t(lang, "pdf.readings"));
    const rows: [string, string][] = [];
    const prev = snap.previous_readings;
    const checkoutReadings = (snap.extra?.checkout_readings as { odometer_km: number | null; operating_hours: number | null } | undefined) ?? null;
    if (snap.readings.odometer_km != null) {
      let s = fmtNum(snap.readings.odometer_km, lang, " km");
      const base = checkoutReadings?.odometer_km ?? prev?.odometer_km;
      if (base != null) s += `   (${t(lang, "pdf.previous")}: ${fmtNum(base, lang, " km")}, ${t(lang, "pdf.delta")}: ${fmtNum(snap.readings.odometer_km - base, lang, " km")})`;
      rows.push([t(lang, "pdf.odometer"), s]);
    }
    if (snap.readings.operating_hours != null) {
      let s = fmtNum(snap.readings.operating_hours, lang, " h");
      const base = checkoutReadings?.operating_hours ?? prev?.operating_hours;
      if (base != null) s += `   (${t(lang, "pdf.previous")}: ${fmtNum(base, lang, " h")}, ${t(lang, "pdf.delta")}: ${fmtNum(Math.round((snap.readings.operating_hours - base) * 10) / 10, lang, " h")})`;
      rows.push([t(lang, "pdf.hours"), s]);
    }
    w.kv(rows);
  }

  if (p.condition || snap.damages.length || p.type === "check_in" || p.type === "loan_return" || p.type === "check_out") {
    w.heading(t(lang, "pdf.condition"));
    if (p.condition) w.kv([[t(lang, "pdf.condition"), t(lang, `condition.${p.condition}`)]]);
    if (snap.damages.length) {
      w.text(t(lang, "pdf.damages"), { size: 9, color: GRAY });
      snap.damages.forEach((d, i) => w.text(`${i + 1}. [${t(lang, `severity.${d.severity}`)}] ${d.description}`));
    } else if (p.condition === "ok") {
      w.text(t(lang, "pdf.no_damages"), { color: GRAY });
    }
  }

  const resolved = snap.extra?.resolved_damage as { description: string; severity: string } | undefined;
  if (resolved) {
    w.heading(t(lang, "protocol.damage_resolved"));
    w.text(`[${t(lang, `severity.${resolved.severity}`)}] ${resolved.description}`);
  }

  if (p.notes) {
    w.heading(t(lang, "pdf.notes"));
    w.text(p.notes);
  }

  const photos = media.filter((m) => m.kind === "photo");
  if (photos.length) {
    w.heading(`${t(lang, "pdf.photos")} (${photos.length})`);
    const cellW = (A4[0] - MARGIN * 2 - 10) / 2;
    const cellH = 170;
    let col = 0;
    let rowH = 0;
    for (const m of photos) {
      if (col === 0) w.ensure(cellH + 26);
      const bytes = await loadMediaBytes(env, m);
      const x = MARGIN + col * (cellW + 10);
      let h = 0;
      if (bytes) h = await w.image(bytes, m.content_type, `${m.caption || m.filename}  ·  SHA-256 ${m.sha256.slice(0, 16)}…`, cellW, cellH, x);
      if (!h) {
        w.page.drawText(safe(`${m.filename} (${m.content_type}) SHA-256 ${m.sha256.slice(0, 16)}…`), { x, y: w.y - 10, size: 7, font, color: GRAY });
        h = 14;
      }
      rowH = Math.max(rowH, h);
      col++;
      if (col === 2) {
        w.y -= rowH + 10;
        col = 0;
        rowH = 0;
      }
    }
    if (col !== 0) w.y -= rowH + 10;
  }

  const signature = media.find((m) => m.kind === "signature");
  if (signature) {
    w.heading(t(lang, "pdf.signature"));
    w.ensure(90);
    const bytes = await loadMediaBytes(env, signature);
    if (bytes) {
      const h = await w.image(bytes, signature.content_type, "", 220, 80, MARGIN);
      w.y -= h + 4;
    }
    w.text(`${snap.party?.name ?? snap.performed_by.name}  ·  ${fmtDate(p.performed_at, lang)}`, { size: 8, color: GRAY });
  }

  w.finish(new Date().toISOString(), p.number);
  return doc.save();
}

export async function generateProtocolPdf(env: Env, protocolId: string): Promise<boolean> {
  const p = await one<ProtocolRow>(env.DB, "SELECT * FROM protocols WHERE id = ?", protocolId);
  if (!p) return false;
  if (p.pdf_status === "generated" && p.pdf_media_id) return true;
  try {
    const settings = await loadSettings(env);
    const media = (await env.DB.prepare("SELECT * FROM media WHERE protocol_id = ? AND kind IN ('photo','signature') AND discarded_at IS NULL ORDER BY created_at").bind(protocolId).all<MediaRow>()).results;
    const bytes = await renderProtocolPdf(env, p, media, settings.org_name, settings.pdf_footer);
    const mediaId = await storeGenerated(env, {
      kind: "pdf",
      bytes,
      contentType: "application/pdf",
      filename: `${p.number}.pdf`,
      userId: p.performed_by,
      vehicleId: p.vehicle_id,
      protocolId: p.id,
    });
    await stmt(env.DB, "UPDATE protocols SET pdf_status = 'generated', pdf_media_id = ?, pdf_error = NULL, pdf_attempts = pdf_attempts + 1 WHERE id = ?", mediaId, p.id).run();
    return true;
  } catch (err) {
    console.error("pdf generation failed", p.number, err);
    await stmt(env.DB, "UPDATE protocols SET pdf_status = 'failed', pdf_error = ?, pdf_attempts = pdf_attempts + 1 WHERE id = ?", String((err as Error)?.message ?? err).slice(0, 500), p.id).run();
    return false;
  }
}

/** Runs after a protocol commit: render PDF, then e-mail a copy to the given recipients. */
export async function finalizeProtocol(env: Env, protocolId: string, copyTo: string[]): Promise<void> {
  const ok = await generateProtocolPdf(env, protocolId);
  if (!ok || !copyTo.length) return;
  try {
    const p = await one<ProtocolRow & { org: string }>(env.DB, "SELECT * FROM protocols WHERE id = ?", protocolId);
    if (!p?.pdf_media_id) return;
    const media = await one<MediaRow>(env.DB, "SELECT * FROM media WHERE id = ?", p.pdf_media_id);
    if (!media) return;
    const bytes = await loadMediaBytes(env, media);
    if (!bytes) return;
    const snap = JSON.parse(p.snapshot) as ProtocolSnapshot;
    const settings = await loadSettings(env);
    const vehicle = `${snap.vehicle.internal_number} ${snap.vehicle.manufacturer} ${snap.vehicle.model}`;
    const typeLabel = t(p.language, `protocol.${p.type}`);
    const sent = await sendEmailDetailed(
      env,
      copyTo,
      t(p.language, "email.protocol.subject", { org: settings.org_name, type: typeLabel, number: p.number, vehicle }),
      t(p.language, "email.protocol.body", { number: p.number, type: typeLabel, vehicle, notes: p.notes }),
      [{ filename: `${p.number}.pdf`, type: "application/pdf", content: bytes }],
    );
    await stmt(
      env.DB,
      "INSERT INTO audit_log (id, actor_id, actor_label, action, entity_type, entity_id, vehicle_id, details, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      crypto.randomUUID(),
      null,
      "system",
      sent.ok ? "protocol.emailed" : "protocol.email_failed",
      "protocol",
      p.id,
      p.vehicle_id,
      JSON.stringify(sent.ok ? { to: copyTo } : { to: copyTo, error: sent.error }),
      new Date().toISOString(),
    ).run();
  } catch (err) {
    console.error("protocol email failed", err);
  }
}
