function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireTileLock(redisClient, lockKey, ttlSec = 12) {
  const ok = await redisClient.set(lockKey, "1", { NX: true, EX: ttlSec });
  return ok === "OK";
}

async function releaseTileLock(redisClient, lockKey) {
  try {
    await redisClient.del(lockKey);
  } catch {}
}

async function getOrBuildTileWithLock(
  redisClient,
  tileKey,
  lockKey,
  buildFn,
  waitMs = 60,
  maxWaitLoops = 12
) {
  const cached = await redisClient.get(tileKey);
  if (cached) return { payload: JSON.parse(cached), fromCache: true, built: false };

  const acquired = await acquireTileLock(redisClient, lockKey, 12);
  if (acquired) {
    try {
      const cached2 = await redisClient.get(tileKey);
      if (cached2) return { payload: JSON.parse(cached2), fromCache: true, built: false };

      const payload = await buildFn();
      await redisClient.set(tileKey, JSON.stringify(payload), { EX: 60 * 60 });
      return { payload, fromCache: false, built: true };
    } finally {
      await releaseTileLock(redisClient, lockKey);
    }
  }

  for (let i = 0; i < maxWaitLoops; i += 1) {
    await sleep(waitMs);
    const cached3 = await redisClient.get(tileKey);
    if (cached3) return { payload: JSON.parse(cached3), fromCache: true, built: false };
  }
  return null;
}

export { acquireTileLock, releaseTileLock, getOrBuildTileWithLock };

