import asyncio
import shutil
from pathlib import Path
from fastapi import APIRouter
from server.config import DATA_DIR, CHECKPOINTS_DIR
from server import db

router = APIRouter(prefix="/api/monitor", tags=["monitor"])


async def _run_cmd(cmd: str) -> str:
    proc = await asyncio.create_subprocess_shell(
        cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
    )
    stdout, _ = await proc.communicate()
    return stdout.decode().strip()


@router.get("/gpu")
async def get_gpu_stats():
    try:
        out = await _run_cmd(
            "nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,name "
            "--format=csv,noheader,nounits"
        )
        if not out:
            return {"available": False}
        parts = [p.strip() for p in out.split(",")]
        return {
            "available": True,
            "utilization": float(parts[0]),
            "memory_used_mb": float(parts[1]),
            "memory_total_mb": float(parts[2]),
            "temperature": float(parts[3]),
            "name": parts[4] if len(parts) > 4 else "Unknown",
        }
    except Exception:
        return {"available": False}


@router.get("/disk")
async def get_disk_stats():
    result = {}
    base = Path(DATA_DIR)
    for subdir in ["raw", "processed", "transcribed", "corrections", "dataset", "reference_speakers"]:
        path = base / subdir
        if path.exists():
            total = sum(f.stat().st_size for f in path.rglob("*") if f.is_file())
            result[subdir] = {"bytes": total, "gb": round(total / 1e9, 2)}
        else:
            result[subdir] = {"bytes": 0, "gb": 0}
    ckpt = Path(CHECKPOINTS_DIR)
    ckpt_size = sum(f.stat().st_size for f in ckpt.rglob("*") if f.is_file()) if ckpt.exists() else 0
    result["checkpoints"] = {"bytes": ckpt_size, "gb": round(ckpt_size / 1e9, 2)}
    disk = shutil.disk_usage(str(base))
    result["_total_free_gb"] = round(disk.free / 1e9, 2)
    result["_total_used_gb"] = round(disk.used / 1e9, 2)
    return result


@router.get("/jobs")
async def get_active_jobs():
    jobs = await db.get_jobs(limit=20)
    return {"jobs": jobs}


@router.get("/pipeline")
async def get_pipeline_stats():
    import json
    from server.config import DATA_DIR, CHECKPOINTS_DIR

    data = Path(DATA_DIR)

    # DB counts
    async with __import__('aiosqlite').connect(__import__('server.config', fromlist=['DB_PATH']).DB_PATH) as conn:
        async def count(sql, params=()):
            async with conn.execute(sql, params) as cur:
                row = await cur.fetchone()
                return row[0] if row else 0

        n_sources     = await count("SELECT COUNT(*) FROM sources")
        n_videos      = await count("SELECT COUNT(*) FROM downloaded_videos WHERE status='ok'")
        n_clips       = await count("SELECT COUNT(*) FROM clips")
        n_transcribed = await count("SELECT COUNT(*) FROM clips WHERE status IN ('transcribed','corrected')")
        n_runs        = await count("SELECT COUNT(*) FROM training_runs WHERE status='completed'")

    # Filesystem counts
    def file_count(path):
        p = Path(path)
        return sum(1 for f in p.rglob("*") if f.is_file()) if p.exists() else 0

    def csv_data_lines(path):
        p = Path(path)
        if not p.exists():
            return 0
        with open(p, encoding="utf-8") as f:
            lines = [l for l in f if l.strip() and not l.startswith("audio_file")]
        return len(lines)

    dataset_dir = data / "dataset"
    n_train = csv_data_lines(dataset_dir / "metadata_train.csv")
    n_eval  = csv_data_lines(dataset_dir / "metadata_eval.csv")
    n_generated = file_count(data / "generated")
    n_evals     = sum(1 for f in (data / "evaluations").glob("*.json") if f.is_file()) if (data / "evaluations").exists() else 0

    return {
        "sources":     n_sources,
        "videos":      n_videos,
        "clips":       n_clips,
        "transcribed": n_transcribed,
        "dataset_train": n_train,
        "dataset_eval":  n_eval,
        "trained_runs":  n_runs,
        "generated":     n_generated,
        "eval_jobs":     n_evals,
    }
