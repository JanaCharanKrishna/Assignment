import React from "react";
import Plot from "react-plotly.js";
import { getCrossplotMatrix } from "../services/api";

function defaultPairs(metrics) {
  const list = Array.isArray(metrics) ? metrics : [];
  if (list.length >= 3) {
    return [
      [list[0], list[1]],
      [list[1], list[2]],
      [list[0], list[2]],
    ];
  }
  if (list.length === 2) return [[list[0], list[1]]];
  return [];
}

export default function CrossplotMatrix({
  wellId,
  range,
  selectedMetrics = [],
  onJumpToDepth,
  onJumpToInterval,
}) {
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [plots, setPlots] = React.useState([]);

  const pairs = React.useMemo(() => defaultPairs(selectedMetrics), [selectedMetrics.join(",")]);

  async function runMatrix() {
    try {
      if (!wellId) throw new Error("Select a well first");
      if (!Number.isFinite(Number(range?.fromDepth)) || !Number.isFinite(Number(range?.toDepth))) {
        throw new Error("Run interpretation or set a depth range first");
      }
      if (!pairs.length) throw new Error("Need at least two curves for crossplot");

      setLoading(true);
      setError("");
      const out = await getCrossplotMatrix(wellId, {
        fromDepth: range.fromDepth,
        toDepth: range.toDepth,
        pairs,
        sampleLimit: 5000,
        cluster: { method: "robust_z" },
      });
      setPlots(Array.isArray(out?.plots) ? out.plots : []);
    } catch (e) {
      setError(e?.message || "Crossplot failed");
      setPlots([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="mt-4 rounded-xl border border-white/10 bg-zinc-900/70 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-zinc-100">Cross-plot Matrix</h3>
        <button type="button" className="dash-btn-primary h-9 px-3" onClick={runMatrix} disabled={loading}>
          {loading ? "Computing..." : "Generate matrix"}
        </button>
      </div>
      {error ? <p className="mb-2 text-sm text-rose-300">{error}</p> : null}
      {!plots.length ? <p className="text-sm text-zinc-400">No plots yet.</p> : null}
      <div className="grid gap-3 lg:grid-cols-2">
        {plots.map((plot) => {
          const inlier = [];
          const outlier = [];
          for (const p of plot.points || []) {
            if (p.isOutlier) outlier.push(p);
            else inlier.push(p);
          }
          return (
            <div key={`${plot.x}-${plot.y}`} className="rounded-xl border border-white/10 bg-black/20 p-2">
              <div className="mb-1 text-xs font-semibold text-zinc-300">
                {plot.x} vs {plot.y}
              </div>
              <Plot
                data={[
                  {
                    type: "scattergl",
                    mode: "markers",
                    name: "inlier",
                    x: inlier.map((p) => p.x),
                    y: inlier.map((p) => p.y),
                    customdata: inlier.map((p) => [p.depth]),
                    marker: { size: 4, color: "rgba(56,189,248,0.7)" },
                    hovertemplate: "Depth=%{customdata[0]:.1f}<br>x=%{x}<br>y=%{y}<extra></extra>",
                  },
                  {
                    type: "scattergl",
                    mode: "markers",
                    name: "outlier",
                    x: outlier.map((p) => p.x),
                    y: outlier.map((p) => p.y),
                    customdata: outlier.map((p) => [p.depth]),
                    marker: { size: 5, color: "rgba(239,68,68,0.8)" },
                    hovertemplate: "Depth=%{customdata[0]:.1f}<br>x=%{x}<br>y=%{y}<extra></extra>",
                  },
                ]}
                layout={{
                  autosize: true,
                  height: 260,
                  margin: { l: 40, r: 10, t: 10, b: 35 },
                  paper_bgcolor: "#0f1115",
                  plot_bgcolor: "#111318",
                  font: { color: "#d4d4d8", size: 11 },
                  xaxis: { title: plot.x, gridcolor: "rgba(255,255,255,0.08)" },
                  yaxis: { title: plot.y, gridcolor: "rgba(255,255,255,0.08)" },
                  legend: { orientation: "h", y: 1.1 },
                }}
                config={{ responsive: true, displaylogo: false }}
                style={{ width: "100%" }}
                onClick={(e) => {
                  const depth = Number(e?.points?.[0]?.customdata?.[0]);
                  if (Number.isFinite(depth)) onJumpToDepth?.(depth);
                }}
                onSelected={(e) => {
                  const points = Array.isArray(e?.points) ? e.points : [];
                  const depths = points
                    .map((pt) => Number(pt?.customdata?.[0]))
                    .filter(Number.isFinite);
                  if (depths.length < 2) return;
                  const lo = Math.min(...depths);
                  const hi = Math.max(...depths);
                  onJumpToInterval?.(lo, hi);
                }}
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}
