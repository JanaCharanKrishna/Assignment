import { createClient } from "redis";

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

let redis;

export async function connectRedis() {
  if (redis?.isOpen) return redis;

  redis = createClient({ url: REDIS_URL });

  redis.on("error", (err) => {
    console.error("Redis error:", err.message);
  });

  await redis.connect();
  console.log("✅ Redis connected");
  return redis;
}

export function getRedis() {
  if (!redis?.isOpen) throw new Error("Redis not connected. Call connectRedis() first.");
  return redis;
}
