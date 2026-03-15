import asyncio
import os
import tempfile
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from fastapi.responses import FileResponse

from server.config import DATA_DIR, CHECKPOINTS_DIR
from server.services.exporter import (
    build_dataset_zip,
    build_checkpoint_tar,
    dataset_stats,
    FORMATS,
)
from server.services.trainer import get_checkpoints

router = APIRouter(prefix="/api/export", tags=["export"])

DATASET_DIR = str(Path(DATA_DIR) / "dataset")
EXPORT_TMP  = str(Path(DATA_DIR) / "exports")

Path(EXPORT_TMP).mkdir(parents=True, exist_ok=True)


def _cleanup(path: str):
    try:
        os.unlink(path)
    except Exception:
        pass


@router.get("/stats")
async def get_export_stats():
    """Return dataset readiness info before committing to a ZIP build."""
    loop = asyncio.get_event_loop()
    stats = await loop.run_in_executor(None, lambda: dataset_stats(DATASET_DIR))
    checkpoints = get_checkpoints(CHECKPOINTS_DIR)
    return {"dataset": stats, "checkpoints": checkpoints}


@router.get("/dataset")
async def export_dataset(
    background_tasks: BackgroundTasks,
    fmt: str = Query("coqui", description=f"One of: {', '.join(FORMATS)}"),
):
    """Build and download a ZIP of the dataset in the requested format."""
    if fmt not in FORMATS:
        raise HTTPException(400, detail=f"Unknown format. Choose from: {list(FORMATS)}")

    stats = dataset_stats(DATASET_DIR)
    if not stats["ready"]:
        raise HTTPException(400, detail="Dataset not ready — run Dataset Builder first.")

    filename = f"darija_dataset_{fmt}_{int(time.time())}.zip"
    output_path = str(Path(EXPORT_TMP) / filename)

    loop = asyncio.get_event_loop()
    try:
        info = await loop.run_in_executor(
            None,
            lambda: build_dataset_zip(DATASET_DIR, output_path, fmt=fmt),
        )
    except Exception as e:
        raise HTTPException(500, detail=f"Export failed: {e}")

    background_tasks.add_task(_cleanup, output_path)

    return FileResponse(
        path=output_path,
        filename=filename,
        media_type="application/zip",
        background=background_tasks,
    )


@router.get("/checkpoint/{run_id}")
async def export_checkpoint(run_id: str, background_tasks: BackgroundTasks):
    """Download a trained checkpoint directory as a .tar.gz."""
    # Validate run_id is safe
    if "/" in run_id or "\\" in run_id or ".." in run_id:
        raise HTTPException(400, detail="Invalid run_id")

    run_dir = str(Path(CHECKPOINTS_DIR) / run_id)
    if not Path(run_dir).exists():
        raise HTTPException(404, detail=f"Checkpoint '{run_id}' not found")

    filename = f"{run_id}_{int(time.time())}.tar.gz"
    output_path = str(Path(EXPORT_TMP) / filename)

    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(
            None,
            lambda: build_checkpoint_tar(run_dir, output_path),
        )
    except Exception as e:
        raise HTTPException(500, detail=f"Export failed: {e}")

    background_tasks.add_task(_cleanup, output_path)

    return FileResponse(
        path=output_path,
        filename=filename,
        media_type="application/gzip",
        background=background_tasks,
    )
