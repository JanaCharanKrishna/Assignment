function normDepth(x, ndigits = 3) {
  return Number(Number(x).toFixed(ndigits));
}

function tileBounds(depth, tileSize) {
  const start = Math.floor(Number(depth) / Number(tileSize)) * Number(tileSize);
  const end = start + Number(tileSize);
  return [normDepth(start), normDepth(end)];
}

function tileSpan(fromDepth, toDepth, tileSize) {
  const [s] = tileBounds(fromDepth, tileSize);
  const [, eLast] = tileBounds(toDepth, tileSize);
  const out = [];
  let cur = s;
  while (cur < eLast) {
    out.push([normDepth(cur), normDepth(cur + Number(tileSize))]);
    cur += Number(tileSize);
  }
  return out;
}

function cacheKeyTile(wellId, metric, version, level, tileStart, tileEnd) {
  return `pyr:${wellId}:${metric}:v${version}:L${level}:tile:${tileStart}-${tileEnd}`;
}

function cacheKeyTileLock(wellId, metric, version, level, tileStart, tileEnd) {
  return `lock:${cacheKeyTile(wellId, metric, version, level, tileStart, tileEnd)}`;
}

function cacheKeyMeta(wellId, metric) {
  return `pyrmeta:${wellId}:${metric}`;
}

function tileBoundsForWindow(fromDepth, toDepth, tileSize) {
  const start = Math.floor(Number(fromDepth) / Number(tileSize)) * Number(tileSize);
  const end = Math.ceil(Number(toDepth) / Number(tileSize)) * Number(tileSize);
  return [Number(start), Number(end)];
}

function enumerateTiles(start, end, tileSize) {
  const tiles = [];
  let cur = Number(start);
  while (cur < Number(end)) {
    const next = cur + Number(tileSize);
    tiles.push([Number(cur), Number(next)]);
    cur = next;
  }
  return tiles;
}

export {
  normDepth,
  tileBounds,
  tileSpan,
  cacheKeyTile,
  cacheKeyTileLock,
  cacheKeyMeta,
  tileBoundsForWindow,
  enumerateTiles,
};
