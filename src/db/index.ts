import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { config } from "../config.js";
import * as schema from "./schema.js";

/**
 * Single pg Pool + Drizzle client shared across the process.
 */

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

export const db = drizzle(pool, { schema });

export type Database = typeof db;
export { schema };

/** Graceful shutdown helper. */
export async function closeDb(): Promise<void> {
  await pool.end();
}
