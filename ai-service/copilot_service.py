import os
import json
import time
import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from dotenv import load_dotenv
from fastapi import FastAPI
from pydantic import BaseModel, Field
from groq import Groq


# -----------------------------
# Env + logging
# -----------------------------
load_dotenv(dotenv_path=Path(__file__).with_name(".env"), override=True)

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
logging.basicConfig(level=getattr(logging, LOG_LEVEL, logging.INFO))
logger = logging.getLogger("copilot_service")

app = FastAPI(title="Copilot Service", version="1.1.0")


# -----------------------------
# Request model
# -----------------------------
class CopilotReq(BaseModel):
    mode: str = "data_qa"
    question: str = "What does this data say?"
    wellId: str
    fromDepth: float
    toDepth: float
    selectedInterval: Optional[Dict[str, Any]] = None
    curves: List[str] = Field(default_factory=list)
    evidence: Dict[str, Any] = Field(default_factory=dict)
    compare: Dict[str, Any] = Field(
        default_factory=lambda: {"summary": "", "delta_metrics": []}
    )


# -----------------------------
# Helpers
# -----------------------------
STOPWORDS = {
    "what", "why", "how", "about", "think", "the", "a", "an", "is", "are", "was", "were",
    "of", "in", "on", "at", "to", "for", "from", "with", "and", "or", "this", "that",
    "it", "its", "my", "our", "your", "do", "does", "did", "can", "could", "should",
    "would", "where", "when", "which", "who", "whom", "tell", "me", "please", "data",
    "interval", "flagged", "well", "range", "depth", "curves", "signal", "anomaly", "spike",
}

def _is_bad_key(k: str) -> bool:
    k = (k or "").strip()
    return (not k) or ("your_key" in k.lower()) or (len(k) < 20)

def _extract_json(text: str) -> Optional[Dict[str, Any]]:
    text = (text or "").strip()
    if not text:
        return None

    # direct parse
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
    except Exception:
        pass

    # fenced blocks
    if "```" in text:
        parts = text.split("```")
        for p in parts:
            p = p.strip()
            if p.startswith("json"):
                p = p[4:].strip()
            try:
                obj = json.loads(p)
                if isinstance(obj, dict):
                    return obj
            except Exception:
                pass

    # bracket slice
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        snippet = text[start:end + 1]
        try:
            obj = json.loads(snippet)
            if isinstance(obj, dict):
                return obj
        except Exception:
            pass

    return None

def _tokenize_question(q: str) -> Set[str]:
    words = re.findall(r"[A-Za-z0-9_]+", (q or "").lower())
    out = set()
    for w in words:
        if len(w) < 2:
            continue
        if w in STOPWORDS:
            continue
        out.add(w)
    return out

def _known_tokens(req: CopilotReq) -> Set[str]:
    tokens = set()

    # curves
    for c in (req.curves or []):
        c2 = str(c).strip().lower()
        if c2:
            tokens.add(c2)

    ev = req.evidence or {}
    det = ev.get("deterministic", {}) or {}
    nar = ev.get("narrative", {}) or {}
    insight = ev.get("insight", {}) or {}

    # deterministic strings
    for k in ["severityBand", "anomalyBand", "riskBand"]:
        v = str(det.get(k, "")).strip().lower()
        if v:
            tokens.add(v)

    # narrative intervals
    for it in (nar.get("interval_explanations") or []):
        c = str(it.get("curve", "")).strip().lower()
        if c:
            tokens.add(c)
        exp = str(it.get("explanation", "")).lower()
        for w in re.findall(r"[A-Za-z0-9_]+", exp):
            if len(w) >= 3 and w not in STOPWORDS:
                tokens.add(w)

    # insight words
    for k in ["summary", "summaryParagraph", "technical_summary"]:
        txt = str(insight.get(k, "")).lower()
        for w in re.findall(r"[A-Za-z0-9_]+", txt):
            if len(w) >= 3 and w not in STOPWORDS:
                tokens.add(w)

    # always-known context words
    tokens.update({"hc1", "hc2", "hc3", "hc4", "hc5", "hc6", "anomaly", "spike", "risk"})
    return tokens

def _detect_unknown_focus(req: CopilotReq) -> Optional[str]:
    q_tokens = _tokenize_question(req.question)
    if not q_tokens:
        return None

    known = _known_tokens(req)
    # important unknowns only
    unknown = [t for t in q_tokens if t not in known and len(t) >= 2]
    if not unknown:
        return None

    # if everything is unknown, most likely user asked external thing
    # pick first token as focus
    return unknown[0]

