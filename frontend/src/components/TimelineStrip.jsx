import React from "react";
import { getEventTimeline } from "../services/api";

const REQUEST_DEBOUNCE_MS = 240;

function bgForBucket(bucket) {
  const density = Number(bucket?.density || 0);
  const conf = Number(bucket?.maxConfidence || 0);
  const sev = Number(bucket?.severity || 0);
  const alpha = Math.max(0.08, Math.min(0.95, density * 0.75 + conf * 0.15 + sev * 0.1));
  return `rgba(239,68,68,${alpha.toFixed(3)})`;
}

export default function TimelineStrip({
  wellId,
  fromDepth,
  toDepth,
  curves = [],
  bucketSize = 10,
  onBucketClick,
}) {
  const [timeline, setTimeline] = React.useState([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const abortRef = React.useRef(null);
  const debounceRef = React.useRef(null);

  React.useEffect(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }

    const from = Number(fromDepth);
    const to = Number(toDepth);
    const hasRange = Number.isFinite(from) && Number.isFinite(to) && from !== to;
    if (!wellId || !hasRange || !curves.length) {
      setLoading(false);
      setError("");
      setTimeline([]);
      return;
    }
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const ac = new AbortController();
    abortRef.current = ac;
    debounceRef.current = setTimeout(() => {
      (async () => {
        try {
          setLoading(true);
          setError("");
          const out = await getEventTimeline({
            wellId,
            fromDepth: lo,
            toDepth: hi,
            bucketSize,
            curves,
          }, ac.signal);
          if (ac.signal.aborted) return;
          setTimeline(Array.isArray(out?.timeline) ? out.timeline : []);
        } catch (e) {
          if (ac.signal.aborted || String(e?.name || "") === "AbortError") return;
          setTimeline([]);
          setError(e?.message || "timeline unavailable");
        } finally {
          if (!ac.signal.aborted) setLoading(false);
        }
      })();
    }, REQUEST_DEBOUNCE_MS);
    return () => {
      ac.abort();
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [wellId, fromDepth, toDepth, bucketSize, curves.join(",")]);

  if (!wellId || !Number.isFinite(Number(fromDepth)) || !Number.isFinite(Number(toDepth))) return null;

  return (
    <div className="mt-3 rounded-xl border border-white/10 bg-zinc-950/70 p-3">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-semibold text-zinc-100">DepthAnomalyStrip</h4>
        <span className="text-xs text-zinc-400">
          {loading ? "loading..." : `${timeline.length} buckets`}
        </span>
      </div>
      {error ? <p className="mb-2 text-xs text-rose-300">{error}</p> : null}
      <div className="flex h-8 w-full overflow-hidden rounded-md border border-white/10 bg-zinc-900/60">
        {timeline.length ? (
          timeline.map((bucket, idx) => (
            <button
              key={`${bucket.from}-${bucket.to}-${idx}`}
              type="button"
              className="h-full flex-1 border-r border-black/20 transition hover:brightness-125"
              title={`${bucket.from.toFixed(1)}-${bucket.to.toFixed(1)} ft | density=${bucket.density} | conf=${bucket.maxConfidence}`}
              style={{ background: bgForBucket(bucket) }}
              onClick={() => onBucketClick?.(bucket)}
            />
          ))
        ) : (
          <div className="flex h-full w-full items-center justify-center text-xs text-zinc-500">
            No timeline events in this range.
          </div>
        )}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-zinc-500">
        <span>{Number(fromDepth).toFixed(1)} ft</span>
        <span>{Number(toDepth).toFixed(1)} ft</span>
      </div>
    </div>
  );
}
