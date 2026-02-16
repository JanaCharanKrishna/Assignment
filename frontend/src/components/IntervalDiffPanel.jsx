import React from "react";
import { getIntervalDiff } from "../services/api";

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmt(v, d = 2) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(d) : "-";
}

export default function IntervalDiffPanel({ wellId, selectedMetrics = [], range }) {
  const fromDepth = toNum(range?.fromDepth);
  const toDepth = toNum(range?.toDepth);

  const [aFrom, setAFrom] = React.useState("");
  const [aTo, setATo] = React.useState("");
  const [bFrom, setBFrom] = React.useState("");
  const [bTo, setBTo] = React.useState("");
  const [detailLevel, setDetailLevel] = React.useState(3);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [diff, setDiff] = React.useState(null);

  React.useEffect(() => {
    if (!Number.isFinite(fromDepth) || !Number.isFinite(toDepth)) return;
    const lo = Math.min(fromDepth, toDepth);
    const hi = Math.max(fromDepth, toDepth);
    const mid = lo + (hi - lo) / 2;
    setAFrom(lo.toFixed(1));
    setATo(mid.toFixed(1));
    setBFrom(mid.toFixed(1));
    setBTo(hi.toFixed(1));
  }, [fromDepth, toDepth]);

  async function runDiff() {
    try {
      if (!wellId) throw new Error("Select a well first");
      const payload = {
        wellId,
        a: {
          fromDepth: Number(aFrom),
          toDepth: Number(aTo),
          curves: selectedMetrics,
        },
        b: {
          fromDepth: Number(bFrom),
          toDepth: Number(bTo),
          curves: selectedMetrics,
        },
        detailLevel,
      };
      setLoading(true);
      setError("");
      const out = await getIntervalDiff(payload);
      setDiff(out);
    } catch (e) {
      setError(e?.message || "Interval diff failed");
      setDiff(null);
    } finally {
      setLoading(false);
    }
  }

  if (!wellId) return null;

  return (
    <section className="mt-4 rounded-xl border border-white/10 bg-zinc-900/70 p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-zinc-100">Compare Intervals</h3>
        <button type="button" className="dash-btn-primary h-9 px-3" onClick={runDiff} disabled={loading}>
          {loading ? "Comparing..." : "Compare intervals"}
        </button>
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        <div className="rounded-xl border border-white/10 bg-black/20 p-3">
          <div className="mb-2 text-xs font-semibold text-zinc-300">Interval A</div>
          <div className="grid grid-cols-2 gap-2">
            <input className="dash-input" type="number" value={aFrom} onChange={(e) => setAFrom(e.target.value)} placeholder="From" />
            <input className="dash-input" type="number" value={aTo} onChange={(e) => setATo(e.target.value)} placeholder="To" />
          </div>
        </div>
        <div className="rounded-xl border border-white/10 bg-black/20 p-3">
          <div className="mb-2 text-xs font-semibold text-zinc-300">Interval B</div>
          <div className="grid grid-cols-2 gap-2">
            <input className="dash-input" type="number" value={bFrom} onChange={(e) => setBFrom(e.target.value)} placeholder="From" />
            <input className="dash-input" type="number" value={bTo} onChange={(e) => setBTo(e.target.value)} placeholder="To" />
          </div>
        </div>
      </div>

      <div className="mt-2 flex items-center gap-2 text-xs text-zinc-400">
        <label htmlFor="detail">Detail</label>
        <input
          id="detail"
          type="range"
          min="1"
          max="5"
          value={detailLevel}
          onChange={(e) => setDetailLevel(Number(e.target.value))}
        />
        <span>{detailLevel}</span>
      </div>

      {error ? <p className="mt-2 text-sm text-rose-300">{error}</p> : null}

      {diff ? (
        <div className="mt-3 space-y-3">
          <div className="rounded-xl border border-white/10 bg-black/20 p-3">
            <div className="mb-2 text-sm font-semibold text-zinc-100">Curve Deltas</div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px] border-collapse text-xs">
                <thead>
                  <tr className="border-b border-white/10 text-left text-zinc-400">
                    <th className="px-2 py-1">Curve</th>
                    <th className="px-2 py-1">Mean A</th>
                    <th className="px-2 py-1">Mean B</th>
                    <th className="px-2 py-1">Delta</th>
                    <th className="px-2 py-1">Delta %</th>
                    <th className="px-2 py-1">P90 A</th>
                    <th className="px-2 py-1">P90 B</th>
                    <th className="px-2 py-1">Vol A</th>
                    <th className="px-2 py-1">Vol B</th>
                  </tr>
                </thead>
                <tbody>
                  {(diff.curveDiff || []).map((row) => (
                    <tr key={row.curve} className="border-b border-white/5 text-zinc-200">
                      <td className="px-2 py-1 font-semibold">{row.curve}</td>
                      <td className="px-2 py-1">{fmt(row.meanA)}</td>
                      <td className="px-2 py-1">{fmt(row.meanB)}</td>
                      <td className="px-2 py-1">{fmt(row.delta)}</td>
                      <td className="px-2 py-1">{fmt(row.deltaPct)}</td>
                      <td className="px-2 py-1">{fmt(row.p90A)}</td>
                      <td className="px-2 py-1">{fmt(row.p90B)}</td>
                      <td className="px-2 py-1">{fmt(row.volatilityA, 3)}</td>
                      <td className="px-2 py-1">{fmt(row.volatilityB, 3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="rounded-xl border border-white/10 bg-black/20 p-3 text-sm text-zinc-200">
            <div className="mb-1 font-semibold text-zinc-100">Event Delta</div>
            <p>
              Count: {diff?.eventDiff?.eventCountA ?? "-"} {"->"} {diff?.eventDiff?.eventCountB ?? "-"} | Anomaly:{" "}
              {fmt(diff?.eventDiff?.anomalyScoreA, 3)} {"->"} {fmt(diff?.eventDiff?.anomalyScoreB, 3)}
            </p>
            <p>
              Severity: {diff?.eventDiff?.severityBandA || "-"} {"->"} {diff?.eventDiff?.severityBandB || "-"}
            </p>
          </div>

          {(diff?.topChanges || []).length ? (
            <div className="rounded-xl border border-white/10 bg-black/20 p-3">
              <div className="mb-1 text-sm font-semibold text-zinc-100">Top Changes</div>
              <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-300">
                {diff.topChanges.map((item, i) => <li key={i}>{item}</li>)}
              </ul>
            </div>
          ) : null}

          <div className="rounded-xl border border-white/10 bg-black/20 p-3 text-sm text-zinc-200">
            <div className="mb-1 font-semibold text-zinc-100">Narrative Diff</div>
            <p>{diff?.narrativeDiff || "-"}</p>
          </div>
        </div>
      ) : null}
    </section>
  );
}
