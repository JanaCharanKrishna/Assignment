from pydantic import BaseModel, Field
from typing import Dict, List, Optional


class Row(BaseModel):
    depth: float
    values: Dict[str, Optional[float]]


class InterpretRequest(BaseModel):
    wellId: str
    fromDepth: float
    toDepth: float
    curves: List[str] = Field(min_length=1)
    rows: List[Row] = Field(min_length=20)
