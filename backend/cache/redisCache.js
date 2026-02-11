import { getRedis } from "../db/redis.js";

export async function cacheGetJson(key) {
  const r = getRedis();
  const raw = await r.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function cacheSetJson(key, value, ttlSeconds = 1800) {
  const r = getRedis();
  const raw = JSON.stringify(value);
  await r.setEx(key, ttlSeconds, raw);
}
