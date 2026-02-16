import React from "react";
import { IconEye, IconRefresh } from "@tabler/icons-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import InsightSection from "@/components/app/InsightSection.jsx";
import NarrativeSection from "@/components/app/NarrativeSection.jsx";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  downloadInterpretationPdf,
  exportInterpretationJson,
  getInterpretationRun,
  listInterpretationRuns,
} from "@/services/api";

export default function Reports() {
  const [interpHistoryLoading, setInterpHistoryLoading] = React.useState(false);
  const [interpHistoryError, setInterpHistoryError] = React.useState("");
  const [interpHistory, setInterpHistory] = React.useState([]);
  const [visibleInterpCount, setVisibleInterpCount] = React.useState(5);
  const [sortByDate, setSortByDate] = React.useState("newest");
  const [wellFilter, setWellFilter] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState("all");
  const [curveFilter, setCurveFilter] = React.useState("");
  const [selectedRun, setSelectedRun] = React.useState(null);
  const [selectedRunLoading, setSelectedRunLoading] = React.useState(false);
  const [selectedRunError, setSelectedRunError] = React.useState("");
  const [question, setQuestion] = React.useState("");
  const [messages, setMessages] = React.useState([
    { role: "assistant", text: "Select an interpretation from the table, then ask about that interpretation." },
  ]);

  const det = selectedRun?.deterministic || null;
  const nar = selectedRun?.narrative || null;
  const insight = selectedRun?.insight || null;

  const summaryCards = [
    {
      title: "Global Risk",
      value: det?.severityBand ? String(det.severityBand).toUpperCase() : "-",
      hint: "Overall risk classification",
    },
    {
      title: "Data Quality",
      value: det?.dataQuality?.qualityBand || "-",
      hint: `Null ${typeof det?.dataQuality?.nullPercent === "number" ? det.dataQuality.nullPercent.toFixed(1) : "-"}%`,
    },
    {
      title: "Detected Events",
      value: typeof det?.eventCount === "number" ? String(det.eventCount) : "-",
      hint: "Consolidated interval findings",
    },
    {
      title: "Detection Confidence",
      value: typeof det?.detectionConfidence === "number" ? det.detectionConfidence.toFixed(3) : "-",
      hint: "Model confidence score",
    },
  ];

  async function loadInterpretationHistory() {
    setInterpHistoryLoading(true);
    setInterpHistoryError("");
    try {
      const data = await listInterpretationRuns({ limit: 100 });
      const rows = Array.isArray(data?.runs) ? data.runs : [];
      setInterpHistory(rows);
    } catch (e) {
      setInterpHistoryError(e?.message || "Failed to load interpretation history");
      setInterpHistory([]);
    } finally {
      setInterpHistoryLoading(false);
    }
  }

  React.useEffect(() => {
    void loadInterpretationHistory();
  }, []);

  const filteredSortedInterpHistory = React.useMemo(() => {
    const byWell = String(wellFilter || "").trim().toLowerCase();
    const byCurve = String(curveFilter || "").trim().toLowerCase();

    const filtered = interpHistory.filter((run) => {
      const wellId = String(run?.wellId ?? run?.well_id ?? "").toLowerCase();
      const status = String(run?.narrativeStatus ?? run?.narrative_status ?? "").toLowerCase();
      const curves = Array.isArray(run?.curves) ? run.curves.map((c) => String(c).toLowerCase()) : [];

      if (byWell && !wellId.includes(byWell)) return false;
      if (statusFilter !== "all" && status !== statusFilter) return false;
      if (byCurve && !curves.some((c) => c.includes(byCurve))) return false;
      return true;
    });

    filtered.sort((a, b) => {
      const da = new Date(a?.createdAt ?? a?.created_at ?? 0).getTime();
      const db = new Date(b?.createdAt ?? b?.created_at ?? 0).getTime();
      return sortByDate === "oldest" ? da - db : db - da;
    });

    return filtered;
  }, [interpHistory, wellFilter, statusFilter, curveFilter, sortByDate]);

  React.useEffect(() => {
    setVisibleInterpCount(5);
  }, [wellFilter, statusFilter, curveFilter, sortByDate, interpHistory.length]);

  async function handleViewInterpretation(runId) {
    if (!runId || runId === "-") return;
    try {
      setSelectedRunLoading(true);
      setSelectedRunError("");
      const data = await getInterpretationRun(runId);
      const run = data?.run || data;
      if (!run || typeof run !== "object") {
        throw new Error("Interpretation not found");
      }
      setSelectedRun(run);
      setMessages([
        { role: "assistant", text: `Loaded interpretation ${runId}. Ask anything about this interpretation.` },
      ]);
    } catch (e) {
      setSelectedRunError(e?.message || "Failed to load interpretation");
      setSelectedRun(null);
    } finally {
      setSelectedRunLoading(false);
    }
  }

  function buildInterpretationExportPayload(run) {
    return {
      runId: run?.runId ?? run?.run_id ?? null,
      createdAt: run?.createdAt ?? run?.created_at ?? new Date().toISOString(),
      modelUsed: run?.modelUsed ?? run?.model_used ?? null,
      narrativeStatus: run?.narrativeStatus ?? run?.narrative_status ?? null,
      well: { wellId: run?.wellId ?? run?.well_id ?? "-" },
      range: {
        fromDepth: Number.isFinite(Number(run?.fromDepth ?? run?.from_depth))
          ? Number(run?.fromDepth ?? run?.from_depth)
          : null,
        toDepth: Number.isFinite(Number(run?.toDepth ?? run?.to_depth))
          ? Number(run?.toDepth ?? run?.to_depth)
          : null,
      },
      curves: Array.isArray(run?.curves) ? run.curves : [],
      deterministic: run?.deterministic ?? null,
      insight: run?.insight ?? null,
      narrative: run?.narrative ?? null,
    };
  }

  function handleDownloadJson() {
    if (!selectedRun) return;
    const payload = buildInterpretationExportPayload(selectedRun);
    const wellId = String(payload?.well?.wellId || "well").replace(/[^\w-]+/g, "_");
    exportInterpretationJson(payload, `interpretation_report_${wellId}.json`);
  }

  async function handleDownloadPdf() {
    if (!selectedRun) return;
    const payload = buildInterpretationExportPayload(selectedRun);
    try {
      setSelectedRunError("");
      await downloadInterpretationPdf(payload);
    } catch (e) {
      setSelectedRunError(e?.message || "PDF download failed");
    }
  }

  function answerFromInterpretation(q, run) {
    if (!run) return "Select an interpretation first.";
    const questionText = String(q || "").toLowerCase();
    const detLocal = run?.deterministic || {};
    const narLocal = run?.narrative || {};
    const insightLocal = run?.insight || {};

    if (/summary|overview/.test(questionText)) {
      return [
        `Well ${run?.wellId || run?.well_id || "-"} range ${Number(run?.fromDepth ?? run?.from_depth ?? 0).toFixed(0)} -> ${Number(run?.toDepth ?? run?.to_depth ?? 0).toFixed(0)} ft.`,
        `Global risk: ${detLocal?.severityBand || "-"}, data quality: ${detLocal?.dataQuality?.qualityBand || "-"}.`,
        `Event count: ${typeof detLocal?.eventCount === "number" ? detLocal.eventCount : "-"}.`,
      ].join(" ");
    }

    if (/risk|critical|danger/.test(questionText)) {
      return `Risk profile indicates ${detLocal?.severityBand || "-"} severity with ${detLocal?.dataQuality?.qualityBand || "-"} data quality. ${insightLocal?.riskProfile?.summary || ""}`.trim();
    }

    if (/recommend|action|next/.test(questionText)) {
      const recs = Array.isArray(narLocal?.recommendations) ? narLocal.recommendations : [];
      if (!recs.length) return "No recommendations were recorded for this interpretation.";
      return recs.map((r, i) => `${i + 1}. ${r}`).join(" ");
    }

    if (/interval|zone|where/.test(questionText)) {
      const intervals = Array.isArray(narLocal?.interval_explanations) ? narLocal.interval_explanations : [];
      if (!intervals.length) return "No interval explanations available in this interpretation.";
      const top = intervals[0];
      return `Top interval: ${top?.curve || "-"} ${Number(top?.fromDepth ?? 0).toFixed(0)} -> ${Number(top?.toDepth ?? 0).toFixed(0)} ft. ${top?.explanation || ""}`.trim();
    }

    return "I can answer about summary, risk, recommendations, intervals, and key findings for this interpretation.";
  }

  function sendQuestion() {
    if (!question.trim()) return;
    const userText = question.trim();
    const reply = answerFromInterpretation(userText, selectedRun);
    setMessages((prev) => [
      ...prev,
      { role: "user", text: userText },
      { role: "assistant", text: reply },
    ]);
    setQuestion("");
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle>Interpretation History</CardTitle>
            <CardDescription>History of AI interpretation runs.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={loadInterpretationHistory} disabled={interpHistoryLoading}>
            <IconRefresh className="mr-2 size-4" />
            Refresh
          </Button>
        </CardHeader>
        <CardContent>
          {interpHistoryError ? <p className="mb-3 text-sm text-rose-400">{interpHistoryError}</p> : null}
          <div className="mb-3 grid gap-2 md:grid-cols-4">
            <Input
              value={wellFilter}
              onChange={(e) => setWellFilter(e.target.value)}
              placeholder="Filter by well"
              className="copilot-input h-10"
            />
            <Input
              value={curveFilter}
              onChange={(e) => setCurveFilter(e.target.value)}
              placeholder="Filter by curve"
              className="copilot-input h-10"
            />
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="copilot-input h-10 w-full">
                <SelectValue placeholder="All status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All status</SelectItem>
                <SelectItem value="ok">ok</SelectItem>
                <SelectItem value="fallback">fallback</SelectItem>
                <SelectItem value="replayed">replayed</SelectItem>
                <SelectItem value="unknown">unknown</SelectItem>
              </SelectContent>
            </Select>
            <Select value={sortByDate} onValueChange={setSortByDate}>
              <SelectTrigger className="copilot-input h-10 w-full">
                <SelectValue placeholder="Date sort" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">Date: Newest first</SelectItem>
                <SelectItem value="oldest">Date: Oldest first</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="rounded-md border border-white/10">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Well</TableHead>
                  <TableHead>Range</TableHead>
                  <TableHead>Curves</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created At</TableHead>
                  <TableHead className="text-right">View</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!interpHistoryLoading && filteredSortedInterpHistory.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="h-20 text-center text-muted-foreground">
                      No interpretation history found.
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredSortedInterpHistory.slice(0, visibleInterpCount).map((run) => {
                    const rid = String(run?.runId ?? run?.run_id ?? "-");
                    const wellId = String(run?.wellId ?? run?.well_id ?? "-");
                    const from = Number(run?.fromDepth ?? run?.from_depth);
                    const to = Number(run?.toDepth ?? run?.to_depth);
                    const curves = Array.isArray(run?.curves) ? run.curves.join(", ") : "-";
                    const status = String(run?.narrativeStatus ?? run?.narrative_status ?? "-");
                    const createdAt = run?.createdAt ?? run?.created_at;

                    return (
                      <TableRow key={rid}>
                        <TableCell className="font-medium">{wellId}</TableCell>
                        <TableCell>
                          {Number.isFinite(from) ? from.toFixed(0) : "-"} {"->"} {Number.isFinite(to) ? to.toFixed(0) : "-"}
                        </TableCell>
                        <TableCell className="max-w-[300px] truncate">{curves || "-"}</TableCell>
                        <TableCell>{status}</TableCell>
                        <TableCell>{createdAt ? new Date(createdAt).toLocaleString() : "-"}</TableCell>
                        <TableCell className="text-right">
                          <Button
                            variant="outline"
                            size="icon"
                            disabled={!rid || rid === "-"}
                            onClick={() => handleViewInterpretation(rid)}
                            title="View interpretation"
                          >
                            <IconEye className="size-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
          {filteredSortedInterpHistory.length > visibleInterpCount ? (
            <div className="mt-3">
              <Button variant="outline" onClick={() => setVisibleInterpCount((v) => v + 5)}>
                Show more (next 5)
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Interpretation Preview</CardTitle>
          <CardDescription>
            {selectedRun ? `Run ID: ${selectedRun?.runId || selectedRun?.run_id || "-"}` : "Click eye icon to view an interpretation."}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {selectedRunError ? <p className="text-sm text-rose-400">{selectedRunError}</p> : null}
          {selectedRunLoading ? <p className="text-sm text-zinc-400">Loading interpretation...</p> : null}
          {!selectedRunLoading && !selectedRun ? (
            <p className="text-sm text-muted-foreground">No interpretation selected.</p>
          ) : null}

          {selectedRun ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={handleDownloadJson}>
                  Download JSON
                </Button>
                <Button variant="outline" onClick={handleDownloadPdf}>
                  Download PDF
                </Button>
              </div>

              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                {summaryCards.map((card) => (
                  <div key={card.title} className="dash-panel">
                    <p className="text-sm text-zinc-400">{card.title}</p>
                    <p className="mt-2 text-3xl font-bold tracking-tight text-zinc-100">{card.value}</p>
                    <p className="mt-2 text-xs text-zinc-500">{card.hint}</p>
                  </div>
                ))}
              </div>

              <InsightSection insight={insight} selectedWellId={selectedRun?.wellId || selectedRun?.well_id || "-"} />
              <NarrativeSection det={det} nar={nar} onJumpToInterval={() => {}} />
            </>
          ) : null}
        </CardContent>
      </Card>

      <Card className="rounded-2xl border-white/15 bg-zinc-950/70">
        <CardHeader>
          <CardTitle>Ask Interpretation</CardTitle>
          <CardDescription>Q&A grounded in selected interpretation data.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="copilot-chat space-y-2">
            {messages.map((message, index) => (
              <div key={`${message.role}-${index}`} className="text-sm leading-relaxed">
                <Badge variant="outline" className="mr-2 rounded-full border-white/20 bg-zinc-900 px-3 py-1 text-zinc-200">
                  {message.role}
                </Badge>
                <span className={message.role === "assistant" ? "text-zinc-300" : "text-zinc-100"}>
                  {message.text}
                </span>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Ask anything about selected interpretation"
              className="copilot-input"
              onKeyDown={(event) => {
                if (event.key === "Enter") sendQuestion();
              }}
            />
            <Button
              onClick={sendQuestion}
              className="h-11 rounded-xl bg-zinc-100 px-6 text-base text-zinc-950 hover:bg-white"
            >
              Send
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
