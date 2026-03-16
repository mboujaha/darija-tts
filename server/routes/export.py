import asyncio
import os
import time
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse

from server.config import DATA_DIR, CHECKPOINTS_DIR
from server.services.exporter import (
    build_dataset_zip,
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
    loop = asyncio.get_running_loop()
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

    loop = asyncio.get_running_loop()
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
async def export_checkpoint(run_id: str):
    """Stream a trained checkpoint as a .tar.gz (best_model + config + vocab)."""
    if "/" in run_id or "\\" in run_id or ".." in run_id:
        raise HTTPException(400, detail="Invalid run_id")

    run_dir = Path(CHECKPOINTS_DIR) / run_id
    if not run_dir.exists():
        raise HTTPException(404, detail=f"Checkpoint '{run_id}' not found")

    # Only pack best_model.pth + config.json + vocab.json — not all periodic
    # checkpoints which can add several extra GB to the download.
    checkpoints = get_checkpoints(CHECKPOINTS_DIR)
    ckpt_info = next((c for c in checkpoints if c["run_id"] == run_id), None)
    best_model_path = ckpt_info["best_model"] if ckpt_info else None

    if best_model_path:
        best = Path(best_model_path)
        rel_paths = [str(best.relative_to(CHECKPOINTS_DIR))]
        for fname in ("config.json", "vocab.json"):
            p = best.parent / fname
            if p.exists():
                rel_paths.append(str(p.relative_to(CHECKPOINTS_DIR)))
    else:
        rel_paths = [run_id]

    filename = f"{run_id}.tar.gz"

    async def stream_tar():
        # create_subprocess_exec (not shell=True) — no injection risk.
        # run_id is validated above; rel_paths come from resolved Path objects.
        proc = await asyncio.create_subprocess_exec(
            "tar", "-czf", "-", "-C", CHECKPOINTS_DIR, *rel_paths,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            while True:
                chunk = await proc.stdout.read(65536)
                if not chunk:
                    break
                yield chunk
        finally:
            await proc.wait()

    return StreamingResponse(
        stream_tar(),
        media_type="application/gzip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
