import "dotenv/config";
import { execSync } from "node:child_process";
import pg from "pg";

const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function requireIdent(value: string, label: string): string {
  if (!IDENT.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return value;
}

function adminDatabaseUrl(databaseUrl: string): { adminUrl: string; dbName: string } {
  const url = new URL(databaseUrl);
  const dbName = requireIdent(url.pathname.replace(/^\//, ""), "database name");
  url.pathname = "/postgres";
  return { adminUrl: url.toString(), dbName };
}

async function ensureDatabase(adminUrl: string, dbName: string, owner: string): Promise<void> {
  const safeOwner = requireIdent(owner, "database owner");

  for (let attempt = 1; attempt <= 30; attempt++) {
    const client = new pg.Client({ connectionString: adminUrl });
    try {
      await client.connect();
      const { rows } = await client.query(
        "SELECT 1 FROM pg_database WHERE datname = $1",
        [dbName],
      );
      if (rows.length === 0) {
        await client.query(`CREATE DATABASE "${dbName}" OWNER "${safeOwner}"`);
        console.log(`Created database "${dbName}"`);
      } else {
        console.log(`Database "${dbName}" already exists`);
      }
      return;
    } catch (err) {
      if (attempt === 30) throw err;
      console.log(`Waiting for postgres... (${attempt}/30)`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } finally {
      await client.end().catch(() => undefined);
    }
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const owner = process.env.POSTGRES_USER ?? "yara";
  const { adminUrl, dbName } = adminDatabaseUrl(databaseUrl);

  await ensureDatabase(adminUrl, dbName, owner);
  execSync("npx drizzle-kit migrate", { stdio: "inherit" });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
