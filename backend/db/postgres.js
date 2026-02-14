import pg from "pg";

const { Pool } = pg;

export const pgPool = new Pool({
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "appuser",
  password: process.env.PGPASSWORD || "apppass",
  database: process.env.PGDATABASE || "appdb",
  max: 10,
  idleTimeoutMillis: 30000,
});

pgPool.on("error", (err) => {
  console.error("Unexpected PostgreSQL pool error:", err);
});
