function isSectionHeader(line) {
  return line.trim().startsWith("~");
}

function sectionName(line) {
  return line.trim().slice(1).split(/\s+/)[0].toLowerCase(); // "~Curve" -> "curve"
}

function parseNullValue(lines) {
  // Looks for: NULL.  -9999 : Null value
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    if (/^null\b/i.test(t)) {
      const m = t.match(/(-?\d+(\.\d+)?)/);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

function extractTrackNumber(desc) {
  const m = String(desc || "").match(/Track\s*#\s*(\d+)/i);
  return m ? m[1] : null;
}

function parseCurveLine(line) {
  // Handles:
  // Depth.UNKN : Track # 0
  // HC1.UNKN   : Track # 2
  // ROP.       : Track # 104
  const raw = line.trim();
  if (!raw || raw.startsWith("#")) return null;

  const [left, descPart] = raw.split(":");
  const description = (descPart || "").trim();

  // mnemonic + unit
  const m = left.trim().match(/^([A-Za-z0-9_]+)\s*\.?\s*([A-Za-z0-9/%\-\+\*]+)?/);
  if (!m) return null;

  const name = m[1];
  const unit = (m[2] || "").trim();
  const track = extractTrackNumber(description);

  // avoid duplicates
  const id = track ? `${name}__${track}` : name;

  return { id, name, unit, description, track };
}

function isTimeCurve(curve, depthCurveId) {
  const id = String(curve?.id || "").trim().toUpperCase();
  const name = String(curve?.name || "").trim().toUpperCase();
  if (!id && !name) return false;
  if (depthCurveId && String(depthCurveId).toUpperCase() === id) return false;
  return id === "TIME" || id.startsWith("TIME__") || name === "TIME";
}

function parseAsciiRows(lines, curveOrderIds, nullValue) {
  const rows = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    if (isSectionHeader(t)) break;

    const parts = t.split(/\s+/);
    if (parts.length < 2) continue;

    const nums = parts.map((x) => {
      const v = Number(x);
      if (Number.isNaN(v)) return null;
      if (nullValue !== null && v === nullValue) return null;
      return v;
    });

    const depth = nums[0];
    if (depth === null) continue;

    const curves = {};
    for (let i = 1; i < curveOrderIds.length && i < nums.length; i++) {
      curves[curveOrderIds[i]] = nums[i];
    }

    rows.push({ depth, curves });
  }
  return rows;
}

export function parseLasText(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");

  let current = null;
  const sections = {
    version: [],
    well: [],
    curve: [],
    parameter: [],
    other: [],
    ascii: [],
  };

  for (const line of lines) {
    const t = line.trim();
    if (isSectionHeader(t)) {
      current = sectionName(t);
      continue;
    }
    if (!current) continue;

    if (current in sections) sections[current].push(line);
    else if (current.startsWith("a")) sections.ascii.push(line); // ~A / ~ASCII
  }

  const nullValue = parseNullValue(sections.well.concat(sections.parameter));

  // Parse curves
  const curves = [];
  for (const line of sections.curve) {
    const c = parseCurveLine(line);
    if (c) curves.push(c);
  }
  if (!curves.length) throw new Error("No curves found in ~Curve section");

  const curveOrderIds = curves.map((c) => c.id);

  const depthCurveId = curveOrderIds[0];
  if (!depthCurveId) throw new Error("Could not determine depth curve");

  const rows = parseAsciiRows(sections.ascii, curveOrderIds, nullValue);
  if (!rows.length) throw new Error("No data rows found in ~Ascii section");

  // Parse all columns for positional integrity, then remove TIME curves from exposed output.
  const timeCurveIds = new Set(
    curves
      .filter((c) => isTimeCurve(c, depthCurveId))
      .map((c) => c.id)
  );
  if (timeCurveIds.size) {
    for (const r of rows) {
      for (const id of timeCurveIds) {
        delete r.curves[id];
      }
    }
  }
  const visibleCurves = curves.filter((c) => !timeCurveIds.has(c.id));

  // depth range
  let minDepth = Infinity;
  let maxDepth = -Infinity;
  for (const r of rows) {
    if (typeof r.depth === "number") {
      if (r.depth < minDepth) minDepth = r.depth;
      if (r.depth > maxDepth) maxDepth = r.depth;
    }
  }

  return {
    curves: visibleCurves,
    nullValue,
    depthCurveId,
    minDepth,
    maxDepth,
    rows,
  };
}
