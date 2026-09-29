import type { Paginated } from "@shared/types";

export const now = () => new Date().toISOString();
export const uid = () => crypto.randomUUID();

/** Time-sortable id for audit rows (ms timestamp + random). */
export function ulid(): string {
  const ts = Date.now().toString(36).padStart(9, "0");
  const rnd = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(36).padStart(2, "0"))
    .join("");
  return `${ts}${rnd}`;
}

export type Row = Record<string, unknown>;

export async function one<T = Row>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  const r = await db.prepare(sql).bind(...params).first<T>();
  return r ?? null;
}

export async function all<T = Row>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const r = await db.prepare(sql).bind(...params).all<T>();
  return r.results;
}

export async function run(db: D1Database, sql: string, ...params: unknown[]): Promise<D1Result> {
  return db.prepare(sql).bind(...params).run();
}

export function stmt(db: D1Database, sql: string, ...params: unknown[]): D1PreparedStatement {
  return db.prepare(sql).bind(...params);
}

/** Atomic sequence allocation (SQLite UPDATE ... RETURNING). */
export async function nextSequence(db: D1Database, name: string): Promise<number> {
  const [first] = await reserveSequence(db, name, 1);
  return first;
}

/**
 * Reserves `count` consecutive sequence values in one round trip. Bulk callers
 * (import commit) would otherwise spend one query per row.
 */
export async function reserveSequence(db: D1Database, name: string, count: number): Promise<number[]> {
  const n = Math.max(1, Math.floor(count));
  const r = await db
    .prepare("UPDATE sequences SET next_value = next_value + ? WHERE name = ? RETURNING next_value - ? AS v")
    .bind(n, name, n)
    .first<{ v: number }>();
  if (!r) throw new Error(`sequence ${name} missing`);
  return Array.from({ length: n }, (_, i) => Number(r.v) + i);
}

export function parsePage(url: URL, defaultSize = 25): { page: number; size: number; offset: number } {
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const size = Math.min(100, Math.max(1, Number(url.searchParams.get("page_size") ?? defaultSize) || defaultSize));
  return { page, size, offset: (page - 1) * size };
}

export async function paginate<T>(
  db: D1Database,
  baseSql: string,
  params: unknown[],
  orderBy: string,
  page: { page: number; size: number; offset: number },
): Promise<Paginated<T>> {
  const countRow = await db.prepare(`SELECT COUNT(*) AS c FROM (${baseSql})`).bind(...params).first<{ c: number }>();
  const rows = await db
    .prepare(`${baseSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .bind(...params, page.size, page.offset)
    .all<T>();
  return { count: countRow?.c ?? 0, page: page.page, page_size: page.size, results: rows.results };
}

export const bool = (v: unknown) => v === 1 || v === true || v === "1";
export const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== "string") return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};
