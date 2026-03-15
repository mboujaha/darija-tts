import asyncio
import logging
from datetime import datetime

from server import db
from server.services.transcriber import transcribe_clip
from server.ws import ws_manager

logger = logging.getLogger(__name__)

_cancel_flags: dict[str, bool] = {}


def request_cancel(job_id: str):
    _cancel_flags[job_id] = True


def is_cancelled(job_id: str) -> bool:
    return _cancel_flags.get(job_id, False)


async def run_transcribe_job(job_id: str, dialect: str | None, config: dict):
    _cancel_flags[job_id] = False
    await db.update_job(job_id, status="running", started_at=datetime.utcnow().isoformat())
    await _broadcast_job_update(job_id, "running", 0.0, "Starting…")

    model_size = config.get("model", "large-v3")
    min_confidence = config.get("min_confidence", 0.6)
    clip_ids: list[str] | None = config.get("clip_ids")
    is_retry: bool = config.get("is_retry", False)

    try:
        if is_retry and clip_ids:
            clips = await db.get_clips_by_ids(clip_ids)
        else:
            clips = await db.get_clips_for_transcription(dialect)

        if not clips:
            msg = "No clips found" if is_retry else "No processed clips found"
            await db.update_job(job_id, status="completed", progress=1.0, message=msg,
                                completed_at=datetime.utcnow().isoformat())
            await _broadcast_job_update(job_id, "completed", 1.0, msg)
            if is_retry and clip_ids:
                await _broadcast_clip_done(job_id, clip_ids[0], failed=True)
            return

        total = len(clips)
        total_ok = 0
        total_rejected = 0

        loop = asyncio.get_event_loop()

        for i, clip in enumerate(clips):
            if is_cancelled(job_id):
                await db.update_job(job_id, status="cancelled",
                                    progress=round(i / total, 4),
                                    message=f"Cancelled at {i}/{total}",
                                    completed_at=datetime.utcnow().isoformat())
                await _broadcast_job_update(job_id, "cancelled", round(i / total, 4), f"Cancelled at {i}/{total}")
                return

            clip_id = clip["id"]
            file_path = clip["file_path"]

            if not is_retry and await db.transcription_exists(clip_id):
                progress = round((i + 1) / total, 4)
                msg = f"{i+1}/{total} — {total_ok} transcribed"
                await db.update_job(job_id, status="running", progress=progress, message=msg)
                await _broadcast_job_update(job_id, "running", progress, msg)
                continue

            try:
                result = await loop.run_in_executor(
                    None,
                    lambda p=file_path: transcribe_clip(p, model_size, min_confidence),
                )
            except Exception as e:
                await _broadcast_log(job_id, f"ERROR {clip_id}: {e}")
                if is_retry:
                    await _broadcast_clip_done(job_id, clip_id, failed=True)
                progress = round((i + 1) / total, 4)
                await db.update_job(job_id, status="running", progress=progress)
                await _broadcast_job_update(job_id, "running", progress, f"{i+1}/{total} — {total_ok} transcribed")
                continue

            if result is None:
                total_rejected += 1
                await _broadcast_log(job_id, f"REJECT {clip_id}: low confidence or invalid text")
                if is_retry:
                    await _broadcast_clip_done(job_id, clip_id, failed=True)
            else:
                text = result["text"]
                confidence = result["confidence"]
                if is_retry:
                    await db.upsert_transcription(clip_id, text, confidence)
                else:
                    await db.create_transcription(clip_id, text, confidence)
                await db.update_clip_status(clip_id, "transcribed")
                total_ok += 1
                await _broadcast_log(job_id, f"OK {clip_id}: {confidence:.2f} — {text[:60]}")
                if is_retry:
                    await _broadcast_clip_done(job_id, clip_id, text=text,
                                               confidence=confidence, status="transcribed")

            progress = round((i + 1) / total, 4)
            msg = f"{i+1}/{total} — {total_ok} transcribed"
            await db.update_job(job_id, status="running", progress=progress, message=msg)
            await _broadcast_job_update(job_id, "running", progress, msg)

        final_msg = f"Done: {total_ok} transcribed, {total_rejected} rejected"
        await db.update_job(job_id, status="completed", progress=1.0, message=final_msg,
                            completed_at=datetime.utcnow().isoformat())
        await _broadcast_job_update(job_id, "completed", 1.0, final_msg)

    except Exception as e:
        await db.update_job(job_id, status="failed", error=str(e),
                            completed_at=datetime.utcnow().isoformat())
        await _broadcast_job_update(job_id, "failed", 0.0, f"Unexpected error: {e}")
    finally:
        _cancel_flags.pop(job_id, None)
        if is_retry and clip_ids:
            retry_clip_id = clip_ids[0]
            from server.routes.transcribe import _retry_locks
            _retry_locks.discard(retry_clip_id)


async def _broadcast_job_update(job_id: str, status: str, progress: float, message: str):
    await ws_manager.broadcast({
        "type": "job_update",
        "job_id": job_id,
        "status": status,
        "progress": progress,
        "message": message,
    })


async def _broadcast_clip_done(job_id: str, clip_id: str, *,
                               failed: bool = False, text: str = "",
                               confidence: float = 0.0, status: str = ""):
    payload: dict = {"type": "transcribe_clip_done", "job_id": job_id, "clip_id": clip_id}
    if failed:
        payload["failed"] = True
    else:
        payload.update({"text": text, "confidence": confidence, "status": status})
    await ws_manager.broadcast(payload)


async def _broadcast_log(job_id: str, line: str):
    await ws_manager.broadcast({
        "type": "transcribe_log",
        "job_id": job_id,
        "line": line,
    })
