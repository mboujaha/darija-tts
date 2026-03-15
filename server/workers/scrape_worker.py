import asyncio
from datetime import datetime
from pathlib import Path

from server import db
from server.config import DATA_DIR, DIALECTS
from server.services.scraper import (
    list_videos, download_video, extract_video_id,
    DownloadError, AgeRestrictedError, GeoBlockedError, VideoUnavailableError,
)
from server.ws import ws_manager

_cancel_flags: dict[str, bool] = {}


def request_cancel(job_id: str):
    _cancel_flags[job_id] = True


def is_cancelled(job_id: str) -> bool:
    return _cancel_flags.get(job_id, False)


async def run_scrape_job(job_id: str, dialect: str | None, source_ids: list[int] | None):
    _cancel_flags[job_id] = False
    await db.update_job(job_id, status="running", started_at=datetime.utcnow().isoformat())
    await _broadcast_job_update(job_id, "running", 0.0, "Starting…")

    try:
        # 1. Resolve sources
        if source_ids:
            all_sources = await db.get_sources()
            sources = [s for s in all_sources if s["id"] in source_ids]
        elif dialect:
            sources = await db.get_sources(dialect=dialect)
        else:
            sources = await db.get_sources()

        if not sources:
            await db.update_job(job_id, status="completed", progress=1.0, message="No sources found", completed_at=datetime.utcnow().isoformat())
            await _broadcast_job_update(job_id, "completed", 1.0, "No sources found")
            return

        # 2. Build video queue: list[{url, source_id, dialect}]
        video_queue = []
        for source in sources:
            try:
                if source.get("source_type") == "video":
                    # Single video — no playlist listing needed
                    vid = extract_video_id(source["url"]) or source["url"].split("/")[-1]
                    video_queue.append({"url": source["url"], "video_id": vid, "source_id": source["id"], "dialect": source["dialect"]})
                    await _broadcast_log(job_id, f"Queued single video: {vid}")
                else:
                    await _broadcast_log(job_id, f"Listing {source['url']} …")
                    urls = await list_videos(source["url"], source.get("max_videos", 50))
                    for u in urls:
                        vid = extract_video_id(u) or u.split("/")[-1]
                        video_queue.append({"url": u, "video_id": vid, "source_id": source["id"], "dialect": source["dialect"]})
                    await _broadcast_log(job_id, f"Found {len(urls)} videos from {source['url']}")
            except DownloadError as e:
                await _broadcast_log(job_id, f"ERROR listing {source['url']}: {e}")

        total = len(video_queue)
        if total == 0:
            await db.update_job(job_id, status="completed", progress=1.0, message="No videos to download", completed_at=datetime.utcnow().isoformat())
            await _broadcast_job_update(job_id, "completed", 1.0, "No videos to download")
            return

        ok_count = 0
        skip_count = 0
        err_count = 0

        # 3. Download each video
        for i, item in enumerate(video_queue):
            if is_cancelled(job_id):
                await db.update_job(job_id, status="cancelled", progress=round(i / total, 4),
                                    message=f"Cancelled at {i}/{total}", completed_at=datetime.utcnow().isoformat())
                await _broadcast_job_update(job_id, "cancelled", round(i / total, 4), f"Cancelled at {i}/{total}")
                return

            video_id = item["video_id"]
            dialect_val = item["dialect"]

            # Skip if already downloaded
            if await db.is_video_downloaded(video_id, dialect_val):
                skip_count += 1
                await _broadcast_log(job_id, f"SKIP (exists): {video_id}")
                progress = round((i + 1) / total, 4)
                msg = f"{i+1}/{total} — {ok_count} ok, {skip_count} skip, {err_count} err"
                await _broadcast_job_update(job_id, "running", progress, msg)
                continue

            raw_dir = Path(DATA_DIR) / "raw" / dialect_val
            try:
                wav_path, duration = await download_video(item["url"], raw_dir, video_id)
                await db.mark_video_downloaded(
                    video_id=video_id,
                    dialect=dialect_val,
                    source_id=item["source_id"],
                    file_path=str(wav_path),
                    duration_seconds=duration,
                    status="ok",
                    error_message=None,
                )
                ok_count += 1
                await _broadcast_log(job_id, f"OK [{duration:.1f}s]: {video_id}")
            except (AgeRestrictedError, GeoBlockedError, VideoUnavailableError) as e:
                err_count += 1
                reason = type(e).__name__.replace("Error", "")
                await db.mark_video_downloaded(
                    video_id=video_id,
                    dialect=dialect_val,
                    source_id=item["source_id"],
                    file_path=None,
                    duration_seconds=None,
                    status="skipped",
                    error_message=str(e),
                )
                await _broadcast_log(job_id, f"SKIP ({reason}): {video_id}")
            except DownloadError as e:
                err_count += 1
                await _broadcast_log(job_id, f"ERROR: {video_id} — {e}")

            progress = round((i + 1) / total, 4)
            msg = f"{i+1}/{total} — {ok_count} ok, {skip_count} skip, {err_count} err"
            await db.update_job(job_id, status="running", progress=progress, message=msg)
            await _broadcast_job_update(job_id, "running", progress, msg)

        final_msg = f"Done: {ok_count} ok, {skip_count} skip, {err_count} err"
        await db.update_job(job_id, status="completed", progress=1.0, message=final_msg,
                            completed_at=datetime.utcnow().isoformat())
        await _broadcast_job_update(job_id, "completed", 1.0, final_msg)

    except Exception as e:
        await db.update_job(job_id, status="failed", error=str(e), completed_at=datetime.utcnow().isoformat())
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
        "type": "scrape_log",
        "job_id": job_id,
        "line": line,
    })
