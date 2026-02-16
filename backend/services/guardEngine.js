export function classifyQuestionIntent(message = "") {
  const t = String(message || "").toLowerCase().trim();
  if (!t) return { kind: "general", askedDepth: null, askedCurves: [] };

  if (
    t.includes("summary") ||
    t.includes("overall") ||
    t.includes("tell me about this") ||
    t.includes("what do you think") ||
    t.includes("explain this") ||
    t.includes("insight")
  ) {
    return { kind: "summary", askedDepth: extractDepth(t), askedCurves: extractCurves(t) };
  }

  const askedDepth = extractDepth(t);
  const askedCurves = extractCurves(t);
  if (askedCurves.length && askedDepth != null) return { kind: "curve_depth", askedDepth, askedCurves };
  if (askedCurves.length) return { kind: "curve", askedDepth, askedCurves };
  if (askedDepth != null) return { kind: "depth", askedDepth, askedCurves };
  return { kind: "general", askedDepth: null, askedCurves: [] };
}

function extractDepth(t) {
  const m = String(t || "").match(/\b(\d{3,6}(?:\.\d+)?)\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function extractCurves(t) {
  const matches = String(t || "").match(/\b([a-z]{1,4}\d{1,2}(?:__\d+)?(?:-\d+)?)\b/gi) || [];
  return matches.map((x) => x.toUpperCase().replace("-", "__"));
}

export function validateAgainstContext({
  intent,
  availableCurves = [],
  fromDepth,
  toDepth,
}) {
  const curveSet = new Set((availableCurves || []).map((x) => String(x).toUpperCase()));
  const result = {
    ok: true,
    reason: null,
    missingCurves: [],
    depthOutOfRange: false,
  };

  if (intent?.kind === "summary" || intent?.kind === "general") return result;

  if (intent?.askedCurves?.length) {
    const missing = intent.askedCurves.filter((c) => !curveSet.has(c));
    if (missing.length) {
      result.ok = false;
      result.reason = "missing_curve";
      result.missingCurves = missing;
      return result;
    }
  }

  if (
    intent?.askedDepth != null &&
    Number.isFinite(Number(fromDepth)) &&
    Number.isFinite(Number(toDepth))
  ) {
    const d = Number(intent.askedDepth);
    const lo = Math.min(Number(fromDepth), Number(toDepth));
    const hi = Math.max(Number(fromDepth), Number(toDepth));
    if (d < lo || d > hi) {
      result.ok = false;
      result.reason = "depth_out_of_range";
      result.depthOutOfRange = true;
      return result;
    }
  }

  return result;
}

