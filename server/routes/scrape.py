import asyncio
import uuid
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from server import db
from server.workers.scrape_worker import run_scrape_job, request_cancel

router = APIRouter(prefix="/api/scrape", tags=["scrape"])


class ScrapeStart(BaseModel):
    dialect: Optional[str] = None
    source_ids: Optional[list[int]] = None


@router.post("/start")
async def start_scrape(body: ScrapeStart, background_tasks: BackgroundTasks):
    job_id = f"scrape-{uuid.uuid4().hex[:12]}"
    config = {"dialect": body.dialect, "source_ids": body.source_ids}
    await db.create_job(job_id, job_type="scrape", config=config)
    background_tasks.add_task(run_scrape_job, job_id, body.dialect, body.source_ids)
    return {"job_id": job_id}


@router.get("/status/{job_id}")
async def get_scrape_status(job_id: str):
    job = await db.get_job(job_id)
    if job is None:
        raise HTTPException(404, detail="Job not found")
    return job


@router.get("/jobs")
async def list_scrape_jobs():
    jobs = await db.get_jobs(limit=30, job_type="scrape")
    return {"jobs": jobs}


@router.post("/cancel/{job_id}")
async def cancel_scrape(job_id: str):
    job = await db.get_job(job_id)
    if job is None:
        raise HTTPException(404, detail="Job not found")
    request_cancel(job_id)
    await db.update_job(job_id, status="cancelling")
    return {"job_id": job_id, "status": "cancelling"}


@router.get("/stats")
async def get_scrape_stats():
    stats = await db.get_download_stats()
    return {"stats": stats}
