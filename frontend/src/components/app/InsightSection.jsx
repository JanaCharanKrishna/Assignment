import React from "react";
import {
  Badge,
  fmtMaybe,
  toneForProbability,
  toneForRisk,
  toneForStability,
} from "./ui.jsx";

export default function InsightSection({ insight, selectedWellId }) {
  if (!insight) return null;

  return (
    <>
      <Section title="AI Interpretation Summary">
        <div className="mb-2 flex flex-wrap gap-2">
          <Badge>Well: {insight.well || selectedWellId || "-"}</Badge>
          <Badge>
            Interval: {fmtMaybe(insight.fromDepth, 0)} - {fmtMaybe(insight.toDepth, 0)} ft
          </Badge>
          <Badge>
            Curves: {Array.isArray(insight.analyzedCurves) && insight.analyzedCurves.length ? insight.analyzedCurves.join(", ") : "-"}
          </Badge>
        </div>
        {insight.summaryParagraph ? <p className="leading-relaxed text-zinc-200">{insight.summaryParagraph}</p> : null}
      </Section>

      {insight?.indices ? (
        <Section title="Indices">
          <div className="grid gap-2 md:grid-cols-3">
            <MetricCard title="Wetness Index (Wh)" value={fmtMaybe(insight.indices.wetnessIndexWh, 2)} text={insight.indices.wetnessText} />
            <MetricCard title="Balance Ratio (Bh)" value={fmtMaybe(insight.indices.balanceRatioBh, 2)} text={insight.indices.balanceText} />
            <MetricCard title="Character Ratio (Ch)" value={fmtMaybe(insight.indices.characterRatioCh, 2)} text={insight.indices.characterText} />
          </div>
        </Section>
      ) : null}

      {insight?.primaryFluid ? (
        <Section title="Primary Fluid Type">
          <div className="mb-2 flex flex-wrap gap-2">
            <Badge tone="blue">{insight.primaryFluid.label || "-"}</Badge>
            <Badge>Confidence: {fmtMaybe(insight.primaryFluid.confidence, 2)}</Badge>
          </div>
          {Array.isArray(insight.primaryFluid.evidence) && insight.primaryFluid.evidence.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-zinc-200">
              {insight.primaryFluid.evidence.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          ) : null}
        </Section>
      ) : null}

      {Array.isArray(insight?.shows) && insight.shows.length > 0 ? (
        <Section title="Gas Shows / Key Shows">
          <div className="grid gap-2">
            {insight.shows.map((s, i) => (
              <div
                key={i}
                className="flex flex-wrap justify-between gap-3 rounded-xl border border-white/10 bg-white/5 p-3"
              >
                <div>
                  <div className="font-semibold text-zinc-100">
                    {fmtMaybe(s.fromDepth, 0)} - {fmtMaybe(s.toDepth, 0)} ft
                  </div>
                  <div className="text-sm text-zinc-400">{s.reason || "-"}</div>
                </div>
                <div className="flex min-w-[220px] flex-wrap items-center justify-end gap-2">
                  <Badge tone={toneForProbability(s.probability)}>{String(s.probability || "low")} probability</Badge>
                  {s.stability ? <Badge tone={toneForStability(s.stability)}>Stability: {String(s.stability)}</Badge> : null}
                  {s.stabilityScore !== null && s.stabilityScore !== undefined ? <Badge tone="neutral">Stability Score: {fmtMaybe(s.stabilityScore, 2)}</Badge> : null}
                  {s.priority ? <Badge tone="blue">Priority: {String(s.priority)}</Badge> : null}
                </div>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {insight?.riskProfile ? (
        <Section title="Risk Profile">
          <div className="mb-2 flex flex-wrap gap-2">
            <Badge tone={toneForRisk(insight.riskProfile.sealIntegrity)}>Seal Integrity: {insight.riskProfile.sealIntegrity || "-"}</Badge>
            <Badge tone={toneForRisk(insight.riskProfile.saturationRisk)}>Saturation Risk: {insight.riskProfile.saturationRisk || "-"}</Badge>
          </div>
          <p className="text-zinc-200">{insight.riskProfile.summary || "-"}</p>
        </Section>
      ) : null}

      {Array.isArray(insight?.zones) && insight.zones.length > 0 ? (
        <Section title="Zone Interpretation">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-zinc-400">
                  <th className="px-2 py-2">Zone</th>
                  <th className="px-2 py-2">Depth Range</th>
                  <th className="px-2 py-2">Label</th>
                  <th className="px-2 py-2">Notes</th>
                </tr>
              </thead>
              <tbody>
                {insight.zones.map((z, i) => (
                  <tr key={i} className="border-b border-white/5 text-zinc-200">
                    <td className="px-2 py-2 font-semibold">{z.name || `Zone ${i + 1}`}</td>
                    <td className="px-2 py-2">{fmtMaybe(z.fromDepth, 0)} - {fmtMaybe(z.toDepth, 0)}</td>
                    <td className="px-2 py-2">{z.label || "-"}</td>
                    <td className="px-2 py-2">{z.notes || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ) : null}
    </>
  );
}

function Section({ title, children }) {
  return (
    <section className="mb-4 rounded-xl border border-white/10 bg-zinc-900/70 p-3">
      <h3 className="mb-2 text-base font-semibold text-zinc-100">{title}</h3>
      {children}
    </section>
  );
}

function MetricCard({ title, value, text }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-3">
      <div className="text-xs text-zinc-400">{title}</div>
      <div className="text-2xl font-bold text-zinc-100">{value}</div>
      <div className="text-xs text-zinc-300">{text || "-"}</div>
    </div>
  );
}
