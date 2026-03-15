import asyncio
import logging
from datetime import datetime
from pathlib import Path

import soundfile as sf

from server import db
from server.config import DATA_DIR
from server.services.audio_processor import (
    get_speech_segments,
    compute_snr,
    denoise_audio,
    get_speaker_map,
    assign_speaker,
    extract_and_save_clip,
)
from server.ws import ws_manager

logger = logging.getLogger(__name__)

_cancel_flags: dict[str, bool] = {}


def request_cancel(job_id: str):
    _cancel_flags[job_id] = True


def is_cancelled(job_id: str) -> bool:
    return _cancel_flags.get(job_id, False)


async def run_process_job(job_id: str, dialect: str | None, config: dict):
    _cancel_flags[job_id] = False
    await db.update_job(job_id, status="running", started_at=datetime.utcnow().isoformat())
    await _broadcast_job_update(job_id, "running", 0.0, "Starting…")

    min_dur = config.get("min_duration", 3.0)
    max_dur = config.get("max_duration", 11.0)
    min_snr = config.get("min_snr", 15.0)
    denoise = config.get("denoise", True)
    diarize = config.get("diarize", False)

    try:
        videos = await db.get_downloaded_videos(dialect)
        if not videos:
            await db.update_job(job_id, status="completed", progress=1.0,
                                message="No downloaded videos found",
                                completed_at=datetime.utcnow().isoformat())
            await _broadcast_job_update(job_id, "completed", 1.0, "No downloaded videos found")
            return

        hf_token = None
        if diarize:
            hf_token = await db.get_setting("hf_token")
            if not hf_token:
                await _broadcast_log(job_id, "WARN: diarize=True but no hf_token in settings, skipping diarization")
                diarize = False

        total = len(videos)
        total_saved = 0
        total_rejected = 0

        for i, video in enumerate(videos):
            if is_cancelled(job_id):
                await db.update_job(job_id, status="cancelled",
                                    progress=round(i / total, 4),
                                    message=f"Cancelled at {i}/{total}",
                                    completed_at=datetime.utcnow().isoformat())
                await _broadcast_job_update(job_id, "cancelled", round(i / total, 4), f"Cancelled at {i}/{total}")
                return

            video_id = video["video_id"]
            video_dialect = video["dialect"]
            file_path = video.get("file_path")

            if not file_path or not Path(file_path).exists():
                await _broadcast_log(job_id, f"SKIP {video_id}: file missing on disk")
                progress = round((i + 1) / total, 4)
                msg = f"{i+1}/{total} — {total_saved} clips"
                await db.update_job(job_id, status="running", progress=progress, message=msg)
                await _broadcast_job_update(job_id, "running", progress, msg)
                continue

            try:
                segments = get_speech_segments(file_path, min_dur, max_dur)
            except Exception as e:
                await _broadcast_log(job_id, f"ERROR {video_id}: VAD failed — {e}")
                progress = round((i + 1) / total, 4)
                await db.update_job(job_id, status="running", progress=progress)
                await _broadcast_job_update(job_id, "running", progress, f"{i+1}/{total} — {total_saved} clips")
                continue

            speaker_map = {}
            if diarize:
                try:
                    loop = asyncio.get_event_loop()
                    speaker_map = await loop.run_in_executor(
                        None, lambda: get_speaker_map(file_path, hf_token)
                    )
                except Exception as e:
                    await _broadcast_log(job_id, f"WARN {video_id}: diarization failed — {e}")

            # Load full audio once for all segments
            try:
                audio, sr = sf.read(file_path)
                if audio.ndim > 1:
                    audio = audio.mean(axis=1)
            except Exception as e:
                await _broadcast_log(job_id, f"ERROR {video_id}: could not read audio — {e}")
                continue

            ok_count = 0
            rejected_count = 0

            for seg in segments:
                start = seg["start"]
                end = seg["end"]
                clip_id = f"{video_id}_{int(start * 1000):08d}"

                if await db.clip_exists(clip_id):
                    continue

                start_sample = int(start * sr)
                end_sample = int(end * sr)
                clip_audio = audio[start_sample:end_sample].copy()

                if denoise:
                    try:
                        clip_audio = denoise_audio(clip_audio, sr)
                    except Exception as e:
                        logger.warning("Denoise failed for %s: %s", clip_id, e)

                snr = compute_snr(clip_audio)

                if snr < min_snr:
                    rejected_count += 1
                    await _broadcast_log(job_id, f"REJECT {clip_id} [SNR {snr:.1f} dB]")
                    continue

                speaker = assign_speaker(start, end, speaker_map) if speaker_map else None

                out_path = str(Path(DATA_DIR) / "processed" / video_dialect / f"{clip_id}.wav")
                try:
                    extract_and_save_clip(clip_audio, sr, 0, len(clip_audio) / sr, out_path)
                except Exception as e:
                    await _broadcast_log(job_id, f"ERROR saving {clip_id}: {e}")
                    continue

                duration = end - start
                await db.create_clip(
                    clip_id=clip_id,
                    source_id=video.get("source_id"),
                    dialect=video_dialect,
                    speaker=speaker,
                    file_path=out_path,
                    duration=duration,
                    snr=snr,
                )
                ok_count += 1

            total_saved += ok_count
            total_rejected += rejected_count
            await _broadcast_log(job_id, f"VIDEO {video_id}: {ok_count} saved, {rejected_count} rejected")

            progress = round((i + 1) / total, 4)
            msg = f"{i+1}/{total} — {total_saved} clips"
            await db.update_job(job_id, status="running", progress=progress, message=msg)
            await _broadcast_job_update(job_id, "running", progress, msg)

        final_msg = f"Done: {total_saved} saved, {total_rejected} rejected"
        await db.update_job(job_id, status="completed", progress=1.0, message=final_msg,
                            completed_at=datetime.utcnow().isoformat())
        await _broadcast_job_update(job_id, "completed", 1.0, final_msg)

    except Exception as e:
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
        "type": "process_log",
        "job_id": job_id,
        "line": line,
    })
