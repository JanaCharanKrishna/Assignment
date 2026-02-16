import { Badge } from "../app/ui.jsx";

function toneForPriority(p) {
  const x = String(p || "").toLowerCase();
  if (x === "high") return "red";
  if (x === "medium") return "yellow";
  if (x === "low") return "green";
  return "neutral";
}

function toneForConfidence(c) {
  const x = String(c || "").toLowerCase();
  if (x === "high") return "green";
  if (x === "medium") return "yellow";
  if (x === "low") return "red";
  return "neutral";
}

function toNum(v, digits = 3) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : "-";
}

function safeArr(v) {
  return Array.isArray(v) ? v : [];
}

function presetQuestion(mode) {
  if (mode === "data_qa") return "Why is interval flagged?";
  if (mode === "ops") return "What should drilling engineer inspect next?";
  return "Compare current interval vs previous 500 ft.";
}

export { Badge, toneForPriority, toneForConfidence, toNum, safeArr, presetQuestion };
