import PDFDocument from "pdfkit";

function toNum(v, def = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function safeArray(v) {
  return Array.isArray(v) ? v : [];
}

function fmtInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? String(Math.round(n)) : "-";
}

function fmt(v, digits = 1, fallback = "n/a") {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return n.toFixed(Math.max(0, Math.min(6, Number(digits) || 1)));
}

function fmtDate(v) {
  try {
    if (!v) return "-";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  } catch {
    return String(v || "-");
  }
}

function toTitle(s) {
  return String(s || "")
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function riskMeta(risk) {
  const x = String(risk || "").toLowerCase();
  if (x.includes("critical")) return { label: "CRITICAL", color: "#991b1b", bg: "#fef2f2", border: "#fecaca" };
  if (x.includes("high")) return { label: "HIGH", color: "#9a3412", bg: "#fff7ed", border: "#fed7aa" };
  if (x.includes("moderate") || x.includes("med")) return { label: "MODERATE", color: "#92400e", bg: "#fffbeb", border: "#fde68a" };
  if (x.includes("low")) return { label: "LOW", color: "#065f46", bg: "#ecfdf5", border: "#a7f3d0" };
  return { label: String(risk || "UNKNOWN").toUpperCase(), color: "#1f2937", bg: "#f9fafb", border: "#e5e7eb" };
}

function drawRoundedRect(doc, x, y, w, h, r = 6, fill = null, stroke = null) {
  doc.save();
  if (fill) doc.fillColor(fill);
  if (stroke) doc.strokeColor(stroke);
  doc.roundedRect(x, y, w, h, r);
  if (fill && stroke) doc.fillAndStroke();
  else if (fill) doc.fill();
  else if (stroke) doc.stroke();
  doc.restore();
}

function drawSectionTitle(doc, title) {
  ensureSpace(doc, 40);
  doc.moveDown(0.5);
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#0f172a").text(title);
  const lineY = doc.y + 3;
  doc.save();
  doc.moveTo(doc.page.margins.left, lineY)
    .lineTo(doc.page.width - doc.page.margins.right, lineY)
    .lineWidth(1)
    .strokeColor("#dbeafe")
    .stroke();
  doc.restore();
  doc.moveDown(0.55);
}

function ensureSpace(doc, needed = 80, top = 40, bottom = 45) {
  const pageBottom = doc.page.height - bottom;
  if (doc.y + needed > pageBottom) {
    doc.addPage();
    doc.y = top;
  }
}

function drawPageFooter(doc) {
  const oldBottom = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  const y = doc.page.height - 22;
  doc.fontSize(8).fillColor("#64748b").text(`Page ${doc.page.number}`, 0, y, { align: "center" });
  doc.page.margins.bottom = oldBottom;
}

function safeText(v, fallback = "-") {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "string") return v.trim() || fallback;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return fallback;
  }
}

