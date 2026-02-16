import React from "react";
import { getIntervalFeedbackSummary, submitIntervalFeedback } from "../../services/api";

const LABELS = [
  { key: "true_positive", text: "True Positive" },
  { key: "false_positive", text: "False Positive" },
  { key: "uncertain", text: "Uncertain" },
];

export default function IntervalFeedbackControls({
  wellId,
  runId,
  fromDepth,
  toDepth,
  curve,
  predictedLabel = "anomaly",
  confidence,
}) {
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState("");
  const [summary, setSummary] = React.useState(null);

  React.useEffect(() => {
    if (!wellId) return;
    let cancelled = false;
    (async () => {
      try {
        const out = await getIntervalFeedbackSummary({ wellId });
        if (!cancelled) setSummary(out?.summary || null);
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [wellId]);

  async function submitLabel(userLabel) {
    try {
      setBusy(true);
      setMsg("");
      await submitIntervalFeedback({
        runId,
        wellId,
        fromDepth,
        toDepth,
        curve,
        predictedLabel,
        userLabel,
        confidence,
      });
      setMsg(`Saved: ${userLabel}`);
      const out = await getIntervalFeedbackSummary({ wellId });
      setSummary(out?.summary || null);
    } catch (e) {
      setMsg(e?.message || "feedback failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 rounded-lg border border-white/10 bg-black/20 p-2">
      <div className="mb-2 text-xs font-semibold text-zinc-300">Feedback</div>
      <div className="flex flex-wrap gap-2">
        {LABELS.map((item) => (
          <button
            key={item.key}
            type="button"
            className="dash-btn h-8 px-2 text-xs"
            disabled={busy}
            onClick={() => submitLabel(item.key)}
          >
            {item.text}
          </button>
        ))}
      </div>
      {msg ? <div className="mt-1 text-xs text-zinc-400">{msg}</div> : null}
      {summary ? (
        <div className="mt-1 text-[11px] text-zinc-500">
          TP: {summary?.byLabel?.true_positive || 0} | FP: {summary?.byLabel?.false_positive || 0} | U: {summary?.byLabel?.uncertain || 0}
        </div>
      ) : null}
    </div>
  );
}

