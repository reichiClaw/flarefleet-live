import { Hono } from "hono";
import type { AppVariables, Env } from "../env";
import { ApiError, notFound } from "../lib/errors";
import { one } from "../lib/db";
import { loadSettings } from "../lib/settings";
import { getVehicleByQr } from "../services/vehicles";
import { PDF_LINK_PREFIX } from "../services/pdf";
import type { MediaRow } from "../services/media";

const pub = new Hono<{ Bindings: Env; Variables: AppVariables }>();

/**
 * Public QR landing: minimal, non-sensitive vehicle info so that anyone who
 * scans the sticker knows which vehicle it is. Signed-in users get redirected
 * to the full detail page by the SPA.
 */
pub.get("/qr/:code", async (c) => {
  const settings = await loadSettings(c.env);
  const signedIn = !!c.get("user");
  const v = await getVehicleByQr(c.env, c.req.param("code"), signedIn);
  if (!v) throw notFound();
  if (!settings.public_qr_page && !signedIn) throw new ApiError(403, "public_qr_disabled");
  return c.json({
    id: c.get("user") ? v.id : undefined,
    org_name: settings.org_name,
    internal_number: v.internal_number,
    manufacturer: v.manufacturer,
    model: v.model,
    category_name: v.category_name,
    status: v.status,
    license_plate: v.license_plate,
    signed_in: !!c.get("user"),
  });
});

/**
 * Download behind the link from a protocol copy whose PDF was too large to
 * attach. The token stands for one protocol, expires with its KV entry and is
 * the only credential such a recipient can have.
 */
pub.get("/protocol-pdf/:token", async (c) => {
  const token = c.req.param("token");
  const protocolId = /^[0-9a-f]{32,64}$/.test(token) ? await c.env.KV.get(`${PDF_LINK_PREFIX}${token}`) : null;
  if (!protocolId) throw notFound();
  const p = await one<{ number: string; pdf_media_id: string | null }>(c.env.DB, "SELECT number, pdf_media_id FROM protocols WHERE id = ?", protocolId);
  if (!p?.pdf_media_id) throw notFound();
  const media = await one<MediaRow>(c.env.DB, "SELECT * FROM media WHERE id = ?", p.pdf_media_id);
  const obj = media ? await c.env.MEDIA.get(media.r2_key) : null;
  if (!obj) throw notFound();
  return new Response(obj.body, {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${p.number}.pdf"`,
      "cache-control": "private, no-store",
    },
  });
});

export default pub;
