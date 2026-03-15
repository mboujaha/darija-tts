from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional

from server import db
from server.config import DIALECTS

router = APIRouter(prefix="/api/sources", tags=["sources"])

VALID_SOURCE_TYPES = {"channel", "playlist", "video"}


class SourceCreate(BaseModel):
    url: str
    source_type: str
    dialect: str
    max_videos: int = 50
    notes: Optional[str] = None


class SourceUpdate(BaseModel):
    url: Optional[str] = None
    source_type: Optional[str] = None
    dialect: Optional[str] = None
    max_videos: Optional[int] = None
    notes: Optional[str] = None


@router.get("/")
async def list_sources():
    all_sources = await db.get_sources()
    grouped = {d: [] for d in DIALECTS}
    for s in all_sources:
        dialect = s.get("dialect")
        if dialect in grouped:
            grouped[dialect].append(s)
    return {"sources": grouped}


@router.post("/", status_code=201)
async def create_source(body: SourceCreate):
    if body.dialect not in DIALECTS:
        raise HTTPException(400, detail=f"Invalid dialect. Must be one of: {DIALECTS}")
    if body.source_type not in VALID_SOURCE_TYPES:
        raise HTTPException(400, detail=f"Invalid source_type. Must be one of: {sorted(VALID_SOURCE_TYPES)}")
    source = await db.create_source(
        url=body.url,
        source_type=body.source_type,
        dialect=body.dialect,
        max_videos=body.max_videos,
        notes=body.notes,
    )
    return source


@router.put("/{source_id}")
async def update_source(source_id: int, body: SourceUpdate):
    fields = body.model_dump(exclude_none=True)
    if "dialect" in fields and fields["dialect"] not in DIALECTS:
        raise HTTPException(400, detail=f"Invalid dialect. Must be one of: {DIALECTS}")
    if "source_type" in fields and fields["source_type"] not in VALID_SOURCE_TYPES:
        raise HTTPException(400, detail=f"Invalid source_type. Must be one of: {sorted(VALID_SOURCE_TYPES)}")
    await db.update_source(source_id, **fields)
    return {"id": source_id, **fields}


@router.delete("/{source_id}", status_code=204)
async def delete_source(source_id: int):
    await db.delete_source(source_id)
