import {
  chooseLevel,
  estimatePointsForLevel,
  choosePointBudget,
} from "./windowLevelSelector.js";
import { cacheKeyMeta, cacheKeyTile, tileSpan } from "./windowPerfKeys.js";

function median(vals) {
  const arr = (vals || []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!arr.length) return null;
  const mid = Math.floor(arr.length / 2);
  if (arr.length % 2 === 1) return arr[mid];
  return (arr[mid - 1] + arr[mid]) / 2;
}

async function estimateBaseResolution(db, wellId) {
  const docs = await db
    .collection("well_points")
    .find({ wellId }, { projection: { _id: 0, depth: 1 } })
    .sort({ depth: 1 })
    .limit(600)
    .toArray();

  const depths = docs
    .map((d) => Number(d?.depth))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const diffs = [];
  for (let i = 1; i < depths.length; i += 1) {
    const d = depths[i] - depths[i - 1];
    if (Number.isFinite(d) && d > 0) diffs.push(d);
  }
  return median(diffs) || 1.0;
}

async function getOrBuildMeta(redisClient, db, wellId, metric, defaults) {
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
  const version = Number(well?.version) || 1;
  const baseResolution = await estimateBaseResolution(db, wellId);
  const meta = {
    version,
    baseResolution,
    maxLevel: Number(defaults?.maxLevel ?? 8),
    tileSizeDepth: Number(defaults?.tileSizeDepth ?? 200),
  };
  await redisClient.setEx(key, 60 * 60 * 24, JSON.stringify(meta));
  return meta;
}

async function buildWindowPlan({
  redisClient,
  db,
  wellId,
  metric,
  fromDepth,
  toDepth,
  pixelWidth,
  fallbackBaseResolution = 1.0,
  fallbackMaxLevel = 8,
  fallbackTileSize = 200.0,
}) {
  const meta = await getOrBuildMeta(redisClient, db, wellId, metric, {
    maxLevel: fallbackMaxLevel,
    tileSizeDepth: fallbackTileSize,
  });

  const version = Number(meta?.version ?? 1);
  const baseResolution = Number(meta?.baseResolution ?? fallbackBaseResolution);
  const maxLevel = Number(meta?.maxLevel ?? fallbackMaxLevel);
  const tileSize = Number(meta?.tileSizeDepth ?? fallbackTileSize);

  const [level, budget] = chooseLevel(
    fromDepth,
    toDepth,
    pixelWidth,
    baseResolution,
    maxLevel
  );
  const estPoints = estimatePointsForLevel(fromDepth, toDepth, baseResolution, level);
  const tiles = tileSpan(fromDepth, toDepth, tileSize);

  let hit = 0;
  for (const [ts, te] of tiles) {
    const k = cacheKeyTile(wellId, metric, version, level, ts, te);
    const exists = await redisClient.exists(k);
    if (exists) hit += 1;
  }
  const miss = tiles.length - hit;
  const source = miss === 0 ? "redis" : hit > 0 ? "mixed" : "mongo";

  return {
    wellId,
    metric,
    window: { from: Number(fromDepth), to: Number(toDepth) },
    plan: {
      source,
      levelChosen: level,
      estimatedPoints: estPoints,
      pointBudget: choosePointBudget(pixelWidth),
      tileSizeDepth: tileSize,
      tilesTotal: tiles.length,
      tilesHit: hit,
      tilesMiss: miss,
      version,
      baseResolution,
      targetBudget: budget,
    },
  };
}

export { buildWindowPlan };

