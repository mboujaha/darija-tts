import uuid
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from server import db
from server.config import DEFAULT_MIN_DURATION, DEFAULT_MAX_DURATION, DEFAULT_MIN_SNR
from server.workers.process_worker import run_process_job, request_cancel

router = APIRouter(prefix="/api/process", tags=["process"])


class ProcessStart(BaseModel):
    dialect: Optional[str] = None
    min_duration: float = DEFAULT_MIN_DURATION
    max_duration: float = DEFAULT_MAX_DURATION
    min_snr: float = DEFAULT_MIN_SNR
    denoise: bool = True
    diarize: bool = False


@router.post("/start")
async def start_process(body: ProcessStart, background_tasks: BackgroundTasks):
    job_id = f"process-{uuid.uuid4().hex[:12]}"
    config = {
        "dialect": body.dialect,
        "min_duration": body.min_duration,
        "max_duration": body.max_duration,
        "min_snr": body.min_snr,
        "denoise": body.denoise,
        "diarize": body.diarize,
    }
    await db.create_job(job_id, job_type="process", config=config)
    background_tasks.add_task(run_process_job, job_id, body.dialect, config)
    return {"job_id": job_id}


@router.get("/status/{job_id}")
async def get_process_status(job_id: str):
    job = await db.get_job(job_id)
    if job is None:
        raise HTTPException(404, detail="Job not found")
    return job


@router.get("/jobs")
async def list_process_jobs():
    jobs = await db.get_jobs(limit=30, job_type="process")
    return {"jobs": jobs}


@router.post("/cancel/{job_id}")
async def cancel_process(job_id: str):
    job = await db.get_job(job_id)
    if job is None:
        raise HTTPException(404, detail="Job not found")
    request_cancel(job_id)
    await db.update_job(job_id, status="cancelling")
    return {"job_id": job_id, "status": "cancelling"}


@router.get("/stats")
async def get_process_stats():
    stats = await db.get_process_stats()
    return {"stats": stats}
