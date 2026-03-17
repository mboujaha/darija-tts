import asyncio
import logging
from datetime import datetime
from pathlib import Path

from server import db
from server.config import DATA_DIR
from server.services.dataset_builder import build_dataset
from server.ws import ws_manager

logger = logging.getLogger(__name__)

_cancel_flags: dict[str, bool] = {}


def request_cancel(job_id: str):
    _cancel_flags[job_id] = True


def is_cancelled(job_id: str) -> bool:
    return _cancel_flags.get(job_id, False)


async def run_dataset_job(job_id: str, dialect: str | None, config: dict):
    _cancel_flags[job_id] = False
    await db.update_job(job_id, status="running", started_at=datetime.utcnow().isoformat())
    await _broadcast_job_update(job_id, "running", 0.0, "Starting…")

    min_duration = config.get("min_duration", 3.0)
    max_duration = config.get("max_duration", 11.0)
    min_speaker_clips = config.get("min_speaker_clips", 20)
    statuses = config.get("statuses", ["approved", "corrected"])
    min_confidence = config.get("min_confidence", 0.0)
    output_dir = str(Path(DATA_DIR) / "dataset")

    try:
        clips = await db.get_clips_for_dataset(
            dialect, min_duration, max_duration,
            statuses=statuses, min_confidence=min_confidence
        )
        if not clips:
            await db.update_job(job_id, status="completed", progress=1.0,
                                message="No eligible clips found",
                                completed_at=datetime.utcnow().isoformat())
            await _broadcast_job_update(job_id, "completed", 1.0, "No eligible clips found")
            return

        total = len(clips)
        loop = asyncio.get_event_loop()

        def progress_cb(done, total_clips, line):
            if is_cancelled(job_id):
                raise asyncio.CancelledError()
            # Broadcast log line
            asyncio.run_coroutine_threadsafe(
                _broadcast_log(job_id, line), loop
            ).result(timeout=30)
            # Broadcast progress update
            if total_clips > 0:
                progress = round(done / total_clips, 4)
                msg = f"{done}/{total_clips} clips copied"
                asyncio.run_coroutine_threadsafe(
                    _broadcast_job_update(job_id, "running", progress, msg), loop
                ).result(timeout=30)
                # Update DB less frequently (every 10%)
                if done % max(1, total_clips // 10) == 0:
                    asyncio.run_coroutine_threadsafe(
                        db.update_job(job_id, status="running", progress=progress, message=msg),
                        loop,
                    ).result(timeout=30)

        stats = await loop.run_in_executor(
            None,
            lambda: build_dataset(
                clips=clips,
                output_dir=output_dir,
                min_duration=min_duration,
                max_duration=max_duration,
                min_speaker_clips=min_speaker_clips,
                progress_cb=progress_cb,
            ),
        )

        if is_cancelled(job_id):
            await db.update_job(job_id, status="cancelled",
                                message="Cancelled",
                                completed_at=datetime.utcnow().isoformat())
            await _broadcast_job_update(job_id, "cancelled", 0.0, "Cancelled")
            return

        final_msg = (
            f"Done: {stats['total_clips']} clips, "
            f"{stats['total_speakers']} speakers, "
            f"{stats['train_count']} train / {stats['eval_count']} eval"
        )
        await db.update_job(job_id, status="completed", progress=1.0,
                            message=final_msg,
                            completed_at=datetime.utcnow().isoformat())
        await _broadcast_job_update(job_id, "completed", 1.0, final_msg)

    except asyncio.CancelledError:
        await db.update_job(job_id, status="cancelled",
                            message="Cancelled",
                            completed_at=datetime.utcnow().isoformat())
        await _broadcast_job_update(job_id, "cancelled", 0.0, "Cancelled")
    except Exception as e:
        logger.exception("Dataset job failed")
        await db.update_job(job_id, status="failed", error=str(e),
                            completed_at=datetime.utcnow().isoformat())
        await _broadcast_job_update(job_id, "failed", 0.0, f"Unexpected error: {e}")
    finally:
        _cancel_flags.pop(job_id, None)


async def _broadcast_job_update(job_id: str, status: str, progress: float, message: str):
    await ws_manager.broadcast({
        "type": "job_update",
        "job_id": job_id,
        "status": status,
        "progress": progress,
        "message": message,
    })


async def _broadcast_log(job_id: str, line: str):
    await ws_manager.broadcast({
        "type": "dataset_log",
        "job_id": job_id,
        "line": line,
    })
