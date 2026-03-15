import uuid
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from server import db
from server.config import DEFAULT_MIN_DURATION, DEFAULT_MAX_DURATION, DEFAULT_MIN_SPEAKER_CLIPS
from server.workers.dataset_worker import run_dataset_job, request_cancel

router = APIRouter(prefix="/api/dataset", tags=["dataset"])


class DatasetBuild(BaseModel):
    dialect: Optional[str] = None
    min_duration: float = DEFAULT_MIN_DURATION
    max_duration: float = DEFAULT_MAX_DURATION
    min_speaker_clips: int = DEFAULT_MIN_SPEAKER_CLIPS


@router.post("/build")
async def build_dataset(body: DatasetBuild, background_tasks: BackgroundTasks):
    job_id = f"build_dataset-{uuid.uuid4().hex[:12]}"
    config = {
        "dialect": body.dialect,
        "min_duration": body.min_duration,
        "max_duration": body.max_duration,
        "min_speaker_clips": body.min_speaker_clips,
    }
    await db.create_job(job_id, job_type="build_dataset", config=config)
    background_tasks.add_task(run_dataset_job, job_id, body.dialect, config)
    return {"job_id": job_id}


@router.get("/status/{job_id}")
async def get_dataset_status(job_id: str):
    job = await db.get_job(job_id)
    if job is None:
        raise HTTPException(404, detail="Job not found")
    return job


@router.get("/jobs")
async def list_dataset_jobs():
    jobs = await db.get_jobs(limit=30, job_type="build_dataset")
    return {"jobs": jobs}


@router.post("/cancel/{job_id}")
async def cancel_dataset_job(job_id: str):
    job = await db.get_job(job_id)
    if job is None:
        raise HTTPException(404, detail="Job not found")
    request_cancel(job_id)
    await db.update_job(job_id, status="cancelling")
    return {"job_id": job_id, "status": "cancelling"}


@router.get("/stats")
async def get_dataset_stats():
    stats = await db.get_dataset_stats()
    return {"stats": stats}


@router.get("/preview")
async def get_dataset_preview(limit: int = 10):
    items = await db.get_dataset_preview(limit=limit)
    return {"items": items}
