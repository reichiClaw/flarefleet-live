import { Hono } from "hono";
import type { AppVariables, Env } from "../env";
import { ApiError, notFound } from "../lib/errors";
import { loadSettings } from "../lib/settings";
import { getVehicleByQr } from "../services/vehicles";

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

export default pub;
