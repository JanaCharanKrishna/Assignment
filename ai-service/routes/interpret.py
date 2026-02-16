from fastapi import APIRouter

from app.analysis import analyze
from app.schemas import InterpretRequest

router = APIRouter(tags=["interpret"])


@router.get("/health")
def health() -> dict:
    return {"ok": True}


@router.post("/interpret")
def interpret(req: InterpretRequest) -> dict:
    lo = min(req.fromDepth, req.toDepth)
    hi = max(req.fromDepth, req.toDepth)

    deterministic, insight = analyze(
        rows=req.rows,
        curves=req.curves,
        from_depth=lo,
        to_depth=hi,
        well_id=req.wellId,
    )

    return {
        "ok": True,
        "deterministic": deterministic,
        "insight": insight,
    }