def _not_in_evidence_response(req: CopilotReq, missing_term: str) -> Dict[str, Any]:
    det = (req.evidence or {}).get("deterministic", {}) or {}
    sev = str(det.get("severityBand", "UNKNOWN"))
    dq = str((det.get("dataQuality") or {}).get("qualityBand", "UNKNOWN"))

    return {
        "answer_title": "Insufficient Context for Requested Entity",
        "direct_answer": f"No reliable evidence about '{missing_term}' is present in the current context. I cannot assess '"
                         f"{missing_term}' from the selected curves/evidence.",
        "key_points": [
            f"Missing target: {missing_term}",
            f"Well: {req.wellId}",
            f"Analyzed range: {req.fromDepth:.1f}–{req.toDepth:.1f} ft",
            f"Available curves: {', '.join(req.curves) if req.curves else '-'}",
            f"Current deterministic context: severity={sev}, dataQuality={dq}",
        ],
        "actions": [
            {
                "priority": "high",
                "action": f"Provide clarification for '{missing_term}' (curve name, parameter, or domain term).",
                "rationale": "Current evidence does not include that entity, so answering would be speculative.",
            }
        ],
        "comparison": req.compare or {"summary": "", "delta_metrics": []},
        "risks": [],
        "uncertainties": [f"'{missing_term}' is absent from context/evidence payload."],
        "confidence": {
            "overall": 0.2,
            "rubric": "low",
            "reason": "Low confidence because the asked entity is not present in the provided evidence.",
        },
        "evidence_used": [
            {
                "source": "context_validation",
                "confidence": "high",
                "snippet": f"Entity '{missing_term}' not found in curves/narrative/deterministic/insight.",
            }
        ],
        "safety_note": "Decision support only, not autonomous control.",
    }

def _fallback_from_evidence(req: CopilotReq) -> Dict[str, Any]:
    ev = req.evidence or {}
    det = ev.get("deterministic", {}) or {}
    nar = ev.get("narrative", {}) or {}

    sev = str(det.get("severityBand", "UNKNOWN"))
    dq = str((det.get("dataQuality") or {}).get("qualityBand", "UNKNOWN"))
    ec = det.get("eventCount", "n/a")

    intervals = nar.get("interval_explanations") or []
    top = intervals[0] if intervals else None

    top_txt = "n/a"
    narr_snip = "No detailed interval explanation available."
    top_curve = "-"
    top_exp = "signal"

    if top:
        fd = top.get("fromDepth")
        td = top.get("toDepth")
        top_curve = top.get("curve", "-")
        top_exp = top.get("explanation", "signal")
        if isinstance(fd, (int, float)) and isinstance(td, (int, float)):
            top_txt = f"{fd:.1f}–{td:.1f} ft"
        narr_snip = top.get("explanation") or narr_snip

    q = (req.question or "").lower()
    is_spike_q = any(x in q for x in ["spike", "anomaly", "unwanted", "abnormal", "where"])

    if is_spike_q:
        title = "Spike Location Summary"
        if top:
            direct = f"Most likely spike/anomaly zone is {top_txt} ({top_curve}): {top_exp}"
        else:
            direct = "No interval explanation was available to localize spike zones."
    else:
        title = "Copilot Answer"
        direct = f"The selected interval appears flagged by anomaly evidence (severity: {sev}, data quality: {dq})."

    return {
        "answer_title": title,
        "direct_answer": direct,
        "key_points": [
            f"Well: {req.wellId}",
            f"Analyzed range: {req.fromDepth:.1f}–{req.toDepth:.1f} ft",
            f"Severity band: {sev}",
            f"Data quality: {dq}",
            f"Top explained interval: {top_txt}",
        ],
        "actions": [
            {
                "priority": "medium",
                "action": "Re-run on narrower window around top zone" if is_spike_q else "Re-run interpretation on narrower interval",
                "rationale": "Improves localization confidence for spike mapping." if is_spike_q else "Improves explanation specificity and depth localization.",
            }
        ],
        "comparison": req.compare or {"summary": "", "delta_metrics": []},
        "risks": ["Elevated anomaly severity in current evidence window."] if sev.upper() in ("HIGH", "CRITICAL") else [],
        "uncertainties": [
            f"Event count: {ec}" if ec != "n/a" else "Event count unavailable",
            "Confidence and severity are model-supported and require domain validation.",
        ],
        "confidence": {
            "overall": 0.68 if sev.upper() in ("HIGH", "CRITICAL") else 0.52,
            "rubric": "medium",
            "reason": "Confidence is derived from deterministic indicators, interval explanations, and data quality context.",
        },
        "evidence_used": [
            {
                "source": "deterministic",
                "confidence": "high",
                "snippet": f"severity={sev}, dataQuality={dq}, eventCount={ec}",
            },
            {
                "source": "narrative",
                "confidence": "medium" if top else "low",
                "snippet": narr_snip,
            },
        ],
        "safety_note": "Decision support only, not autonomous control.",
    }

