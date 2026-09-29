import { Hono } from "hono";
import type { AppVariables, Env } from "../env";
import { requireAuth } from "../lib/auth";
import { badRequest, notFound } from "../lib/errors";
import { now, one, stmt } from "../lib/db";
import { stageUpload, type MediaRow } from "../services/media";
import { MediaCaptionSchema } from "@shared/schemas";
import { parseBody } from "../lib/validate";

const media = new Hono<{ Bindings: Env; Variables: AppVariables }>();
media.use("*", requireAuth("user"));

/** multipart/form-data: file, kind (photo|signature), caption */
media.post("/", async (c) => {
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw badRequest("validation", { file: "required" });
  const kind = form.get("kind") === "signature" ? "signature" : "photo";
  const caption = String(form.get("caption") ?? "").trim().slice(0, 200);
  const item = await stageUpload(c.env, c.get("user").id, kind, file, file.name || `${kind}.jpg`, caption);
  return c.json(item, 201);
});

media.get("/:id", async (c) => {
  const m = await one<MediaRow>(c.env.DB, "SELECT * FROM media WHERE id = ? AND discarded_at IS NULL", c.req.param("id"));
  if (!m) throw notFound();
  const obj = await c.env.MEDIA.get(m.r2_key);
  if (!obj) throw notFound();
  const headers = new Headers();
  headers.set("content-type", m.content_type);
  headers.set("cache-control", "private, max-age=86400, immutable");
  headers.set("etag", `"${m.sha256}"`);
  if (c.req.query("download") === "1") headers.set("content-disposition", `attachment; filename="${m.filename.replace(/"/g, "")}"`);
  if (c.req.header("if-none-match") === `"${m.sha256}"`) return new Response(null, { status: 304, headers });
  return new Response(obj.body, { headers });
});

media.patch("/:id", async (c) => {
  const input = await parseBody(c, MediaCaptionSchema);
  // Only the uploader may still touch a staged file; attached evidence is immutable.
  const m = await one<MediaRow>(c.env.DB, "SELECT * FROM media WHERE id = ? AND uploaded_by = ? AND attached_at IS NULL", c.req.param("id"), c.get("user").id);
  if (!m) throw notFound();
  await stmt(c.env.DB, "UPDATE media SET caption = ? WHERE id = ?", input.caption, m.id).run();
  return c.json({ ok: true });
});

/** Discards a staged (not yet attached) upload. Attached evidence is immutable. */
media.delete("/:id", async (c) => {
  const m = await one<MediaRow>(
    c.env.DB,
    "SELECT * FROM media WHERE id = ? AND uploaded_by = ? AND attached_at IS NULL AND discarded_at IS NULL",
    c.req.param("id"),
    c.get("user").id,
  );
  if (!m) throw notFound();
  await stmt(c.env.DB, "UPDATE media SET discarded_at = ? WHERE id = ?", now(), m.id).run();
  c.executionCtx.waitUntil(c.env.MEDIA.delete(m.r2_key));
  return c.json({ ok: true });
});

export default media;
