import uuid
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from server import db
from server.config import (
    DEFAULT_TRAINING_TYPE,
    DEFAULT_BATCH_SIZE,
    DEFAULT_GRAD_ACCUMULATION,
    DEFAULT_LEARNING_RATE,
    DEFAULT_EPOCHS,
    CHECKPOINTS_DIR,
)
from server.services.trainer import get_checkpoints
from server.workers.train_worker import run_train_job, request_cancel

router = APIRouter(prefix="/api/train", tags=["train"])


class TrainStart(BaseModel):
    training_type: str = DEFAULT_TRAINING_TYPE       # "full" | "freeze_encoder"
    epochs: int = DEFAULT_EPOCHS
    batch_size: int = DEFAULT_BATCH_SIZE
    grad_accumulation: int = DEFAULT_GRAD_ACCUMULATION
    learning_rate: float = DEFAULT_LEARNING_RATE
    base_checkpoint: Optional[str] = None           # path to a local checkpoint dir


@router.post("/start")
async def start_training(body: TrainStart, background_tasks: BackgroundTasks):
    job_id = f"train-{uuid.uuid4().hex[:12]}"
    run_id = f"run-{uuid.uuid4().hex[:10]}"

    config = {
        "training_type": body.training_type,
        "epochs": body.epochs,
        "batch_size": body.batch_size,
        "grad_accumulation": body.grad_accumulation,
        "learning_rate": body.learning_rate,
        "base_checkpoint": body.base_checkpoint,
    }

    await db.create_job(job_id, job_type="train", config=config)
    await db.create_training_run(
        run_id=run_id,
        job_id=job_id,
        config=config,
        total_epochs=body.epochs,
        training_type=body.training_type,
    )

    background_tasks.add_task(run_train_job, job_id, run_id, config)
    return {"job_id": job_id, "run_id": run_id}


@router.get("/status/{job_id}")
async def get_train_status(job_id: str):
    job = await db.get_job(job_id)
    if job is None:
        raise HTTPException(404, detail="Job not found")
    return job


@router.get("/jobs")
async def list_train_jobs():
    jobs = await db.get_jobs(limit=30, job_type="train")
    return {"jobs": jobs}


@router.post("/cancel/{job_id}")
async def cancel_training(job_id: str):
    job = await db.get_job(job_id)
    if job is None:
        raise HTTPException(404, detail="Job not found")
    request_cancel(job_id)
    await db.update_job(job_id, status="cancelling")
    return {"job_id": job_id, "status": "cancelling"}


@router.get("/runs")
async def list_runs():
    runs = await db.get_training_runs(limit=20)
    return {"runs": runs}


@router.get("/runs/{run_id}")
async def get_run(run_id: str):
    run = await db.get_training_run(run_id)
    if run is None:
        raise HTTPException(404, detail="Training run not found")
    return run


@router.get("/runs/{run_id}/loss")
async def get_run_loss(run_id: str):
    history = await db.get_loss_history(run_id)
    return {"history": history}


@router.get("/checkpoints")
async def list_checkpoints():
    checkpoints = get_checkpoints(CHECKPOINTS_DIR)
    return {"checkpoints": checkpoints}
