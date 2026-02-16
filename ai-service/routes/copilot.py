# app/routes/copilot.py
import json
import logging
from fastapi import APIRouter
from pydantic import BaseModel, Field
from typing import Any, Dict, List

from app.ai_client import chat_with_data_verbose

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/copilot", tags=["copilot"])


class CopilotReq(BaseModel):
    mode: str = "data_qa"
    question: str
    wellId: str
    fromDepth: float
    toDepth: float
    curves: List[str] = Field(default_factory=list)

    # OPTIONAL (if you already have them, send them)
    statistics: Dict[str, Any] = Field(default_factory=dict)
    rows: List[Dict[str, Any]] = Field(default_factory=list)

    # your existing evidence object (optional)
    evidence: Dict[str, Any] = Field(default_factory=dict)

    detail_level: int = 3
    history: List[Dict[str, str]] = Field(default_factory=list)


def _build_well_summary(req: CopilotReq) -> str:
    # Short, stable summary string
    return (
        f"Well={req.wellId}, Interval={req.fromDepth}-{req.toDepth}, "
        f"Curves={', '.join(req.curves) if req.curves else 'n/a'}"
    )


def _build_data_context(req: CopilotReq) -> str:
    """
    Friend-style: data_context is the ONLY trusted evidence. Keep it compact.
    Uses:
      - statistics (if provided)
      - sample rows (if provided)
      - else fall back to req.evidence
    """
    ctx = {
        "wellId": req.wellId,
        "range": {"fromDepth": req.fromDepth, "toDepth": req.toDepth},
        "curves": req.curves,
    }

    if req.statistics:
        ctx["statistics"] = req.statistics

    if req.rows:
        # keep rows small
        ctx["sample_rows"] = req.rows[:40]

    # include evidence if present (but it might be empty in your current pipeline)
    if req.evidence:
        ctx["evidence"] = req.evidence

    return json.dumps(ctx, ensure_ascii=False, indent=2)


@router.post("/query")
async def copilot_query(req: CopilotReq):
    well_summary = _build_well_summary(req)
    data_context = _build_data_context(req)

    # If you want: "Tell me a summary" -> standard question
    msg = req.question or "Give a concise technical summary."

    result = chat_with_data_verbose(
        well_name=req.wellId,
        message=msg,
        history=req.history,
        well_summary=well_summary,
        data_context=data_context,
        detail_level=req.detail_level,
    )
    source = str(result.get("source", "fallback"))
    llm_used = bool(result.get("llm_used", False))
    provider = result.get("provider")
    model = result.get("model")
    llm_error = result.get("llm_error")
    answer = str(result.get("answer", "No response was generated."))

    logger.info(
        "copilot.query source=%s llm_used=%s provider=%s model=%s wellId=%s mode=%s",
        source,
        llm_used,
        provider,
        model,
        req.wellId,
        req.mode,
    )
    if llm_error:
        logger.warning("copilot.query llm_error=%s", llm_error)

    return {
        "ok": True,
        "source": source,
        "llm_used": llm_used,
        "provider": provider,
        "model": model,
        "llm_error": llm_error,
        "wellId": req.wellId,
        "range": {"fromDepth": req.fromDepth, "toDepth": req.toDepth},
        "curves": req.curves,
        "answer": answer,
    }

