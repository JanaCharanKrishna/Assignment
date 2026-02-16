import React from "react";
import { Badge, fmtMaybe, toneForProbability, toneForRisk, toneForStability } from "./ui.jsx";
import IntervalFeedbackControls from "./IntervalFeedbackControls.jsx";

export default function NarrativeSection({ det, nar, onJumpToInterval, selectedWellId, runId }) {
  if (!det && !nar) return null;

  return (
    <section className="rounded-xl border border-white/10 bg-zinc-900/70 p-3">
      <h3 className="mb-2 text-base font-semibold text-zinc-100">Interpretation Details</h3>

      {Array.isArray(nar?.summary_bullets) && nar.summary_bullets.length > 0 ? (
        <div className="mb-3">
          <h4 className="mb-1 text-sm font-semibold text-zinc-100">Summary</h4>
          <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-300">
            {nar.summary_bullets.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {(det?.eventCount ?? 0) > 0 && Array.isArray(nar?.interval_explanations) && nar.interval_explanations.length > 0 ? (
        <div className="mb-3">
          <h4 className="mb-1 text-sm font-semibold text-zinc-100">Key Intervals</h4>
          {nar.interval_explanations.map((it, i) => (
            <div key={i} className="mb-2 rounded-xl border border-white/10 bg-white/5 p-3">
              <div className="text-zinc-100">
                <b>{it.curve || "-"}</b>: {fmtMaybe(it.fromDepth, 0)} {"->"} {fmtMaybe(it.toDepth, 0)}
              </div>

              <div className="mt-2 flex flex-wrap gap-2">
                {it.priority ? <Badge tone="blue">Priority: {it.priority}</Badge> : null}
                {it.probability ? <Badge tone={toneForProbability(it.probability)}>Probability: {it.probability}</Badge> : null}
                {it.stability ? <Badge tone={toneForStability(it.stability)}>Stability: {it.stability}</Badge> : null}
                {it.stabilityScore !== null && it.stabilityScore !== undefined ? (
                  <Badge tone="neutral">Stability Score: {fmtMaybe(it.stabilityScore, 2)}</Badge>
                ) : null}
                {it.severity ? <Badge tone={toneForRisk(it.severity)}>Severity: {it.severity}</Badge> : null}
              </div>

              <div className="mt-2 text-sm text-zinc-300">{it.explanation || "-"}</div>
              <div className="text-sm text-zinc-400">
                Confidence: {typeof it.confidence === "number" ? fmtMaybe(it.confidence) : String(it.confidence || "-")}
              </div>

              <button
                onClick={() => onJumpToInterval(it.fromDepth, it.toDepth)}
                className="dash-btn mt-2 h-9 px-3"
              >
                Jump to this interval
              </button>

              <IntervalFeedbackControls
                wellId={selectedWellId}
                runId={runId}
                fromDepth={it.fromDepth}
                toDepth={it.toDepth}
                curve={it.curve}
                predictedLabel={it.priority || "anomaly"}
                confidence={typeof it.confidence === "number" ? it.confidence : det?.detectionConfidence}
              />
            </div>
          ))}
        </div>
      ) : null}

      {Array.isArray(nar?.recommendations) && nar.recommendations.length > 0 ? (
        <div className="mb-3">
          <h4 className="mb-1 text-sm font-semibold text-zinc-100">Recommendations</h4>
          <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-300">
            {nar.recommendations.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {Array.isArray(nar?.limitations) && nar.limitations.length > 0 ? (
        <div>
          <h4 className="mb-1 text-sm font-semibold text-zinc-100">Limitations</h4>
          <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-300">
            {nar.limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <details className="mt-3 rounded-xl border border-white/10 bg-black/20 p-3">
        <summary className="cursor-pointer text-sm font-semibold text-zinc-200">
          Technical Diagnostics
        </summary>
        {det ? (
          <div className="mt-2 mb-3 space-y-1 text-sm text-zinc-300">
            <p>
              Anomaly Score: <b>{fmtMaybe(det.anomalyScore)}</b> | Confidence:{" "}
              <b>{fmtMaybe(det.confidence ?? det.detectionConfidence)}</b>
            </p>
            <p>Model Version: {det.modelVersion || "-"}</p>
          </div>
        ) : null}
        {Array.isArray(det?.dataQuality?.warnings) && det.dataQuality.warnings.length > 0 ? (
          <div className="mb-1">
            <h4 className="mb-1 text-sm font-semibold text-zinc-100">Data Quality Warnings</h4>
            <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-300">
              {det.dataQuality.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </details>
    </section>
  );
}
