import React from "react";
import { Trash2 } from "lucide-react";
import { Badge, fmtMaybe, pickRunId } from "./ui.jsx";

export default function HistorySection({ historyRuns, onReplayRun, onDeleteRun }) {
  if (!Array.isArray(historyRuns) || historyRuns.length === 0) return null;
  const [showAll, setShowAll] = React.useState(false);
  const [deletingRunId, setDeletingRunId] = React.useState("");
  const visibleRuns = showAll ? historyRuns : historyRuns.slice(0, 3);

  async function handleDelete(runId) {
    if (!runId || !onDeleteRun) return;
    const ok = window.confirm("Delete this interpretation run from history and database?");
    if (!ok) return;

    try {
      setDeletingRunId(runId);
      await onDeleteRun(runId);
    } finally {
      setDeletingRunId("");
    }
  }

  return (
    <section className="mb-4 rounded-xl border border-white/10 bg-zinc-900/70 p-3">
      <h3 className="mb-2 text-base font-semibold text-zinc-100">Interpretation History</h3>
      <div className="grid gap-2">
        {visibleRuns.map((r, i) => {
          const rid = pickRunId(r);
          const fromDepth = Number(r?.fromDepth);
          const toDepth = Number(r?.toDepth);

          return (
            <div
              key={rid || `run-${i}`}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/5 p-3"
            >
              <div>
                <div className="font-semibold text-zinc-100">
                  {r?.wellId || "-"} | {fmtMaybe(fromDepth, 0)} - {fmtMaybe(toDepth, 0)} ft
                </div>
                <div className="text-sm text-zinc-400">
                  {Array.isArray(r?.curves) ? r.curves.join(", ") : "-"} - {r?.narrativeStatus || "-"} -{" "}
                  {r?.createdAt ? new Date(r.createdAt).toLocaleString() : "-"}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => onReplayRun(rid)}
                  disabled={!rid}
                  className="dash-btn h-9 px-3"
                >
                  Replay
                </button>
                <button
                  onClick={() => handleDelete(rid)}
                  disabled={!rid || deletingRunId === rid}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-rose-500/40 bg-rose-500/10 text-rose-300 transition hover:bg-rose-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                  title="Delete run"
                  aria-label="Delete run"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Badge tone="neutral">Total Runs: {historyRuns.length}</Badge>
        {historyRuns.length > 3 ? (
          <button
            onClick={() => setShowAll((v) => !v)}
            className="dash-btn h-8 px-3 text-xs"
          >
            {showAll ? "Show less" : `Show more (${historyRuns.length - 3})`}
          </button>
        ) : null}
      </div>
    </section>
  );
}
