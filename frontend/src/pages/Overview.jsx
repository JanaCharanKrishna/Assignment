import React from "react";
import { useSearchParams } from "react-router-dom";
import { ChartAreaInteractive } from "../components/chart-area-interactive.jsx";
import InterpretationPanel from "../components/app/InterpretationPanel.jsx";
import TimelineStrip from "../components/TimelineStrip.jsx";
import {
  runAiInterpretation,
  exportInterpretationJson,
  downloadInterpretationPdf,
} from "../services/api";
import { isSameRange } from "../components/app/ui.jsx";

function parseWellRange(meta) {
  const minDepth = Number(meta?.minDepth);
  const maxDepth = Number(meta?.maxDepth);
  if (!Number.isFinite(minDepth) || !Number.isFinite(maxDepth) || minDepth === maxDepth) {
    return null;
  }
  return {
    fromDepth: Math.min(minDepth, maxDepth),
    toDepth: Math.max(minDepth, maxDepth),
  };
}

export default function App() {
  const [searchParams] = useSearchParams();
  const preferredWellId = String(searchParams.get("wellId") || "").trim();
  const [selectedWellId, setSelectedWellId] = React.useState(preferredWellId);
  const [selectedMetrics, setSelectedMetrics] = React.useState([]);
  const [zoomDomain, setZoomDomain] = React.useState(null);
  const [selectedWellRange, setSelectedWellRange] = React.useState(null);
  const [viewportRange, setViewportRange] = React.useState(null);

  const [exportingPdf, setExportingPdf] = React.useState(false);
  const [interpLoading, setInterpLoading] = React.useState(false);
  const [interpError, setInterpError] = React.useState("");
  const [interpResult, setInterpResult] = React.useState(null);

  const [lastRunRange, setLastRunRange] = React.useState(null);

  const [selectedInterval, setSelectedInterval] = React.useState(null);
  const [rangeFromInput, setRangeFromInput] = React.useState("");
  const [rangeToInput, setRangeToInput] = React.useState("");
  const handleSelectedWellMetaChange = React.useCallback((meta) => {
    const next = parseWellRange(meta);
    setSelectedWellRange((prev) => {
      if (!next && !prev) return prev;
      if (!next || !prev) return next;
      if (prev.fromDepth === next.fromDepth && prev.toDepth === next.toDepth) return prev;
      return next;
    });
  }, []);

  React.useEffect(() => {
    if (preferredWellId && preferredWellId !== selectedWellId) {
      setSelectedWellId(preferredWellId);
    }
  }, [preferredWellId, selectedWellId]);

  React.useEffect(() => {
    setViewportRange(null);
  }, [selectedWellId]);

  React.useEffect(() => {
    if (Array.isArray(zoomDomain) && zoomDomain.length === 2) {
      const lo = Math.min(Number(zoomDomain[0]), Number(zoomDomain[1]));
      const hi = Math.max(Number(zoomDomain[0]), Number(zoomDomain[1]));
      if (Number.isFinite(lo) && Number.isFinite(hi)) {
        setRangeFromInput(String(lo));
        setRangeToInput(String(hi));
      }
    } else if (
      selectedWellRange &&
      Number.isFinite(Number(selectedWellRange.fromDepth)) &&
      Number.isFinite(Number(selectedWellRange.toDepth))
    ) {
      setRangeFromInput(String(selectedWellRange.fromDepth));
      setRangeToInput(String(selectedWellRange.toDepth));
    } else {
      setRangeFromInput("");
      setRangeToInput("");
    }
  }, [zoomDomain, selectedWellRange]);

  function buildExportPayload() {
    return {
      runId: interpResult?.runId ?? null,
      createdAt: interpResult?.createdAt ?? new Date().toISOString(),
      modelUsed: interpResult?.modelUsed ?? null,
      narrativeStatus: interpResult?.narrativeStatus ?? null,
      well: interpResult?.well ?? { wellId: selectedWellId || "-" },
      range: interpResult?.range ?? lastRunRange ?? null,
      curves: interpResult?.curves ?? selectedMetrics ?? [],
      deterministic: interpResult?.deterministic ?? null,
      insight: interpResult?.insight ?? null,
      narrative: interpResult?.narrative ?? null,
    };
  }

  function handleExportJson() {
    try {
      if (!interpResult) throw new Error("No interpretation result to export");
      const payload = buildExportPayload();
      const wellId = String(payload?.well?.wellId || "well").replace(/[^\w\-]+/g, "_");
      exportInterpretationJson(payload, `interpretation_report_${wellId}.json`);
    } catch (e) {
      setInterpError(e?.message || "JSON export failed");
    }
  }

  async function handleExportPdf() {
    try {
      if (!interpResult) throw new Error("No interpretation result to export");
      setInterpError("");
      setExportingPdf(true);
      const payload = buildExportPayload();
      await downloadInterpretationPdf(payload);
    } catch (e) {
      setInterpError(e?.message || "PDF export failed");
    } finally {
      setExportingPdf(false);
    }
  }

  async function handleRunInterpretation() {
    try {
      setInterpError("");
      setInterpLoading(true);

      if (!selectedWellId) throw new Error("Select a well first");
      if (!selectedMetrics || selectedMetrics.length === 0) throw new Error("Select at least one curve");

      const z0 = Array.isArray(zoomDomain) ? Number(zoomDomain[0]) : NaN;
      const z1 = Array.isArray(zoomDomain) ? Number(zoomDomain[1]) : NaN;
      const hasZoomRange = Number.isFinite(z0) && Number.isFinite(z1) && z0 !== z1;
      const fromDepth = hasZoomRange
        ? Math.min(z0, z1)
        : Number(selectedWellRange?.fromDepth);
      const toDepth = hasZoomRange
        ? Math.max(z0, z1)
        : Number(selectedWellRange?.toDepth);
      if (!Number.isFinite(fromDepth) || !Number.isFinite(toDepth)) {
        throw new Error("Well depth range is not ready yet. Please wait a moment and retry.");
      }

      const res = await runAiInterpretation({
        wellId: selectedWellId,
        fromDepth,
        toDepth,
        curves: selectedMetrics,
      });

      setLastRunRange({ fromDepth, toDepth });
      setInterpResult(res);
      setSelectedInterval(null);
    } catch (e) {
      setInterpError(e?.message || "Interpretation failed");
    } finally {
      setInterpLoading(false);
    }
  }

  function handleJumpToInterval(fromDepth, toDepth) {
    const f = Number(fromDepth);
    const t = Number(toDepth);
    if (!Number.isFinite(f) || !Number.isFinite(t)) return;
    const lo = Math.min(f, t);
    const hi = Math.max(f, t);

    setZoomDomain([lo, hi]);
    setSelectedInterval({ fromDepth: lo, toDepth: hi });
  }

  function handleJumpToDepth(depth) {
    const d = Number(depth);
    if (!Number.isFinite(d)) return;
    const half = 30;
    const lo = d - half;
    const hi = d + half;
    setZoomDomain([lo, hi]);
    setSelectedInterval({ fromDepth: lo, toDepth: hi });
  }

  function handleClearResults() {
    setInterpResult(null);
    setInterpError("");
    setLastRunRange(null);
    setSelectedInterval(null);
  }

  function handleApplyDepthRange() {
    const from = Number(rangeFromInput);
    const to = Number(rangeToInput);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      setInterpError("Enter valid depth numbers to apply range");
      return;
    }
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    setInterpError("");
    setZoomDomain([lo, hi]);
    setSelectedInterval({ fromDepth: lo, toDepth: hi });
  }

  function handleResetDepthRange() {
    setZoomDomain(null);
    setViewportRange(null);
    setSelectedInterval(null);
    setInterpError("");
  }

  const det = interpResult?.deterministic || null;
  const nar = interpResult?.narrative || null;
  const insight = interpResult?.insight || null;

  const viewRange =
    zoomDomain?.length === 2
      ? {
          fromDepth: Math.min(Number(zoomDomain[0]), Number(zoomDomain[1])),
          toDepth: Math.max(Number(zoomDomain[0]), Number(zoomDomain[1])),
        }
      : null;
  const defaultRange = selectedWellRange || lastRunRange || null;

  const isStale = !!interpResult && !!viewRange && !!lastRunRange && !isSameRange(viewRange, lastRunRange);
  const summaryCards = [
    {
      title: "Global Risk",
      value: det?.severityBand ? String(det.severityBand).toUpperCase() : "-",
      hint: "Overall risk classification",
    },
    {
      title: "Data Quality",
      value: det?.dataQuality?.qualityBand || "-",
      hint: `Null ${typeof det?.dataQuality?.nullPercent === "number" ? det.dataQuality.nullPercent.toFixed(1) : "-"}%`,
    },
    {
      title: "Detected Events",
      value: typeof det?.eventCount === "number" ? String(det.eventCount) : "-",
      hint: "Consolidated interval findings",
    },
    {
      title: "Detection Confidence",
      value: typeof det?.detectionConfidence === "number" ? det.detectionConfidence.toFixed(3) : "-",
      hint: "Model confidence score",
    },
  ];

  return (
    <main className="min-h-screen w-full p-3 md:p-5">
      <div className="w-full">
        <section className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {summaryCards.map((card) => (
              <div key={card.title} className="dash-panel">
                <p className="text-sm text-zinc-400">{card.title}</p>
                <p className="mt-2 text-3xl font-bold tracking-tight text-zinc-100">{card.value}</p>
                <p className="mt-2 text-xs text-zinc-500">{card.hint}</p>
              </div>
            ))}
          </div>

          <div className="dash-panel">
            <div className="mb-3 rounded-xl border border-white/10 bg-zinc-900/40 p-3">
              <div className="mb-2 text-sm font-semibold text-zinc-200">Depth Range</div>
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex min-w-[150px] flex-1 flex-col gap-1 text-xs text-zinc-400">
                  From Depth
                  <input
                    type="number"
                    value={rangeFromInput}
                    onChange={(e) => setRangeFromInput(e.target.value)}
                    className="dash-input"
                    placeholder="e.g. 12450"
                  />
                </label>
                <label className="flex min-w-[150px] flex-1 flex-col gap-1 text-xs text-zinc-400">
                  To Depth
                  <input
                    type="number"
                    value={rangeToInput}
                    onChange={(e) => setRangeToInput(e.target.value)}
                    className="dash-input"
                    placeholder="e.g. 12780"
                  />
                </label>
                <button type="button" onClick={handleApplyDepthRange} className="dash-btn-primary">
                  Apply Range
                </button>
                <button type="button" onClick={handleResetDepthRange} className="dash-btn">
                  Reset
                </button>
              </div>
            </div>

            <ChartAreaInteractive
              selectedWellId={selectedWellId}
              onSelectedWellIdChange={setSelectedWellId}
              selectedMetrics={selectedMetrics}
              onSelectedMetricsChange={setSelectedMetrics}
              zoomDomain={zoomDomain}
              onZoomDomainChange={setZoomDomain}
              onSelectedWellMetaChange={handleSelectedWellMetaChange}
              onViewportRangeChange={setViewportRange}
            />

            <TimelineStrip
              wellId={selectedWellId}
              fromDepth={viewportRange?.fromDepth ?? viewRange?.fromDepth ?? defaultRange?.fromDepth}
              toDepth={viewportRange?.toDepth ?? viewRange?.toDepth ?? defaultRange?.toDepth}
              curves={selectedMetrics}
              bucketSize={10}
              onBucketClick={(bucket) => handleJumpToInterval(bucket.from, bucket.to)}
            />
          </div>

          <InterpretationPanel
            selectedWellId={selectedWellId}
            selectedMetrics={selectedMetrics}
            lastRunRange={lastRunRange}
            interpResult={interpResult}
            selectedInterval={selectedInterval}
            onIntervalPick={setSelectedInterval}
            interpLoading={interpLoading}
            exportingPdf={exportingPdf}
            interpError={interpError}
            isStale={isStale}
            viewRange={viewRange}
            det={det}
            nar={nar}
            insight={insight}
            onRunInterpretation={handleRunInterpretation}
            onClearResults={handleClearResults}
            onExportJson={handleExportJson}
            onExportPdf={handleExportPdf}
            onJumpToInterval={handleJumpToInterval}
            onJumpToDepth={handleJumpToDepth}
          />
        </section>
      </div>
    </main>
  );
}

