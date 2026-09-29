import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { ApiError } from "../lib/errors";

const LOCK_TTL_MS = 30_000;
const WAIT_MAX_MS = 8_000;

/**
 * One instance per vehicle. Serializes state-changing workflows so two phones
 * cannot loan the same vehicle at the same instant.
 */
export class VehicleLock extends DurableObject<Env> {
  private token: string | null = null;
  private expiresAt = 0;

  async acquire(): Promise<string> {
    const start = Date.now();
    while (this.token && Date.now() < this.expiresAt) {
      if (Date.now() - start > WAIT_MAX_MS) throw new Error("busy");
      await new Promise((r) => setTimeout(r, 40));
    }
    this.token = crypto.randomUUID();
    this.expiresAt = Date.now() + LOCK_TTL_MS;
    return this.token;
  }

  async release(token: string): Promise<void> {
    if (this.token === token) {
      this.token = null;
      this.expiresAt = 0;
    }
  }
}

export async function withVehicleLock<T>(env: Env, vehicleId: string, fn: () => Promise<T>): Promise<T> {
  const stub = env.VEHICLE_LOCK.get(env.VEHICLE_LOCK.idFromName(vehicleId)) as unknown as {
    acquire(): Promise<string>;
    release(token: string): Promise<void>;
  };
  let token: string;
  try {
    token = await stub.acquire();
  } catch {
    throw new ApiError(423, "vehicle_busy");
  }
  try {
    return await fn();
  } finally {
    await stub.release(token);
  }
}
