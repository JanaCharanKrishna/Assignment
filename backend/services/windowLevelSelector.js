function choosePointBudget(
  pixelWidth,
  factor = 2.0,
  minBudget = 500,
  maxBudget = 12000
) {
  const raw = Math.trunc(Number(pixelWidth) * Number(factor));
  return Math.max(minBudget, Math.min(maxBudget, Number.isFinite(raw) ? raw : minBudget));
}

function estimatePointsForLevel(fromDepth, toDepth, baseResolution, level) {
  const span = Math.max(0, Number(toDepth) - Number(fromDepth));
  if (!Number.isFinite(baseResolution) || Number(baseResolution) <= 0) return 0;
  const decimation = 2 ** Number(level);
  const est = span / (Number(baseResolution) * decimation);
  return Math.max(0, Math.ceil(est));
}

function chooseLevel(fromDepth, toDepth, pixelWidth, baseResolution, maxLevel = 8) {
  const budget = choosePointBudget(pixelWidth);
  for (let lvl = 0; lvl <= Number(maxLevel); lvl += 1) {
    const est = estimatePointsForLevel(fromDepth, toDepth, baseResolution, lvl);
    if (est <= budget) return [lvl, budget];
  }
  return [Number(maxLevel), budget];
}

export { choosePointBudget, estimatePointsForLevel, chooseLevel };