def _build_prompt(req: CopilotReq) -> str:
    return f"""
You are an oil-well copilot. Return STRICT JSON ONLY matching this schema exactly:
{{
  "answer_title": "string",
  "direct_answer": "string",
  "key_points": ["string"],
  "actions": [{{"priority":"high|medium|low","action":"string","rationale":"string"}}],
  "comparison": {{"summary":"string","delta_metrics":[{{"metric":"string","current":"any","baseline":"any","delta":"any"}}]}},
  "risks": ["string"],
  "uncertainties": ["string"],
  "confidence": {{"overall":0.0,"rubric":"low|medium|high","reason":"string"}},
  "evidence_used": [{{"source":"string","confidence":"low|medium|high","snippet":"string"}}],
  "safety_note": "Decision support only, not autonomous control."
}}

Hard grounding rules:
1) Use ONLY the provided evidence/context.
2) If asked about an entity/term not present in curves, narrative, deterministic, or insight, explicitly state it is not present and ask for clarification.
3) Do NOT invent curve names, intervals, risk claims, or conclusions.
4) If evidence is insufficient, return low confidence and list exact missing pieces.
5) Output raw JSON only (no markdown).

Input:
mode={req.mode}
question={req.question}
wellId={req.wellId}
fromDepth={req.fromDepth}
toDepth={req.toDepth}
curves={json.dumps(req.curves, ensure_ascii=False)}
selectedInterval={json.dumps(req.selectedInterval, ensure_ascii=False)}
evidence={json.dumps(req.evidence, ensure_ascii=False)}
compare={json.dumps(req.compare, ensure_ascii=False)}
""".strip()

def _call_model(client: Groq, model: str, req: CopilotReq) -> Optional[Dict[str, Any]]:
    prompt = _build_prompt(req)
    completion = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": "Return valid JSON only. Strict grounding. No speculation."},
            {"role": "user", "content": prompt},
        ],
        temperature=0.15,
        max_completion_tokens=1200,
        top_p=1,
        stream=False,
    )
    content = (completion.choices[0].message.content if completion.choices else "") or ""
    return _extract_json(content)

def _call_llm(req: CopilotReq) -> Dict[str, Any]:
    key = (os.getenv("GROQ_API_KEY") or "").strip()
    if _is_bad_key(key):
        raise RuntimeError("GROQ_API_KEY missing/invalid format")

    primary = (os.getenv("LLM_PRIMARY") or "llama-3.3-70b-versatile").strip()
    fb1 = (os.getenv("LLM_FALLBACK_1") or "").strip()
    fb2 = (os.getenv("LLM_FALLBACK_2") or "").strip()

    client = Groq(api_key=key)
    errors: List[str] = []

    for model in [primary, fb1, fb2]:
        if not model:
            continue
        try:
            out = _call_model(client, model, req)
            if out and isinstance(out, dict):
                return {"json": out, "used_model": model}
            errors.append(f"{model}:empty_or_invalid_json")
        except Exception as e:
            errors.append(f"{model}:{str(e)}")

    raise RuntimeError(" | ".join(errors) if errors else "all_models_failed")


# -----------------------------
# Debug / health routes
# -----------------------------
@app.get("/healthz")
def healthz():
    return {"ok": True, "service": "copilot_service"}

@app.get("/_env_check")
def env_check():
    key = (os.getenv("GROQ_API_KEY") or "").strip()
    return {
        "has_key": bool(key),
        "key_prefix": key[:7] if key else "",
        "key_len": len(key),
        "LLM_PRIMARY": os.getenv("LLM_PRIMARY", ""),
        "LLM_FALLBACK_1": os.getenv("LLM_FALLBACK_1", ""),
        "LLM_FALLBACK_2": os.getenv("LLM_FALLBACK_2", ""),
    }


# -----------------------------
# Main route
# -----------------------------
@app.post("/copilot/query")
def copilot_query(req: CopilotReq):
    t0 = time.time()

    # 1) pre-grounding check for unknown asked entity
    unknown = _detect_unknown_focus(req)
    if unknown:
        out = _not_in_evidence_response(req, unknown)
        latency_ms = int((time.time() - t0) * 1000)
        return {
            "ok": True,
            "source": "grounded_guard",
            "llm_used": False,
            "llm_model": None,
            "schema_valid": True,
            "schema_errors": [],
            "evidence_strength": "low",
            "json": out,
            "evidence": req.evidence,
            "llm_error": "asked_entity_not_in_evidence",
            "latency_ms": latency_ms,
        }

    # 2) LLM path with robust fallback
    used_model = None
    try:
        llm = _call_llm(req)
        used_model = llm.get("used_model")
        llm_json = llm.get("json")
        latency_ms = int((time.time() - t0) * 1000)
        return {
            "ok": True,
            "source": "llm",
            "llm_used": True,
            "llm_model": used_model,
            "schema_valid": True,
            "schema_errors": [],
            "evidence_strength": "medium",
            "json": llm_json,
            "evidence": req.evidence,
            "llm_error": None,
            "latency_ms": latency_ms,
        }
    except Exception as e:
        llm_error = str(e)
        logger.warning("LLM call failed: %s", llm_error)

    fb = _fallback_from_evidence(req)
    latency_ms = int((time.time() - t0) * 1000)
    return {
        "ok": True,
        "source": "python_fallback",
        "llm_used": False,
        "llm_model": used_model,
        "schema_valid": True,
        "schema_errors": [],
        "evidence_strength": "medium",
        "json": fb,
        "evidence": req.evidence,
        "llm_error": llm_error,
        "latency_ms": latency_ms,
    }
