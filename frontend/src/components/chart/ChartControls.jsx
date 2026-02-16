import React from "react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { metricLabel } from "./chart-utils";

export default function ChartControls({
  wells,
  selectedWellId,
  setSelectedWellId,
  selectedMetrics,
  allMetrics,
  curveMap,
  colorMap,
  selectedSummary,
  toggleMetric,
  resetZoom,
  loading,
  rangePickMode,
  rangePickStart,
  toggleRangePickMode,
}) {
  const [open, setOpen] = React.useState(false);
  const [curveSearch, setCurveSearch] = React.useState("");
  const dropdownRef = React.useRef(null);

  React.useEffect(() => {
    function onPointerDown(e) {
      if (!dropdownRef.current) return;
      if (!dropdownRef.current.contains(e.target)) setOpen(false);
    }

    function onKeyDown(e) {
      if (e.key === "Escape") setOpen(false);
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <div className="mb-3 flex flex-wrap items-start gap-3">
      <div>
        <label className="mb-1 block text-xs text-zinc-400">Well</label>
        <Select value={selectedWellId} onValueChange={setSelectedWellId}>
          <SelectTrigger className="dash-input min-w-[220px]">
            <SelectValue placeholder="Select a well" />
          </SelectTrigger>
          <SelectContent>
            {wells.map((w) => (
              <SelectItem key={w.wellId} value={w.wellId}>
                {w.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div ref={dropdownRef} className="relative min-w-[280px]">
        <label className="mb-1 block text-xs text-zinc-400">Curves</label>
        <button
          type="button"
          className="dash-input flex w-full items-center justify-between"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="truncate pr-3">{selectedSummary}</span>
          <span className="text-zinc-500">{open ? "▲" : "▼"}</span>
        </button>

        {open ? (
          <div className="absolute z-20 mt-2 max-h-72 w-full overflow-auto rounded-xl border border-white/15 bg-zinc-900 p-3 shadow-2xl">
            <div className="mb-2 text-xs text-zinc-500">Select one or more curves</div>
            <Input
              value={curveSearch}
              onChange={(e) => setCurveSearch(e.target.value)}
              placeholder="Search curves..."
              className="mb-3 h-9"
            />
            <div className="grid gap-2">
              {allMetrics
                .filter((m) => {
                  const q = String(curveSearch || "").trim().toLowerCase();
                  if (!q) return true;
                  const label = String(metricLabel(curveMap.get(m)) || m).toLowerCase();
                  return label.includes(q);
                })
                .map((m) => (
                <label key={m} className="flex items-center gap-2 text-sm text-zinc-300">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-white/20 bg-zinc-950"
                    checked={selectedMetrics.includes(m)}
                    onChange={(e) => toggleMetric(m, e.target.checked)}
                  />
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: colorMap.get(m) || "#2563eb" }}
                  />
                  <span className="truncate">
                    {metricLabel(curveMap.get(m)) || m}
                  </span>
                </label>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div>
        <label className="mb-1 block text-xs text-zinc-400">Actions</label>
        <div className="flex gap-2">
          <button
            type="button"
            className="dash-btn"
            onClick={resetZoom}
            disabled={loading}
          >
            Reset
          </button>
          <button
            type="button"
            className={rangePickMode ? "dash-btn-primary" : "dash-btn"}
            onClick={toggleRangePickMode}
            disabled={loading}
          >
            {rangePickMode ? "Cancel Range" : "Select Range"}
          </button>
        </div>
        {rangePickMode ? (
          <div className="mt-1 text-[11px] text-zinc-400">
            {Number.isFinite(Number(rangePickStart))
              ? `Start: ${Number(rangePickStart).toFixed(1)}`
              : "Pick first point"}
          </div>
        ) : null}
      </div>

      {selectedMetrics.length > 0 ? (
        <div className="w-full">
          <label className="mb-1 block text-xs text-zinc-400">Selected Curves</label>
          <div className="flex flex-wrap gap-2">
            {selectedMetrics.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => toggleMetric(m, false)}
                className="inline-flex items-center gap-2 rounded-xl border border-sky-500/35 bg-sky-500/12 px-3 py-1.5 text-xs font-semibold text-sky-200 transition hover:bg-sky-500/20"
                title="Click to remove"
              >
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: colorMap.get(m) || "#2563eb" }}
                />
                <span>{metricLabel(curveMap.get(m)) || m}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {loading && <div className="mt-6 text-xs text-zinc-400">Loading...</div>}
    </div>
  );
}
