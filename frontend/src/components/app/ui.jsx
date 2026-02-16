import React from "react";

export function Badge({ children, tone = "neutral" }) {
  const map = {
    neutral: "border-white/15 bg-white/5 text-zinc-200",
    green: "border-emerald-500/35 bg-emerald-500/10 text-emerald-300",
    yellow: "border-amber-500/35 bg-amber-500/10 text-amber-300",
    red: "border-rose-500/35 bg-rose-500/10 text-rose-300",
    blue: "border-sky-500/35 bg-sky-500/10 text-sky-300",
  };
  const cls = map[tone] || map.neutral;

  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-wide ${cls}`}>
      {children}
    </span>
  );
}

export function toneForRisk(risk) {
  const x = String(risk || "").toLowerCase();
  if (x.includes("critical")) return "red";
  if (x.includes("high")) return "red";
  if (x.includes("moderate") || x.includes("med")) return "yellow";
  if (x.includes("low")) return "green";
  return "neutral";
}

export function toneForProbability(p) {
  const x = String(p || "").toLowerCase();
  if (x === "high") return "red";
  if (x === "medium" || x === "med") return "yellow";
  if (x === "low") return "green";
  return "neutral";
}

export function toneForStability(stability) {
  const x = String(stability || "").toLowerCase();
  if (x === "stable") return "green";
  if (x === "moderate") return "yellow";
  if (x === "unstable") return "red";
  return "neutral";
}

export function fmtNum(v, digits = 3) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : "-";
}

export function fmtMaybe(v, digits = 3) {
  if (v === null || v === undefined) return "-";
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : String(v);
}

export function isSameRange(a, b, tol = 1e-6) {
  if (!a || !b) return true;
  return (
    Math.abs(Number(a.fromDepth) - Number(b.fromDepth)) <= tol &&
    Math.abs(Number(a.toDepth) - Number(b.toDepth)) <= tol
  );
}

export function pickRunId(r) {
  return String(r?.runId ?? r?.run_id ?? r?.id ?? "").trim();
}

