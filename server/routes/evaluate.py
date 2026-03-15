import uuid
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from server import db
from server.config import DATA_DIR
from server.services.evaluator import load_results
from server.workers.evaluate_worker import run_eval_job, request_cancel

router = APIRouter(prefix="/api/evaluate", tags=["evaluate"])

EVAL_DIR = Path(DATA_DIR) / "evaluations"


class EvalStart(BaseModel):
    sentences: List[str]
    speaker_ids: List[str] = []        # empty = all available voices
    checkpoint_dir: Optional[str] = None
    language: str = "ar"
    temperature: float = 0.65


@router.post("/run")
async def start_eval(body: EvalStart, background_tasks: BackgroundTasks):
    sentences = [s.strip() for s in body.sentences if s.strip()]
    if not sentences:
        raise HTTPException(400, detail="Provide at least one sentence")

    job_id = f"eval-{uuid.uuid4().hex[:12]}"
    config = {
        "sentences": sentences,
        "speaker_ids": body.speaker_ids,
        "checkpoint_dir": body.checkpoint_dir,
        "language": body.language,
        "temperature": body.temperature,
    }
    await db.create_job(job_id, job_type="evaluate", config=config)
    background_tasks.add_task(run_eval_job, job_id, config)
    return {"job_id": job_id}


@router.get("/status/{job_id}")
async def get_eval_status(job_id: str):
    job = await db.get_job(job_id)
    if job is None:
        raise HTTPException(404, detail="Job not found")
    return job


@router.get("/jobs")
async def list_eval_jobs():
    jobs = await db.get_jobs(limit=30, job_type="evaluate")
    return {"jobs": jobs}


@router.post("/cancel/{job_id}")
async def cancel_eval(job_id: str):
    job = await db.get_job(job_id)
    if job is None:
        raise HTTPException(404, detail="Job not found")
    request_cancel(job_id)
    await db.update_job(job_id, status="cancelling")
    return {"job_id": job_id, "status": "cancelling"}


@router.get("/results/{job_id}")
async def get_results(job_id: str):
    results_path = EVAL_DIR / f"{job_id}.json"
    if not results_path.exists():
        raise HTTPException(404, detail="Results not found — job may still be running")
    results = load_results(str(results_path))

    # Compute per-speaker and per-sentence summary
    by_speaker: dict = {}
    for r in results:
        sid = r["speaker_id"]
        if sid not in by_speaker:
            by_speaker[sid] = {"speaker_name": r["speaker_name"], "samples": []}
        by_speaker[sid]["samples"].append(r)

    summaries = []
    for sid, data in by_speaker.items():
        ok = [s for s in data["samples"] if not s.get("error")]
        def avg(key):
            vals = [s[key] for s in ok if s.get(key) is not None]
            return round(sum(vals) / len(vals), 4) if vals else None
        summaries.append({
            "speaker_id": sid,
            "speaker_name": data["speaker_name"],
            "n_samples": len(data["samples"]),
            "n_ok": len(ok),
            "avg_mcd": avg("mcd"),
            "avg_speaker_sim": avg("speaker_sim"),
            "avg_snr": avg("snr"),
            "avg_rtf": avg("rtf"),
            "avg_duration": avg("duration"),
        })

    return {"results": results, "by_speaker": summaries}
