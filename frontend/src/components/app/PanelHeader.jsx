import React from "react";
import { Badge, fmtMaybe, fmtNum, toneForRisk } from "./ui.jsx";

export default function PanelHeader({
  interpLoading,
  exportingPdf,
  interpResult,
  viewRange,
  lastRunRange,
  det,
  onRunInterpretation,
  onClearResults,
  onExportJson,
  onExportPdf,
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <ActionButton
        onClick={onRunInterpretation}
        disabled={interpLoading}
        label={interpLoading ? "Running AI..." : "Run AI Interpretation"}
        primary
      />

      <ActionButton
        onClick={onClearResults}
        disabled={interpLoading || !interpResult}
        label="Clear Results"
      />

      <ActionButton
        onClick={onExportJson}
        disabled={!interpResult || interpLoading}
        label="Export JSON"
      />

      <ActionButton
        onClick={onExportPdf}
        disabled={!interpResult || interpLoading || exportingPdf}
        label={exportingPdf ? "Exporting PDF..." : "Export PDF"}
      />

      {interpResult?.modelUsed ? <Badge tone="blue">Model: {interpResult.modelUsed}</Badge> : null}
      {interpResult?.narrativeStatus ? (
        <Badge tone={interpResult.narrativeStatus === "ok" || interpResult.narrativeStatus === "llm_ok" ? "green" : "yellow"}>
          Status: {interpResult.narrativeStatus}
        </Badge>
      ) : null}
      {viewRange ? (
        <Badge tone="neutral">
          View Range: {fmtNum(viewRange.fromDepth, 0)} {"->"} {fmtNum(viewRange.toDepth, 0)}
        </Badge>
      ) : null}
      {lastRunRange ? (
        <Badge tone="blue">
          Analyzed Range: {fmtNum(lastRunRange.fromDepth, 0)} {"->"} {fmtNum(lastRunRange.toDepth, 0)}
        </Badge>
      ) : null}
      {det?.severityBand ? <Badge tone={toneForRisk(det.severityBand)}>Global Risk: {String(det.severityBand).toUpperCase()}</Badge> : null}
      {det?.dataQuality?.qualityBand ? <Badge tone={toneForRisk(det.dataQuality.qualityBand)}>Data Quality: {det.dataQuality.qualityBand}</Badge> : null}
      {typeof det?.eventCount === "number" ? <Badge>Events: {det.eventCount}</Badge> : null}
      {typeof det?.detectionConfidence === "number" ? <Badge>Detect Conf: {fmtMaybe(det.detectionConfidence)}</Badge> : null}
    </div>
  );
}

function ActionButton({ onClick, disabled, label, primary = false }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={primary ? "dash-btn-primary" : "dash-btn"}
    >
      {label}
    </button>
  );
}

