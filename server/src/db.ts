import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "./env.js";
import * as schema from "./schema.js";

// Ensure the directory for the SQLite file exists
mkdirSync(dirname(env.DATABASE_PATH), { recursive: true });

const sqlite = new Database(env.DATABASE_PATH);
sqlite.exec("PRAGMA journal_mode = WAL");
sqlite.exec("PRAGMA foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
