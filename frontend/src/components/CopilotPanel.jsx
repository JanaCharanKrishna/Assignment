import React from "react";
import { askCopilot } from "../services/api";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { presetQuestion, safeArr, toNum } from "./copilot/copilot-utils.jsx";

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

export default function CopilotPanel({
  selectedWellId,
  selectedMetrics,
  lastRunRange,
  interpResult,
  selectedInterval,
}) {
  const initialMessage = React.useMemo(
    () => ({
      role: "assistant",
      text: "Ask about interval flags or operational actions. I will answer from interpreted evidence.",
    }),
    []
  );
  const [mode, setMode] = React.useState("data_qa");
  const [question, setQuestion] = React.useState(presetQuestion("data_qa"));
  const [loading, setLoading] = React.useState(false);
  const [messages, setMessages] = React.useState([initialMessage]);

  const chatEndRef = React.useRef(null);

  React.useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, loading]);

  React.useEffect(() => {
    setQuestion(presetQuestion(mode));
  }, [mode]);

  function onClearChat() {
    setMessages([initialMessage]);
    setQuestion(presetQuestion(mode));
  }

  const canAsk =
    !!selectedWellId &&
    !!lastRunRange &&
    !!interpResult &&
    typeof interpResult === "object" &&
    !!interpResult?.deterministic &&
    typeof interpResult.deterministic === "object" &&
    Object.keys(interpResult.deterministic).length > 0 &&
    Number.isFinite(Number(lastRunRange?.fromDepth)) &&
    Number.isFinite(Number(lastRunRange?.toDepth));

  async function onAsk() {
    const userText = String(question || "").trim() || presetQuestion(mode);
    setMessages((prev) => [...prev, { role: "user", text: userText }]);
    setQuestion("");

    if (!canAsk) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: "Run interpretation first so Copilot has deterministic evidence context.",
        },
      ]);
      return;
    }

    try {
      setLoading(true);

      const rangeFrom = Number(lastRunRange.fromDepth);
      const rangeTo = Number(lastRunRange.toDepth);
      const baselineWidth = 500;

      const payload = {
        mode,
        question: userText,
        wellId: selectedWellId,
        fromDepth: rangeFrom,
        toDepth: rangeTo,
        selectedInterval:
          selectedInterval &&
          Number.isFinite(Number(selectedInterval.fromDepth)) &&
          Number.isFinite(Number(selectedInterval.toDepth))
            ? {
                fromDepth: Number(selectedInterval.fromDepth),
                toDepth: Number(selectedInterval.toDepth),
              }
            : null,
        deterministic: interpResult?.deterministic || {},
        insight: interpResult?.insight || {},
        narrative: interpResult?.narrative || {},
        curves: Array.isArray(selectedMetrics) ? selectedMetrics : [],
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
    <div className="copilot-shell mb-4 mt-2">
      <h3 className="text-xl font-semibold text-zinc-100">Ask Copilot</h3>
      <p className="mb-3 text-sm text-zinc-400">Chat grounded in interpreted interval evidence.</p>

      <div className="copilot-chat space-y-3">
        {messages.map((message, index) => (
          <div key={`${message.role}-${index}`} className="text-sm leading-relaxed">
            <span className="mr-2 inline-flex rounded-full border border-white/20 bg-zinc-900 px-3 py-1 text-sm font-semibold text-zinc-100">
              {message.role}
            </span>
            <span className="whitespace-pre-wrap text-zinc-200">{message.text}</span>
          </div>
        ))}
        {loading ? (
          <div className="text-sm leading-relaxed">
            <span className="mr-2 inline-flex rounded-full border border-white/20 bg-zinc-900 px-3 py-1 text-sm font-semibold text-zinc-100">
              assistant
            </span>
            <span className="text-zinc-400">Thinking...</span>
          </div>
        ) : null}
        <div ref={chatEndRef} />
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Select value={mode} onValueChange={setMode}>
          <SelectTrigger className="copilot-input min-w-[180px]">
            <SelectValue placeholder="Mode" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="data_qa">Data Q&A</SelectItem>
            <SelectItem value="ops">Ops</SelectItem>
          </SelectContent>
        </Select>

        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about flagged interval, risks, or next actions"
          className="copilot-input min-w-[320px] flex-1"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !loading) onAsk();
          }}
        />

        <button
          onClick={onAsk}
          disabled={loading}
          className="inline-flex h-11 items-center justify-center rounded-xl bg-zinc-100 px-6 text-base font-medium text-zinc-950 transition hover:bg-white disabled:opacity-50"
        >
          Send
        </button>
        <button
          onClick={onClearChat}
          disabled={loading}
          className="dash-btn"
          type="button"
        >
          Clear Chat
        </button>
      </div>
    </div>
  );
}
