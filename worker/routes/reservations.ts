import { Hono } from "hono";
import { ReservationCancelSchema, ReservationCreateSchema } from "@shared/schemas";
import type { AppVariables, Env } from "../env";
import { parseBody } from "../lib/validate";
import { requireAuth } from "../lib/auth";
import { cancelReservation, createReservation, getReservation, listReservations, toReservation } from "../services/reservations";

const reservations = new Hono<{ Bindings: Env; Variables: AppVariables }>();
reservations.use("*", requireAuth("user"));

reservations.get("/", async (c) => c.json(await listReservations(c.env, new URL(c.req.url))));

reservations.post("/", async (c) => {
  const input = await parseBody(c, ReservationCreateSchema);
  return c.json(await createReservation(c.env, c.get("user"), input, c.get("ip"), c.get("lang")), 201);
});

reservations.get("/:id", async (c) => c.json(toReservation(await getReservation(c.env, c.req.param("id")))));

reservations.post("/:id/cancel", async (c) => {
  const input = await parseBody(c, ReservationCancelSchema);
  return c.json(await cancelReservation(c.env, c.get("user"), c.req.param("id"), input.reason, c.get("ip")));
});

export default reservations;
