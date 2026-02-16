import {
  cacheKeyMeta,
  cacheKeyTile,
  cacheKeyTileLock,
  tileBoundsForWindow,
  enumerateTiles,
} from "./windowPerfKeys.js";
import { chooseLevel, choosePointBudget } from "./windowLevelSelector.js";
import { downsampleMinmax } from "./windowDownsample.js";
import { getOrBuildTileWithLock } from "./windowTileLock.js";

function cropRows(rows, fromDepth, toDepth) {
  const lo = Math.min(Number(fromDepth), Number(toDepth));
  const hi = Math.max(Number(fromDepth), Number(toDepth));
  return (rows || []).filter((r) => Number(r?.depth) >= lo && Number(r?.depth) <= hi);
}

function mergeRowsPreferRaw(coarseRows, rawRows, fromDepth, toDepth) {
  function dkey(d) {
    return Number(Number(d).toFixed(6));
  }
  const out = new Map();
  const lo = Math.min(Number(fromDepth), Number(toDepth));
  const hi = Math.max(Number(fromDepth), Number(toDepth));

  for (const r of coarseRows || []) {
    const dd = Number(r?.depth);
    if (!Number.isFinite(dd) || dd < lo || dd > hi) continue;
    out.set(dkey(dd), { depth: dd, value: r?.value ?? null, src: "coarse" });
  }

  for (const r of rawRows || []) {
    const dd = Number(r?.depth);
    if (!Number.isFinite(dd) || dd < lo || dd > hi) continue;
    out.set(dkey(dd), { depth: dd, value: r?.value ?? null, src: "raw" });
  }

  const merged = [...out.values()];
  merged.sort((a, b) => Number(a.depth) - Number(b.depth));
  return merged;
}

async function getMeta(redisClient, db, wellId, metric) {
  const key = cacheKeyMeta(wellId, metric);
  const raw = await redisClient.get(key);
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {}
  }

  const well = await db
    .collection("wells")
    .findOne({ wellId }, { projection: { _id: 0, version: 1 } });
  const meta = {
    version: Number(well?.version) || 1,
    baseResolution: 1.0,
    maxLevel: 8,
    tileSizeDepth: 200.0,
  };
  await redisClient.setEx(key, 60 * 60 * 24, JSON.stringify(meta));
  return meta;
}

async function fetchL0RowsFromMongo(db, wellId, metric, fromDepth, toDepth) {
  const lo = Math.min(Number(fromDepth), Number(toDepth));
  const hi = Math.max(Number(fromDepth), Number(toDepth));
  const docs = await db
    .collection("well_points")
    .find(
      { wellId, depth: { $gte: lo, $lte: hi } },
      { projection: { _id: 0, depth: 1, values: 1 } }
    )
    .sort({ depth: 1 })
    .toArray();

  return docs
    .map((d) => ({ depth: Number(d?.depth), value: Number(d?.values?.[metric]) }))
    .filter((r) => Number.isFinite(r.depth) && Number.isFinite(r.value));
}

async function fetchWindowData({
  redisClient,
  db,
  wellId,
  metric,
  fromDepth,
  toDepth,
  pixelWidth,
  fetchL0Rows = null,
}) {
  const t0 = Date.now();
  const meta = await getMeta(redisClient, db, wellId, metric);
  const version = Number(meta?.version ?? 1);
  const baseResolution = Number(meta?.baseResolution ?? 1.0);
  const maxLevel = Number(meta?.maxLevel ?? 8);
  const tileSize = Number(meta?.tileSizeDepth ?? 200.0);
  const [level] = chooseLevel(fromDepth, toDepth, pixelWidth, baseResolution, maxLevel);
  const targetPerWindow = choosePointBudget(pixelWidth, 2.0);

  const [winStart, winEnd] = tileBoundsForWindow(fromDepth, toDepth, tileSize);
  const tiles = enumerateTiles(winStart, winEnd, tileSize);
  const stitched = [];
  let hit = 0;
  let miss = 0;
  let timeoutMiss = 0;

  const fetcher = fetchL0Rows || ((wid, m, f, t) => fetchL0RowsFromMongo(db, wid, m, f, t));

  for (const [ts, te] of tiles) {
    const k = cacheKeyTile(wellId, metric, version, level, ts, te);
    const lockKey = cacheKeyTileLock(wellId, metric, version, level, ts, te);
    const raw = await redisClient.get(k);
    let tileRows = [];
    if (raw) {
      hit += 1;
      try {
        tileRows = JSON.parse(raw)?.rows || [];
      } catch {
        tileRows = [];
      }
    } else {
      miss += 1;
      const built = await getOrBuildTileWithLock(
        redisClient,
        k,
        lockKey,
        async () => {
          const l0Rows = await fetcher(wellId, metric, ts, te);
          const target = l0Rows.length
            ? Math.max(50, Math.floor(l0Rows.length / 2 ** level))
            : 0;
          const rows = downsampleMinmax(l0Rows, target);
          return {
            wellId,
            metric,
            level,
            tileStart: ts,
            tileEnd: te,
            version,
            points: rows.length,
            rows,
          };
        }
      );

      if (built?.payload?.rows) {
        tileRows = built.payload.rows;
      } else {
        timeoutMiss += 1;
        const l0Rows = await fetcher(wellId, metric, ts, te);
        tileRows = downsampleMinmax(l0Rows, Math.max(50, Math.floor((l0Rows.length || 0) / 2 ** level)));
      }
    }
    stitched.push(...tileRows);
  }

  stitched.sort((a, b) => Number(a.depth) - Number(b.depth));
  const dedup = [];
  let prev = null;
  for (const r of stitched) {
    const cur = `${r.depth}|${r.value}`;
    if (cur !== prev) dedup.push(r);
    prev = cur;
  }

  let merged = cropRows(dedup, fromDepth, toDepth);
  if (level > 0 || miss > 0) {
    const rawWindowRows = await fetcher(wellId, metric, fromDepth, toDepth);
    merged = mergeRowsPreferRaw(merged, rawWindowRows, fromDepth, toDepth);
  }
  if (merged.length > targetPerWindow * 3) {
    merged = downsampleMinmax(merged, targetPerWindow * 2);
  }

  const complete = miss === 0 && timeoutMiss === 0;
  const source = complete ? "redis" : hit > 0 ? "mixed" : "mongo";
  const refreshToken = `${wellId}:${metric}:${Number(fromDepth)}:${Number(toDepth)}:v${version}`;
  return {
    ok: true,
    wellId,
    metric,
    range: { fromDepth: Number(fromDepth), toDepth: Number(toDepth) },
    plan: {
      level,
      tileSize,
      estimatedPoints: merged.length,
      tilesRequested: tiles.length,
      tilesHit: hit,
      tilesMiss: miss,
    },
    source,
    completeness: complete ? "complete" : "partial",
    version,
    rows: merged.map((r) => ({ depth: r.depth, value: r.value })),
    refresh: {
      recommended: !complete,
      afterMs: complete ? 0 : 600,
      token: refreshToken,
    },
    meta: {
      pixelBudget: targetPerWindow,
      estimatedPoints: merged.length,
    },
    // backward compatible fields
    window: { from: Number(fromDepth), to: Number(toDepth) },
    levelUsed: level,
    tiles: { total: tiles.length, hit, miss },
    pointsReturned: merged.length,
    debug: {
      latencyMs: {
        total: Date.now() - t0,
      },
    },
  };
}

export { fetchWindowData, fetchL0RowsFromMongo };
