import React from "react";
import { Badge, safeArr, toNum, toneForConfidence, toneForPriority } from "./copilot-utils.jsx";

export default function CopilotResult({ mode, result, evidence, source, schemaValid, schemaErrors, evidenceStrength, latencyMs }) {
  if (!result) return null;

  const isLowEvidence = evidenceStrength === "low";
  const isSchemaInvalid = schemaValid === false;

  return (
    <>
      {isLowEvidence ? (
        <WarningBox tone="yellow">Low evidence strength. Validate output before operational action.</WarningBox>
      ) : null}

      {isSchemaInvalid ? (
        <WarningBox tone="orange">
          Response schema needed fallback repair.
          {schemaErrors.length ? ` Issues: ${schemaErrors.slice(0, 2).join(" | ")}` : ""}
        </WarningBox>
      ) : null}

      <section className="mb-3 rounded-xl border border-white/10 bg-zinc-900/70 p-3">
        <div className="mb-2 flex flex-wrap gap-2">
          <Badge tone="blue">{result.answer_title || "Copilot Answer"}</Badge>
          <Badge tone={toneForConfidence(result?.confidence?.rubric)}>
            Confidence: {result?.confidence?.rubric || "-"} ({toNum(result?.confidence?.overall, 2)})
          </Badge>
        </div>
        <p className="leading-relaxed text-zinc-100">{result.direct_answer || "-"}</p>
        {result?.confidence?.reason ? (
          <p className="mt-2 text-xs text-zinc-400">Reason: {result.confidence.reason}</p>
        ) : null}
      </section>

      {safeArr(result.key_points).length > 0 ? (
        <Section title="Key Points">
          <ul className="list-disc space-y-1 pl-5 text-zinc-200">
            {safeArr(result.key_points).map((k, i) => <li key={i}>{k}</li>)}
          </ul>
        </Section>
      ) : null}

      {safeArr(result.actions).length > 0 ? (
        <Section title="Recommended Actions">
          <div className="grid gap-2">
            {safeArr(result.actions).map((a, i) => (
              <div key={i} className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="mb-1 flex flex-wrap gap-2">
                  <Badge tone={toneForPriority(a?.priority)}>Priority: {a?.priority || "-"}</Badge>
                </div>
                <div className="font-semibold text-zinc-100">{a?.action || "-"}</div>
                <div className="mt-1 text-sm text-zinc-400">{a?.rationale || "-"}</div>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {mode === "compare" ? (
        <Section title="Comparison">
          <p className="mb-2 text-sm text-zinc-200">{result?.comparison?.summary || "-"}</p>
          {Array.isArray(result?.comparison?.delta_metrics) && result.comparison.delta_metrics.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-white/10 text-left text-zinc-400">
                    <th className="px-2 py-2">Metric</th>
                    <th className="px-2 py-2">Current</th>
                    <th className="px-2 py-2">Baseline</th>
                    <th className="px-2 py-2">Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {result.comparison.delta_metrics.map((d, i) => (
                    <tr key={i} className="border-b border-white/5 text-zinc-200">
                      <td className="px-2 py-2 font-semibold">{d?.metric ?? "-"}</td>
                      <td className="px-2 py-2">{String(d?.current ?? "-")}</td>
                      <td className="px-2 py-2">{String(d?.baseline ?? "-")}</td>
                      <td className="px-2 py-2">{String(d?.delta ?? "-")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-zinc-500">No delta metrics available (baseline evidence missing).</p>
          )}
        </Section>
      ) : null}

      <div className="grid gap-2 md:grid-cols-2">
        <Section title="Risks">
          {safeArr(result.risks).length ? (
            <ul className="list-disc space-y-1 pl-5 text-zinc-200">
              {safeArr(result.risks).map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          ) : (
            <p className="text-sm text-zinc-500">None listed.</p>
          )}
        </Section>
        <Section title="Uncertainties">
          {safeArr(result.uncertainties).length ? (
            <ul className="list-disc space-y-1 pl-5 text-zinc-200">
              {safeArr(result.uncertainties).map((u, i) => <li key={i}>{u}</li>)}
            </ul>
          ) : (
            <p className="text-sm text-zinc-500">None listed.</p>
          )}
        </Section>
      </div>

      {safeArr(result.evidence_used).length > 0 ? (
        <Section title="Evidence Used">
          <div className="grid gap-2">
            {safeArr(result.evidence_used).map((ev, i) => (
              <div key={i} className="rounded-xl border border-white/10 bg-white/5 p-3">
                <div className="mb-1 flex flex-wrap gap-2">
                  <Badge tone="blue">{ev?.source || "-"}</Badge>
                  <Badge tone={toneForConfidence(ev?.confidence)}>confidence: {ev?.confidence || "-"}</Badge>
                </div>
                <div className="text-sm text-zinc-200">{ev?.snippet || "-"}</div>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {evidence ? (
        <div className="mt-3 rounded-xl border border-dashed border-white/20 bg-zinc-900/60 p-3">
          <h4 className="mb-1 text-sm font-semibold text-zinc-200">Context Snapshot</h4>
          <div className="text-xs text-zinc-400">
            Well: <b>{evidence?.context_meta?.wellId || "-"}</b> | Range:{" "}
            <b>
              {toNum(evidence?.context_meta?.range?.fromDepth, 0)} {"->"}{" "}
              {toNum(evidence?.context_meta?.range?.toDepth, 0)}
            </b>{" "}
            | Curves:{" "}
            <b>
              {Array.isArray(evidence?.context_meta?.curves)
                ? evidence.context_meta.curves.join(", ")
                : "-"}
            </b>
          </div>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2 rounded-xl border border-dashed border-white/20 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-400">
        <span><b>Source:</b> {source || "-"}</span>
        <span><b>Evidence:</b> {evidenceStrength || "-"}</span>
        <span><b>Schema:</b> {schemaValid === false ? "fallback repaired" : schemaValid === true ? "valid" : "-"}</span>
        <span><b>Latency:</b> {Number.isFinite(latencyMs) ? `${toNum(latencyMs, 0)} ms` : "-"}</span>
      </div>

      <div className="mt-3 rounded-xl border border-sky-500/35 bg-sky-500/10 px-3 py-2 text-sm font-semibold text-sky-300">
        {result?.safety_note || "Decision support only, not autonomous control."}
      </div>
    </>
  );
}

function Section({ title, children }) {
  return (
    <section className="mb-3 rounded-xl border border-white/10 bg-zinc-900/70 p-3">
      <h4 className="mb-2 text-sm font-semibold text-zinc-100">{title}</h4>
      {children}
    </section>
  );
}

function WarningBox({ tone, children }) {
  const cls = tone === "orange"
    ? "border-amber-500/35 bg-amber-500/10 text-amber-300"
    : "border-yellow-500/35 bg-yellow-500/10 text-yellow-300";

  return (
    <div className={`mb-3 rounded-xl border px-3 py-2 text-sm font-semibold ${cls}`}>
      {children}
    </div>
  );
}