function drawCover(doc, { wellId, fromDepth, toDepth, modelUsed, narrativeStatus, createdAtIso, exportedAtIso, risk }) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const bannerY = 38;

  drawRoundedRect(doc, left, bannerY, width, 112, 12, "#0f172a", "#0f172a");
  doc.font("Helvetica-Bold")
    .fontSize(22)
    .fillColor("#f8fafc")
    .text("Interpretation Report", left + 16, bannerY + 16);
  doc.font("Helvetica")
    .fontSize(10.5)
    .fillColor("#cbd5e1")
    .text("Deterministic and narrative interpretation summary for operational review.", left + 16, bannerY + 48, {
      width: width - 32,
    });

  const riskBadgeW = 130;
  drawRoundedRect(doc, left + width - riskBadgeW - 16, bannerY + 16, riskBadgeW, 30, 15, risk.bg, risk.border);
  doc.font("Helvetica-Bold")
    .fontSize(10)
    .fillColor(risk.color)
    .text(`RISK: ${risk.label}`, left + width - riskBadgeW - 10, bannerY + 26, { width: riskBadgeW - 12, align: "center" });

  const metaY = bannerY + 128;
  drawRoundedRect(doc, left, metaY, width, 102, 10, "#f8fafc", "#e2e8f0");

  const rows = [
    ["Well", wellId, "Depth Range", `${fmtInt(fromDepth)} -> ${fmtInt(toDepth)} ft`],
    ["Model", modelUsed, "Narrative Status", narrativeStatus],
    ["Run Time", fmtDate(createdAtIso), "Export Time", fmtDate(exportedAtIso)],
  ];

  let y = metaY + 14;
  rows.forEach((r) => {
    doc.font("Helvetica-Bold").fontSize(9.2).fillColor("#334155").text(r[0], left + 14, y);
    doc.font("Helvetica").fontSize(9.8).fillColor("#0f172a").text(safeText(r[1]), left + 110, y, { width: 150 });
    doc.font("Helvetica-Bold").fontSize(9.2).fillColor("#334155").text(r[2], left + 285, y);
    doc.font("Helvetica").fontSize(9.8).fillColor("#0f172a").text(safeText(r[3]), left + 392, y, { width: 150 });
    y += 28;
  });

  doc.y = metaY + 112;
}

function drawMetricCards(doc, items) {
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const cols = 3;
  const gap = 10;
  const cardW = (width - gap * (cols - 1)) / cols;
  const cardH = 58;
  let x = left;
  let y = doc.y;

  items.forEach((it, idx) => {
    if (idx > 0 && idx % cols === 0) {
      x = left;
      y += cardH + gap;
    }
    drawRoundedRect(doc, x, y, cardW, cardH, 8, it.bg || "#ffffff", it.border || "#e2e8f0");
    doc.font("Helvetica").fontSize(8.8).fillColor("#64748b").text(it.title, x + 10, y + 8, {
      width: cardW - 20,
    });
    doc.font("Helvetica-Bold").fontSize(12).fillColor(it.color || "#0f172a").text(safeText(it.value), x + 10, y + 26, {
      width: cardW - 20,
      ellipsis: true,
    });
    x += cardW + gap;
  });

  const rows = Math.ceil(items.length / cols);
  doc.y = y + cardH + (rows > 1 ? 2 : 0);
}

function drawParagraphCard(doc, title, text, opts = {}) {
  const content = safeText(text, "");
  if (!content) return;
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const padding = 12;
  const fontSize = opts.fontSize || 10.2;
  doc.font("Helvetica").fontSize(fontSize);
  const textH = doc.heightOfString(content, { width: width - padding * 2, align: "left" });
  const titleH = 14;
  const h = Math.max(48, padding + titleH + 6 + textH + padding);

  ensureSpace(doc, h + 8);
  drawRoundedRect(doc, left, doc.y, width, h, 8, opts.bg || "#ffffff", opts.border || "#e2e8f0");
  doc.font("Helvetica-Bold").fontSize(10.2).fillColor("#0f172a").text(title, left + padding, doc.y + padding);
  doc.font("Helvetica").fontSize(fontSize).fillColor("#334155").text(content, left + padding, doc.y + padding + 18, {
    width: width - padding * 2,
    align: "left",
  });
  doc.y += h + 6;
}

function drawBulletsCard(doc, title, items, emptyText) {
  const arr = safeArray(items).map((x) => safeText(x, "")).filter(Boolean);
  if (!arr.length) {
    drawParagraphCard(doc, title, emptyText || "No items provided.");
    return;
  }

  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const padding = 12;
  doc.font("Helvetica").fontSize(10);
  const linesH = arr.reduce((acc, item, idx) => {
    const txt = `${idx + 1}. ${item}`;
    return acc + doc.heightOfString(txt, { width: width - padding * 2 - 8 });
  }, 0);
  const h = Math.max(48, padding + 16 + linesH + 10 + arr.length * 3);

  ensureSpace(doc, h + 8);
  drawRoundedRect(doc, left, doc.y, width, h, 8, "#ffffff", "#e2e8f0");
  doc.font("Helvetica-Bold").fontSize(10.2).fillColor("#0f172a").text(title, left + padding, doc.y + padding);

  let y = doc.y + padding + 18;
  arr.forEach((item, idx) => {
    const txt = `${idx + 1}. ${item}`;
    const th = doc.heightOfString(txt, { width: width - padding * 2 - 8 });
    doc.font("Helvetica").fontSize(10).fillColor("#334155").text(txt, left + padding, y, { width: width - padding * 2 - 8 });
    y += th + 3;
  });
  doc.y += h + 6;
}

