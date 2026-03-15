import asyncio
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, File, HTTPException, UploadFile
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


@router.get("/cookies-status")
async def get_cookies_status():
    from server.services.scraper import COOKIES_FILE
    present = Path(COOKIES_FILE).exists()
    valid = False
    if present:
        proc = await asyncio.create_subprocess_exec(
            "yt-dlp", "--simulate", "--quiet",
            "--cookies", COOKIES_FILE,
            "https://www.youtube.com/watch?v=jNQXAC9IVRw",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, _ = await proc.communicate()
        valid = proc.returncode == 0
    return {"present": present, "valid": valid}


@router.post("/upload-cookies")
async def upload_cookies(file: UploadFile = File(...)):
    from server.services.scraper import COOKIES_FILE
    content = await file.read()
    Path(COOKIES_FILE).write_bytes(content)
    return {"ok": True, "bytes": len(content)}


@router.get("/videos")
async def list_downloaded_videos(
    dialect: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 200,
):
    videos = await db.get_all_downloaded_videos(dialect=dialect, status=status, limit=limit)
    return {"videos": videos}


@router.post("/clear-failed")
async def clear_failed_videos(dialect: Optional[str] = None):
    deleted = await db.delete_failed_videos(dialect=dialect)
    return {"deleted": deleted}
