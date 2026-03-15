import uuid
from typing import Optional, List

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from server import db
from server.config import DEFAULT_WHISPER_MODEL, DEFAULT_MIN_CONFIDENCE
from server.workers.transcribe_worker import run_transcribe_job, request_cancel

router = APIRouter(prefix="/api/transcribe", tags=["transcribe"])

_retry_locks: set[str] = set()


class TranscribeStart(BaseModel):
    dialect: Optional[str] = None
    model: str = DEFAULT_WHISPER_MODEL
    min_confidence: float = DEFAULT_MIN_CONFIDENCE


class CorrectText(BaseModel):
    text: str


class BulkApprove(BaseModel):
    clip_ids: List[str]


class RetryClip(BaseModel):
    clip_id: str
    model: str = DEFAULT_WHISPER_MODEL
    min_confidence: float = DEFAULT_MIN_CONFIDENCE


@router.post("/start")
async def start_transcribe(body: TranscribeStart, background_tasks: BackgroundTasks):
    job_id = f"transcribe-{uuid.uuid4().hex[:12]}"
    config = {
        "dialect": body.dialect,
        "model": body.model,
        "min_confidence": body.min_confidence,
    }
    await db.create_job(job_id, job_type="transcribe", config=config)
    background_tasks.add_task(run_transcribe_job, job_id, body.dialect, config)
    return {"job_id": job_id}


@router.get("/status/{job_id}")
async def get_transcribe_status(job_id: str):
    job = await db.get_job(job_id)
    if job is None:
        raise HTTPException(404, detail="Job not found")
    return job


@router.get("/jobs")
async def list_transcribe_jobs():
    jobs = await db.get_jobs(limit=30, job_type="transcribe")
    return {"jobs": jobs}


@router.post("/cancel/{job_id}")
async def cancel_transcribe(job_id: str):
    job = await db.get_job(job_id)
    if job is None:
        raise HTTPException(404, detail="Job not found")
    request_cancel(job_id)
    await db.update_job(job_id, status="cancelling")
    return {"job_id": job_id, "status": "cancelling"}


@router.get("/review")
async def review_transcriptions(
    dialect: Optional[str] = None,
    status: Optional[str] = None,
    min_confidence: Optional[float] = None,
    max_confidence: Optional[float] = None,
    limit: int = 50,
    offset: int = 0,
):
    result = await db.get_transcriptions(
        dialect=dialect,
        status=status,
        min_confidence=min_confidence,
        max_confidence=max_confidence,
        limit=limit,
        offset=offset,
    )
    return result


@router.put("/correct/{clip_id}")
async def correct_transcription(clip_id: str, body: CorrectText):
    exists = await db.transcription_exists(clip_id)
    if not exists:
        raise HTTPException(404, detail="Transcription not found")
    await db.update_transcription(clip_id, body.text, is_corrected=True, corrected_by="human")
    await db.update_clip_status(clip_id, "corrected")
    return {"clip_id": clip_id, "status": "corrected"}


@router.post("/reject/{clip_id}")
async def reject_clip(clip_id: str):
    await db.update_clip_status(clip_id, "rejected")
    return {"clip_id": clip_id, "status": "rejected"}


@router.post("/bulk-approve")
async def bulk_approve(body: BulkApprove):
    for clip_id in body.clip_ids:
        await db.update_clip_status(clip_id, "approved")
    return {"approved": len(body.clip_ids)}


@router.post("/retry-clip")
async def retry_clip(body: RetryClip, background_tasks: BackgroundTasks):
    if body.clip_id in _retry_locks:
        raise HTTPException(409, detail="retry already in progress")

    _retry_locks.add(body.clip_id)
    try:
        clip = await db.get_clip(body.clip_id)
        if clip is None:
            raise HTTPException(404, detail="Clip not found")
        job_id = f"retry-{uuid.uuid4().hex[:12]}"
        config = {
            "model": body.model,
            "min_confidence": body.min_confidence,
            "clip_ids": [body.clip_id],
            "is_retry": True,
        }
        await db.create_job(job_id, job_type="transcribe", config=config)
        background_tasks.add_task(run_transcribe_job, job_id, None, config)
        return {"job_id": job_id}
    except Exception:
        _retry_locks.discard(body.clip_id)
        raise


@router.get("/stats")
async def get_transcription_stats():
    stats = await db.get_transcription_stats()
    return {"stats": stats}