function drawKvpSection(doc, title, obj) {
  drawSectionTitle(doc, title);
  const input = obj && typeof obj === "object" ? obj : {};
  const rows = Object.entries(input).map(([k, v]) => {
    if (Array.isArray(v)) return [toTitle(k), v.length ? `${v.length} items` : "-"];
    if (v && typeof v === "object") return [toTitle(k), JSON.stringify(v)];
    return [toTitle(k), safeText(v)];
  });

  if (!rows.length) {
    drawParagraphCard(doc, title, "No fields available.");
    return;
  }

  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colGap = 12;
  const labelW = 170;
  const valueW = width - labelW - colGap - 20;

  rows.forEach(([label, value]) => {
    doc.font("Helvetica").fontSize(10);
    const valueH = doc.heightOfString(String(value), { width: valueW });
    const rowH = Math.max(22, valueH + 10);
    ensureSpace(doc, rowH + 4);
    drawRoundedRect(doc, left, doc.y, width, rowH, 6, "#ffffff", "#e2e8f0");
    doc.font("Helvetica-Bold").fontSize(9.2).fillColor("#334155").text(label, left + 10, doc.y + 7, { width: labelW });
    doc.font("Helvetica").fontSize(9.7).fillColor("#0f172a").text(String(value), left + 10 + labelW + colGap, doc.y + 6, {
      width: valueW,
    });
    doc.y += rowH + 4;
  });
}

function normalizeIntervals(narrativeIntervals, deterministicIntervals) {
  const arr = safeArray(narrativeIntervals).length ? safeArray(narrativeIntervals) : safeArray(deterministicIntervals);

  return arr.map((it, idx) => ({
    idx: idx + 1,
    curve: String(it?.curve || "-"),
    fromDepth: toNum(it?.fromDepth),
    toDepth: toNum(it?.toDepth),
    priority: String(it?.priority || "-"),
    probability: String(it?.probability || "-"),
    stability: String(it?.stability || "-"),
    stabilityScore: toNum(it?.stabilityScore),
    confidence: toNum(it?.confidence),
    reason: String(it?.reason || ""),
    explanation: String(it?.explanation || ""),
    agreement: toNum(it?.agreement),
    width: toNum(it?.width),
  }));
}

function consolidateIntervals(intervals, gapTolerance = 8) {
  const valid = intervals
    .filter((x) => Number.isFinite(x.fromDepth) && Number.isFinite(x.toDepth))
    .map((x) => ({
      ...x,
      fromDepth: Math.min(x.fromDepth, x.toDepth),
      toDepth: Math.max(x.fromDepth, x.toDepth),
    }))
    .sort((a, b) => a.fromDepth - b.fromDepth);

  if (!valid.length) return [];

  const groups = [];
  let current = [valid[0]];
  for (let i = 1; i < valid.length; i++) {
    const prev = current[current.length - 1];
    const next = valid[i];
    if (next.fromDepth <= prev.toDepth + gapTolerance) current.push(next);
    else {
      groups.push(current);
      current = [next];
    }
  }
  groups.push(current);

  return groups.map((g, idx) => {
    const fromDepth = Math.min(...g.map((x) => x.fromDepth));
    const toDepth = Math.max(...g.map((x) => x.toDepth));
    const curves = [...new Set(g.map((x) => x.curve).filter(Boolean))];
    const priorities = [...new Set(g.map((x) => x.priority).filter(Boolean))];
    const probs = [...new Set(g.map((x) => x.probability).filter(Boolean))];
    const stabilities = [...new Set(g.map((x) => x.stability).filter(Boolean))];
    const confs = g.map((x) => x.confidence).filter(Number.isFinite);
    const avgConfidence = confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : null;

    return {
      compositeId: idx + 1,
      fromDepth,
      toDepth,
      width: toDepth - fromDepth,
      intervalCount: g.length,
      curves: curves.join(", "),
      dominantPriority: priorities[0] || "-",
      probabilityMix: probs.join(", ") || "-",
      stabilityMix: stabilities.join(", ") || "-",
      avgConfidence,
    };
  });
}

