import React from "react";
import CopilotPanel from "../CopilotPanel.jsx";
import InsightSection from "./InsightSection.jsx";
import NarrativeSection from "./NarrativeSection.jsx";
import PanelHeader from "./PanelHeader.jsx";
import IntervalDiffPanel from "../IntervalDiffPanel.jsx";
import CrossplotMatrix from "../CrossplotMatrix.jsx";

export default function InterpretationPanel({
  selectedWellId,
  selectedMetrics,
  lastRunRange,
  interpResult,
  selectedInterval,
  onIntervalPick,
  interpLoading,
  exportingPdf,
  interpError,
  isStale,
  viewRange,
  det,
  nar,
  insight,
  onRunInterpretation,
  onClearResults,
  onExportJson,
  onExportPdf,
  onJumpToInterval,
  onJumpToDepth,
}) {
  return (
    <div className="dash-panel mt-4">
      <PanelHeader
        interpLoading={interpLoading}
        exportingPdf={exportingPdf}
        interpResult={interpResult}
        viewRange={viewRange}
        lastRunRange={lastRunRange}
        det={det}
        onRunInterpretation={onRunInterpretation}
        onClearResults={onClearResults}
        onExportJson={onExportJson}
        onExportPdf={onExportPdf}
      />

      {isStale ? (
        <div className="mb-3 rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-sm text-amber-300">
          Current view range differs from last analyzed range. Run AI again to refresh interpretation for the current view.
        </div>
      ) : null}

      {interpError ? <p className="mb-3 font-semibold text-rose-300">{interpError}</p> : null}

      <InsightSection insight={insight} selectedWellId={selectedWellId} />
      <NarrativeSection
        det={det}
        nar={nar}
        onJumpToInterval={onJumpToInterval}
        selectedWellId={selectedWellId}
        runId={interpResult?.runId}
      />

      <IntervalDiffPanel
        wellId={selectedWellId}
        selectedMetrics={selectedMetrics}
        range={lastRunRange || viewRange}
      />

      <CrossplotMatrix
        wellId={selectedWellId}
        selectedMetrics={selectedMetrics}
        range={lastRunRange || viewRange}
        onJumpToDepth={onJumpToDepth}
        onJumpToInterval={onJumpToInterval}
      />

      <CopilotPanel
        selectedWellId={selectedWellId}
        selectedMetrics={selectedMetrics}
        lastRunRange={lastRunRange}
        interpResult={interpResult}
        selectedInterval={selectedInterval}
        onIntervalPick={onIntervalPick}
      />
    </div>
  );
}

