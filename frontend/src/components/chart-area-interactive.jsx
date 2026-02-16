import React from "react";
import Plot from "react-plotly.js";
import ChartControls from "./chart/ChartControls.jsx";
import { API_BASE, COLORS, metricLabel, metricsQuery, safeJson } from "./chart/chart-utils";

export function ChartAreaInteractive({
  selectedWellId: selectedWellIdProp,
  onSelectedWellIdChange,
  selectedMetrics: selectedMetricsProp,
  onSelectedMetricsChange,
  zoomDomain: zoomDomainProp,
  onZoomDomainChange,
}) {
  const [wells, setWells] = React.useState([]);
  const [selectedWellIdInternal, setSelectedWellIdInternal] = React.useState("");
  const [selectedMetricsInternal, setSelectedMetricsInternal] = React.useState([]);
  const [rows, setRows] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [uploading, setUploading] = React.useState(false);
  const [uploadMsg, setUploadMsg] = React.useState("");
  const [xRangeInternal, setXRangeInternal] = React.useState(null);
  const [dragMode, setDragMode] = React.useState("zoom");
  const [rangePickMode, setRangePickMode] = React.useState(false);
  const [rangePickStart, setRangePickStart] = React.useState(null);

  const abortRef = React.useRef(null);
  const debounceRef = React.useRef(null);
  const fileInputRef = React.useRef(null);
  const lastFetchedRangeRef = React.useRef(null);
  const plotWrapRef = React.useRef(null);
  const isPointerDownRef = React.useRef(false);
  const pendingRangeRef = React.useRef(null);

  const selectedWellId = selectedWellIdProp ?? selectedWellIdInternal;
  const setSelectedWellId = React.useCallback(
    (v) => {
      if (onSelectedWellIdChange) onSelectedWellIdChange(v);
      if (selectedWellIdProp === undefined) setSelectedWellIdInternal(v);
    },
    [onSelectedWellIdChange, selectedWellIdProp]
  );

  const selectedMetrics = selectedMetricsProp ?? selectedMetricsInternal;
  const setSelectedMetrics = React.useCallback(
    (vOrFn) => {
      const next = typeof vOrFn === "function" ? vOrFn(selectedMetrics) : vOrFn;
      if (onSelectedMetricsChange) onSelectedMetricsChange(next);
      if (selectedMetricsProp === undefined) setSelectedMetricsInternal(next);
    },
    [onSelectedMetricsChange, selectedMetrics, selectedMetricsProp]
  );

  const xRange = zoomDomainProp ?? xRangeInternal;
  const setXRange = React.useCallback(
    (v) => {
      if (onZoomDomainChange) onZoomDomainChange(v);
      if (zoomDomainProp === undefined) setXRangeInternal(v);
    },
    [onZoomDomainChange, zoomDomainProp]
  );

  const selectedWell = React.useMemo(() => wells.find((w) => w.wellId === selectedWellId), [wells, selectedWellId]);
  const curves = selectedWell?.curves || [];
  const allMetrics = selectedWell?.metrics || [];
  const meta = selectedWell || {};

  const curveMap = React.useMemo(() => {
    const m = new Map();
    for (const c of curves) m.set(c.id, c);
    return m;
  }, [curves]);

  const colorMap = React.useMemo(() => {
    const m = new Map();
    allMetrics.forEach((id, i) => m.set(id, COLORS[i % COLORS.length]));
    return m;
  }, [allMetrics]);

  function cancelInFlight() {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }

  async function loadWells(preferredWellId = null) {
    const json = await safeJson(`${API_BASE}/api/wells`);
    const list = Array.isArray(json?.wells) ? json.wells : [];
    setWells(list);
    if (!list.length) return;

    const preferred = preferredWellId
      ? list.find((w) => w.wellId === preferredWellId)
      : null;
    const first = preferred || list[0];

    if (!selectedWellId || preferred) setSelectedWellId(first.wellId);

    const ms = first.metrics || [];
    if (preferred || !selectedMetrics?.length) {
      setSelectedMetrics(ms.slice(0, Math.min(2, ms.length)));
    }
  }

  async function retryLoadWells() {
    setLoading(true);
    setError("");
    try {
      await loadWells(selectedWellId || null);
    } catch (e) {
      setError(e?.message || "Failed to load wells");
    } finally {
      setLoading(false);
    }
  }

  async function uploadLasFile(file) {
    if (!file) return;
    const name = String(file.name || "").toLowerCase();
    if (!name.endsWith(".las")) {
      setUploadMsg("Please upload a .las file.");
      return;
    }

    try {
      setUploading(true);
      setUploadMsg("");
      setError("");

      const fd = new FormData();
      fd.append("file", file);

      const res = await fetch(`${API_BASE}/api/las/upload`, {
        method: "POST",
        body: fd,
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {}

      if (!res.ok) {
        throw new Error(json?.error || text || `Upload failed (${res.status})`);
      }

      const newWellId = json?.well?.wellId || null;
      await loadWells(newWellId);
      setUploadMsg(`Uploaded ${file.name} successfully.`);
    } catch (e) {
      setUploadMsg(e?.message || "LAS upload failed");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function fetchOverview(wellId, metrics, target = 1200) {
    cancelInFlight();
    const ac = new AbortController();
    abortRef.current = ac;
    const m = metricsQuery(metrics);
    const url = `${API_BASE}/api/well/${wellId}/overview?metrics=${m}&target=${target}`;
    return safeJson(url, ac.signal);
  }

  async function fetchWindow(wellId, metrics, from, to, px = 1200) {
    cancelInFlight();
    const ac = new AbortController();
    abortRef.current = ac;
    const m = metricsQuery(metrics);
    const url = `${API_BASE}/api/well/${wellId}/window?metrics=${m}&from=${from}&to=${to}&px=${px}`;
    return safeJson(url, ac.signal);
  }

  function scheduleWindowFetch(from, to) {
    if (!selectedWellId || !selectedMetrics.length) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const lo = Math.min(Number(from), Number(to));
    const hi = Math.max(Number(from), Number(to));
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) return;

    const prev = lastFetchedRangeRef.current;
    if (
      prev &&
      Math.abs(prev.from - lo) <= 0.25 &&
      Math.abs(prev.to - hi) <= 0.25
    ) {
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setError("");
      try {
        const win = await fetchWindow(selectedWellId, selectedMetrics, lo, hi, 1200);
        setRows(win.rows || []);
        lastFetchedRangeRef.current = { from: lo, to: hi };
      } catch (e) {
        if (String(e?.name) === "AbortError") return;
        setError(e.message || "Window fetch failed");
      }
    }, 320);
  }

  React.useEffect(() => {
    (async () => {
      setLoading(true);
      setError("");
      try {
        let lastErr = null;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            await loadWells(null);
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e;
            if (attempt < 3) {
              // Backend may still be booting; retry a couple of times.
              await new Promise((r) => setTimeout(r, attempt * 500));
            }
          }
        }
        if (lastErr) throw lastErr;
      } catch (e) {
        setError(e.message || "Failed to load wells");
      } finally {
        setLoading(false);
      }
    })();

    return () => cancelInFlight();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    if (!allMetrics.length) return;
    const valid = (selectedMetrics || []).filter((m) => allMetrics.includes(m));
    if (valid.length !== (selectedMetrics || []).length) {
      if (valid.length > 0) setSelectedMetrics(valid);
      else setSelectedMetrics(allMetrics.slice(0, Math.min(2, allMetrics.length)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWellId, allMetrics.join("|")]);

  React.useEffect(() => {
    if (!selectedWellId || !selectedMetrics.length) return;

    setXRange(null);

    (async () => {
      setLoading(true);
      setError("");
      try {
        const ov = await fetchOverview(selectedWellId, selectedMetrics, 1200);
        setRows(ov.rows || []);
      } catch (e) {
        if (String(e?.name) === "AbortError") return;
        setError(e.message || "Overview failed");
        setRows([]);
      } finally {
        setLoading(false);
      }
    })();

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWellId, selectedMetrics.join("|")]);

  const plotData = React.useMemo(() => {
    const dense = (rows || []).length > 8000;
    const depth = [];
    const series = new Map();
    for (const m of selectedMetrics) series.set(m, []);

    for (const r of rows || []) {
      const d = Number(r?.depth);
      if (!Number.isFinite(d)) continue;
      depth.push(d);

      const values = r?.values || {};
      for (const m of selectedMetrics) {
        const v = values[m];
        series.get(m).push(v == null ? null : Number(v));
      }
    }

    return selectedMetrics.map((m) => {
      const color = colorMap.get(m) || "#2563eb";
      const label = metricLabel(curveMap.get(m)) || m;

      return {
        type: "scattergl",
        mode: "lines",
        name: label,
        x: depth,
        y: series.get(m) || [],
        line: { color, width: 2 },
        connectgaps: false,
        hoverinfo: dense ? "skip" : "x+y+name",
        hovertemplate: dense ? undefined : "Depth: %{x}<br>" + label + ": %{y}<extra></extra>",
      };
    });
  }, [rows, selectedMetrics, colorMap, curveMap]);

  const denseWindow = (rows || []).length > 8000;

  const fullDomain = React.useMemo(() => {
    const min = Number(meta?.minDepth);
    const max = Number(meta?.maxDepth);
    if (Number.isFinite(min) && Number.isFinite(max) && min !== max) return [min, max];

    const depths = (rows || []).map((r) => Number(r?.depth)).filter(Number.isFinite);
    if (!depths.length) return [0, 1];
    depths.sort((a, b) => a - b);
    return [depths[0], depths[depths.length - 1]];
  }, [meta?.minDepth, meta?.maxDepth, rows]);

  const uiRevision = React.useMemo(
    () => `${selectedWellId || "no-well"}|${selectedMetrics.join(",") || "no-curves"}`,
    [selectedWellId, selectedMetrics]
  );

  function resetZoom() {
    setXRange(null);
    setSelectedMetrics([]);
    setRangePickMode(false);
    setRangePickStart(null);
    scheduleWindowFetch(fullDomain[0], fullDomain[1]);
  }

  function toggleMetric(metricId, checked) {
    setSelectedMetrics((prev) => {
      if (checked) return prev.includes(metricId) ? prev : [...prev, metricId];
      return prev.filter((m) => m !== metricId);
    });
  }

  const selectedSummary =
    selectedMetrics.length === 0
      ? "Select curves"
      : selectedMetrics.length <= 2
      ? selectedMetrics.map((m) => metricLabel(curveMap.get(m)) || m).join(", ")
      : `${selectedMetrics.length} curves selected`;

  function onRelayout(e) {
    const x0 = e["xaxis.range[0]"];
    const x1 = e["xaxis.range[1]"];

    if (e["xaxis.autorange"] === true) {
      setXRange(null);
      scheduleWindowFetch(fullDomain[0], fullDomain[1]);
      return;
    }

    if (x0 != null && x1 != null) {
      const a = Number(x0);
      const b = Number(x1);
      if (Number.isFinite(a) && Number.isFinite(b) && a !== b) {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        if (isPointerDownRef.current) {
          pendingRangeRef.current = [lo, hi];
          return;
        }
        if (
          !Array.isArray(xRange) ||
          xRange.length !== 2 ||
          Math.abs(Number(xRange[0]) - lo) > 0.25 ||
          Math.abs(Number(xRange[1]) - hi) > 0.25
        ) {
          setXRange([lo, hi]);
        }
        scheduleWindowFetch(lo, hi);
      }
    }

    if (typeof e?.dragmode === "string" && e.dragmode) {
      setDragMode(e.dragmode);
    }
  }

  function applyPickedRange(a, b) {
    const lo = Math.min(Number(a), Number(b));
    const hi = Math.max(Number(a), Number(b));
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) return;
    setXRange([lo, hi]);
    scheduleWindowFetch(lo, hi);
  }

  function onPlotClick(e) {
    if (!rangePickMode) return;
    const x = Number(e?.points?.[0]?.x);
    if (!Number.isFinite(x)) return;

    if (!Number.isFinite(Number(rangePickStart))) {
      setRangePickStart(x);
      return;
    }

    applyPickedRange(rangePickStart, x);
    setRangePickStart(null);
    setRangePickMode(false);
  }

  function toggleRangePickMode() {
    setRangePickMode((prev) => {
      const next = !prev;
      if (!next) setRangePickStart(null);
      return next;
    });
  }

  function handlePointerDown() {
    isPointerDownRef.current = true;
    plotWrapRef.current?.classList.add("is-panning");
  }

  function handlePointerUp() {
    if (!isPointerDownRef.current) return;
    isPointerDownRef.current = false;
    plotWrapRef.current?.classList.remove("is-panning");

    const pending = pendingRangeRef.current;
    pendingRangeRef.current = null;
    if (Array.isArray(pending) && pending.length === 2) {
      const lo = Number(pending[0]);
      const hi = Number(pending[1]);
      if (Number.isFinite(lo) && Number.isFinite(hi) && lo !== hi) {
        setXRange([Math.min(lo, hi), Math.max(lo, hi)]);
        scheduleWindowFetch(lo, hi);
      }
    }
  }

  return (
    <div className="rounded-xl border border-white/10 bg-zinc-950/70 p-3 md:p-4">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-zinc-100">LAS Curves</h3>
          <p className="text-sm text-zinc-400">
            {selectedWell
              ? `${selectedWell.name} - Wheel=Zoom - Drag=Zoom - Modebar=Pan - Double-click=Reset`
              : "No well selected"}
          </p>
          {uploadMsg ? <p className="mt-1 text-xs text-zinc-300">{uploadMsg}</p> : null}
        </div>

        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".las"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0] || null;
              void uploadLasFile(file);
            }}
          />
          <button
            type="button"
            className="dash-btn-primary h-9 px-3 text-xs"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
          >
            {uploading ? "Uploading..." : "Upload LAS"}
          </button>
        </div>
      </div>

      <ChartControls
        wells={wells}
        selectedWellId={selectedWellId}
        setSelectedWellId={setSelectedWellId}
        selectedMetrics={selectedMetrics}
        allMetrics={allMetrics}
        curveMap={curveMap}
        colorMap={colorMap}
        selectedSummary={selectedSummary}
        toggleMetric={toggleMetric}
        resetZoom={resetZoom}
        loading={loading}
        rangePickMode={rangePickMode}
        rangePickStart={rangePickStart}
        toggleRangePickMode={toggleRangePickMode}
      />

      {rangePickMode ? (
        <div className="mb-2 rounded-md border border-sky-500/35 bg-sky-500/10 px-3 py-2 text-xs text-sky-200">
          {Number.isFinite(Number(rangePickStart))
            ? `Start depth selected: ${Number(rangePickStart).toFixed(1)}. Click second point to apply range.`
            : "Range select mode: click first depth point on chart."}
        </div>
      ) : null}

      {error ? (
        <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3">
          <div className="text-sm font-semibold text-rose-300">{error}</div>
          <button
            type="button"
            className="dash-btn mt-2 h-8 px-3 text-xs"
            onClick={() => void retryLoadWells()}
            disabled={loading}
          >
            {loading ? "Retrying..." : "Retry Loading Wells"}
          </button>
        </div>
      ) : (
        <div
          ref={plotWrapRef}
          className="plot-wrap"
          style={{ height: 480 }}
          onMouseDown={handlePointerDown}
          onMouseUp={handlePointerUp}
          onMouseLeave={handlePointerUp}
        >
          <Plot
            data={plotData}
            layout={{
              autosize: true,
              paper_bgcolor: "#0f1115",
              plot_bgcolor: "#111318",
              font: { color: "#d4d4d8" },
              margin: { l: 70, r: 20, t: 10, b: 50 },
              dragmode: dragMode,
              uirevision: uiRevision,
              xaxis: {
                title: "Depth",
                range: xRange || fullDomain,
                fixedrange: false,
                rangeslider: { visible: true },
                gridcolor: "rgba(255,255,255,0.08)",
                zerolinecolor: "rgba(255,255,255,0.1)",
              },
              yaxis: {
                title: "Value",
                fixedrange: false,
                gridcolor: "rgba(255,255,255,0.08)",
                zerolinecolor: "rgba(255,255,255,0.1)",
              },
              hovermode: denseWindow ? false : "x unified",
              showlegend: false,
              legend: { bgcolor: "rgba(0,0,0,0)" },
            }}
            config={{
              responsive: true,
              scrollZoom: true,
              displaylogo: false,
              modeBarButtonsToRemove: ["select2d", "lasso2d"],
            }}
            onRelayout={onRelayout}
            onClick={onPlotClick}
            style={{ width: "100%", height: "100%" }}
          />
        </div>
      )}
    </div>
  );
}