export function registerInterpretExportPdfRoute(router) {
  router.post("/interpret/export/pdf", async (req, res) => {
    let doc = null;

    try {
      const payload = req.body || {};
      const wellId = String(payload?.well?.wellId || payload?.wellId || "-");
      const range = payload?.range || {};
      const fromDepth = toNum(range?.fromDepth ?? payload?.fromDepth);
      const toDepth = toNum(range?.toDepth ?? payload?.toDepth);

      const modelUsed = String(payload?.modelUsed || "-");
      const narrativeStatus = String(payload?.narrativeStatus || "-");
      const createdAtIso = payload?.createdAt || new Date().toISOString();
      const exportedAtIso = new Date().toISOString();

      const deterministic = payload?.deterministic || {};
      const narrative = payload?.narrative || {};
      const insight = payload?.insight || {};

      const severityBand = deterministic?.severityBand || "UNKNOWN";
      const rMeta = riskMeta(severityBand);
      const intervals = normalizeIntervals(narrative?.interval_explanations, deterministic?.intervalFindings);
      const consolidated = consolidateIntervals(intervals, 8);
      const recommendations = safeArray(narrative?.recommendations);
      const limitations = safeArray(narrative?.limitations);
      const summaryBullets = safeArray(narrative?.summary_bullets);
      const curves = safeArray(payload?.curves).map((x) => safeText(x, "")).filter(Boolean);
      const rawJson = JSON.stringify(payload ?? {}, null, 2);

      const filename = `interpretation_report_${wellId}_${Date.now()}.pdf`;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

      doc = new PDFDocument({
        size: "A4",
        margins: { top: 40, left: 40, right: 40, bottom: 45 },
        bufferPages: true,
        info: {
          Title: `Interpretation Report - ${wellId}`,
          Author: "AI Interpretation Service",
          Subject: "Well Log Interpretation",
        },
      });

      doc.on("error", (e) => {
        console.error("PDFKit error:", e);
        if (!res.headersSent) {
          res.status(500).json({ error: "PDF generation failed" });
        } else {
          try { res.end(); } catch {}
        }
      });

      res.on("close", () => {
        if (doc && !doc.destroyed) {
          try { doc.end(); } catch {}
        }
      });

      doc.pipe(res);

      drawCover(doc, {
        wellId,
        fromDepth,
        toDepth,
        modelUsed,
        narrativeStatus,
        createdAtIso,
        exportedAtIso,
        risk: rMeta,
      });

      drawSectionTitle(doc, "Executive Summary");
      const cards = [
        { title: "Global Risk", value: rMeta.label, color: rMeta.color, bg: rMeta.bg, border: rMeta.border },
        { title: "Events", value: String(deterministic?.eventCount ?? "-"), color: "#111827", bg: "#f9fafb", border: "#e5e7eb" },
        { title: "Detect Conf", value: fmt(deterministic?.detectionConfidence ?? deterministic?.confidence, 3), color: "#111827", bg: "#f9fafb", border: "#e5e7eb" },
        { title: "Severity Conf", value: fmt(deterministic?.severityConfidence, 3), color: "#111827", bg: "#f9fafb", border: "#e5e7eb" },
        { title: "Data Quality", value: String(deterministic?.dataQuality?.qualityBand || "-").toUpperCase(), color: "#111827", bg: "#f9fafb", border: "#e5e7eb" },
        { title: "Null Percent", value: `${fmt(deterministic?.dataQuality?.nullPercent, 1, "-")}%`, color: "#111827", bg: "#f9fafb", border: "#e5e7eb" },
      ];
      drawMetricCards(doc, cards);
      doc.moveDown(0.25);

      drawParagraphCard(
        doc,
        "Interpretation Summary",
        insight?.summaryParagraph || "No summary paragraph provided by interpretation service."
      );
      drawBulletsCard(
        doc,
        "Narrative Highlights",
        summaryBullets,
        "No narrative summary bullets were provided."
      );

      drawSectionTitle(doc, "Selected Curves");
      drawParagraphCard(
        doc,
        "Curves Included",
        curves.length ? curves.join(", ") : "No curve list was included in export payload."
      );

      drawSectionTitle(doc, "Interval Findings");
      if (!intervals.length) {
        drawParagraphCard(doc, "Interval Findings", "No interval findings available.");
      } else {
        intervals.forEach((it, idx) => {
          const line1 = `${idx + 1}. ${safeText(it.curve)} | ${fmtInt(it.fromDepth)} -> ${fmtInt(it.toDepth)} ft`;
          const line2 = `Priority: ${safeText(it.priority)} | Probability: ${safeText(it.probability)} | Stability: ${safeText(it.stability)} | Confidence: ${fmt(it.confidence, 3)}`;
          const notes = [safeText(it.reason, ""), safeText(it.explanation, "")].filter(Boolean).join(" ");
          const content = notes ? `${line2}\n${notes}` : line2;
          drawParagraphCard(doc, line1, content, { fontSize: 9.7 });
        });
      }

      drawSectionTitle(doc, "Consolidated Intervals (Composite)");
      if (!consolidated.length) {
        drawParagraphCard(doc, "Composite", "No composite intervals available.");
      } else {
        consolidated.forEach((c) => {
          drawParagraphCard(
            doc,
            `C${c.compositeId}: ${fmtInt(c.fromDepth)} -> ${fmtInt(c.toDepth)} ft`,
            `Intervals: ${c.intervalCount} | Width: ${fmt(c.width, 1)} ft | Dominant Priority: ${safeText(c.dominantPriority)} | Avg Confidence: ${fmt(c.avgConfidence, 3)}\nCurves: ${safeText(c.curves)}\nProbability Mix: ${safeText(c.probabilityMix)} | Stability Mix: ${safeText(c.stabilityMix)}`,
            { fontSize: 9.7 }
          );
        });
      }

      drawSectionTitle(doc, "Recommendations");
      drawBulletsCard(doc, "Operational Recommendations", recommendations, "No recommendations provided.");

      drawSectionTitle(doc, "Limitations");
      drawBulletsCard(doc, "Interpretation Limitations", limitations, "No limitations provided.");

      drawKvpSection(doc, "Deterministic Details", deterministic);
      drawKvpSection(doc, "Insight Details", insight);
      drawKvpSection(doc, "Narrative Details", narrative);

      drawSectionTitle(doc, "Complete Interpretation JSON (Appendix)");
      const left = doc.page.margins.left;
      const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const lines = rawJson.split("\n");
      doc.font("Courier").fontSize(8.2).fillColor("#0f172a");
      lines.forEach((line) => {
        const h = doc.heightOfString(line || " ", { width });
        ensureSpace(doc, Math.max(12, h + 2));
        doc.text(line, left, doc.y, { width, align: "left" });
      });

      const pageCount = doc.bufferedPageRange().count;
      for (let i = 0; i < pageCount; i++) {
        doc.switchToPage(i);
        drawPageFooter(doc);
      }

      doc.end();
    } catch (err) {
      console.error("POST /api/ai/interpret/export/pdf failed:", err);
      if (!res.headersSent) {
        return res.status(500).json({ error: err?.message || "PDF export failed" });
      }
      try { res.end(); } catch {}
    }
  });
}
