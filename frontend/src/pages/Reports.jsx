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
  askCopilot,
  downloadInterpretationPdf,
  exportInterpretationJson,
  getInterpretationRun,
  listInterpretationRuns,
} from "@/services/api";
import { presetQuestion, safeArr, toNum } from "@/components/copilot/copilot-utils.jsx";

function formatCopilotResponse(response, mode) {
  const result = response?.json || {};
  const lines = [];

  lines.push(`${result?.answer_title || "Copilot Answer"}`);
  lines.push(result?.direct_answer || "No direct answer returned.");

  const keyPoints = safeArr(result?.key_points);
  if (keyPoints.length) {
    lines.push("");
    lines.push("Key points:");
    for (const point of keyPoints) lines.push(`- ${point}`);
  }

  const actions = safeArr(result?.actions);
  if (actions.length) {
    lines.push("");
    lines.push("Recommended actions:");
    actions.forEach((action, index) => {
      const priority = String(action?.priority || "medium").toUpperCase();
      const text = action?.action || "-";
      const rationale = action?.rationale ? ` | Why: ${action.rationale}` : "";
      lines.push(`${index + 1}. [${priority}] ${text}${rationale}`);
    });
  }

  if (mode === "compare" && result?.comparison) {
    const compareSummary = result?.comparison?.summary;
    const deltas = safeArr(result?.comparison?.delta_metrics);
    lines.push("");
    lines.push("Comparison:");
    if (compareSummary) lines.push(compareSummary);
    deltas.forEach((delta) => {
      lines.push(
        `- ${delta?.metric || "metric"}: current=${delta?.current ?? "-"}, baseline=${delta?.baseline ?? "-"}, delta=${delta?.delta ?? "-"}`
      );
    });
  }

  const risks = safeArr(result?.risks);
  if (risks.length) {
    lines.push("");
    lines.push("Risks:");
    risks.forEach((risk) => lines.push(`- ${risk}`));
  }

  const uncertainties = safeArr(result?.uncertainties);
  if (uncertainties.length) {
    lines.push("");
    lines.push("Uncertainties:");
    uncertainties.forEach((item) => lines.push(`- ${item}`));
  }

  const confidence = result?.confidence || {};
  lines.push("");
  lines.push(
    `Confidence: ${confidence?.rubric || "-"} (${toNum(confidence?.overall, 2)})${confidence?.reason ? ` | ${confidence.reason}` : ""}`
  );

  const evidence = response?.evidence || null;
  const wellId = evidence?.context_meta?.wellId || "-";
  const fromDepth = toNum(evidence?.context_meta?.range?.fromDepth, 0);
  const toDepth = toNum(evidence?.context_meta?.range?.toDepth, 0);

  const schemaLabel =
    response?.schema_valid === false
      ? "fallback repaired"
      : response?.schema_valid === true
      ? "valid"
      : "-";

  lines.push(
    `Meta: source=${response?.source || "-"}, evidence=${response?.evidence_strength || "-"}, schema=${schemaLabel}, latency=${Number.isFinite(Number(response?.latency_ms)) ? `${toNum(response.latency_ms, 0)} ms` : "-"}`
  );
  lines.push(`Context: well=${wellId}, range=${fromDepth} -> ${toDepth}`);

  if (result?.safety_note) {
    lines.push("");
    lines.push(`Safety: ${result.safety_note}`);
  }

  return lines.join("\n");
}

export default function Reports() {
  const initialMessage = React.useMemo(
    () => ({
      role: "assistant",
      text: "Select an interpretation from the table, then ask about interval flags or operational actions.",
    }),
    []
  );
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
  const [mode, setMode] = React.useState("data_qa");
  const [question, setQuestion] = React.useState(presetQuestion("data_qa"));
  const [messages, setMessages] = React.useState([initialMessage]);
  const [loading, setLoading] = React.useState(false);

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

  React.useEffect(() => {
    setQuestion(presetQuestion(mode));
  }, [mode]);

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
      setMessages([{ role: "assistant", text: `Loaded interpretation ${runId}. Ask Copilot about this interpretation.` }]);
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

  const canAsk =
    !!selectedRun &&
    !!selectedRun?.wellId &&
    Number.isFinite(Number(selectedRun?.fromDepth)) &&
    Number.isFinite(Number(selectedRun?.toDepth)) &&
    !!selectedRun?.deterministic &&
    typeof selectedRun.deterministic === "object" &&
    Object.keys(selectedRun.deterministic).length > 0;

  async function sendQuestion() {
    const userText = String(question || "").trim() || presetQuestion(mode);
    setMessages((prev) => [...prev, { role: "user", text: userText }]);
    setQuestion("");

    if (!canAsk) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: "Select and load a valid interpretation first so Copilot has deterministic evidence context." },
      ]);
      return;
    }

    try {
      setLoading(true);
      const rangeFrom = Number(selectedRun.fromDepth);
      const baselineWidth = 500;
      const interval = Array.isArray(selectedRun?.narrative?.interval_explanations)
        ? selectedRun.narrative.interval_explanations[0]
        : null;
      const selectedInterval =
        interval &&
        Number.isFinite(Number(interval?.fromDepth)) &&
        Number.isFinite(Number(interval?.toDepth))
          ? {
              fromDepth: Number(interval.fromDepth),
              toDepth: Number(interval.toDepth),
            }
          : null;

      const payload = {
        mode,
        question: userText,
        wellId: selectedRun.wellId,
        fromDepth: Number(selectedRun.fromDepth),
        toDepth: Number(selectedRun.toDepth),
        selectedInterval,
        deterministic: selectedRun?.deterministic || {},
        insight: selectedRun?.insight || {},
        narrative: selectedRun?.narrative || {},
        curves: Array.isArray(selectedRun?.curves) ? selectedRun.curves : [],
        baseline: {
          widthFt: baselineWidth,
          range: {
            fromDepth: rangeFrom - baselineWidth,
            toDepth: rangeFrom,
          },
          deterministic: {},
        },
      };

      const out = await askCopilot(payload);
      const assistantText = formatCopilotResponse(out, mode);
      setMessages((prev) => [...prev, { role: "assistant", text: assistantText }]);
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: e?.message || "Copilot failed" },
      ]);
    } finally {
      setLoading(false);
    }
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
            {loading ? (
              <div className="text-sm leading-relaxed">
                <Badge variant="outline" className="mr-2 rounded-full border-white/20 bg-zinc-900 px-3 py-1 text-zinc-200">
                  assistant
                </Badge>
                <span className="text-zinc-400">Thinking...</span>
              </div>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Select value={mode} onValueChange={setMode}>
              <SelectTrigger className="copilot-input h-11 min-w-[180px]">
                <SelectValue placeholder="Mode" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="data_qa">Data Q&A</SelectItem>
                <SelectItem value="ops">Ops</SelectItem>
              </SelectContent>
            </Select>
            <Input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="Ask anything about selected interpretation"
              className="copilot-input min-w-[320px] flex-1"
              onKeyDown={(event) => {
                if (event.key === "Enter" && !loading) sendQuestion();
              }}
            />
            <Button
              onClick={sendQuestion}
              disabled={loading}
              className="h-11 rounded-xl bg-zinc-100 px-6 text-base text-zinc-950 hover:bg-white"
            >
              Send
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setMessages([initialMessage]);
                setQuestion(presetQuestion(mode));
              }}
              disabled={loading}
              className="h-11 rounded-xl"
            >
              Clear Chat
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
