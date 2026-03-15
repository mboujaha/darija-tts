import asyncio
import logging
from datetime import datetime
from pathlib import Path

from server import db
from server.config import DATA_DIR
from server.services.evaluator import run_batch_eval, save_results
from server.services.synthesizer import list_voices
from server.ws import ws_manager

logger = logging.getLogger(__name__)

_cancel_flags: dict[str, bool] = {}

EVAL_DIR = str(Path(DATA_DIR) / "evaluations")
DATASET_DIR = str(Path(DATA_DIR) / "dataset")


def request_cancel(job_id: str):
    _cancel_flags[job_id] = True


def is_cancelled(job_id: str) -> bool:
    return _cancel_flags.get(job_id, False)


async def run_eval_job(job_id: str, config: dict):
    _cancel_flags[job_id] = False
    await db.update_job(job_id, status="running", started_at=datetime.utcnow().isoformat())
    await _broadcast_job_update(job_id, "running", 0.0, "Starting evaluation…")

    sentences = config.get("sentences", [])
    speaker_ids = config.get("speaker_ids", [])   # empty = all voices
    checkpoint_dir = config.get("checkpoint_dir") or None
    language = config.get("language", "ar")
    temperature = float(config.get("temperature", 0.65))

    loop = asyncio.get_event_loop()

    try:
        # Resolve voices
        all_voices = list_voices(DATASET_DIR)
        if speaker_ids:
            voices = [v for v in all_voices if v["id"] in speaker_ids]
        else:
            voices = all_voices

        if not voices:
            msg = "No voices found. Build a dataset first."
            await db.update_job(job_id, status="failed", error=msg,
                                completed_at=datetime.utcnow().isoformat())
            await _broadcast_job_update(job_id, "failed", 0.0, msg)
            return

        if not sentences:
            msg = "No test sentences provided."
            await db.update_job(job_id, status="failed", error=msg,
                                completed_at=datetime.utcnow().isoformat())
            await _broadcast_job_update(job_id, "failed", 0.0, msg)
            return

        total_pairs = len(sentences) * len(voices)
        await _broadcast_log(job_id,
            f"INFO Evaluating {len(sentences)} sentences × {len(voices)} voices "
            f"= {total_pairs} samples")

        output_dir = str(Path(EVAL_DIR) / job_id)

        def progress_cb(done, total, line):
            if is_cancelled(job_id):
                raise asyncio.CancelledError()
            asyncio.run_coroutine_threadsafe(
                _broadcast_log(job_id, line), loop
            ).result(timeout=2)
            progress = round(done / total, 4) if total > 0 else 0.0
            asyncio.run_coroutine_threadsafe(
                _broadcast_job_update(job_id, "running", progress,
                                      f"{done}/{total} samples evaluated"),
                loop,
            ).result(timeout=2)
            if done % max(1, total // 10) == 0:
                asyncio.run_coroutine_threadsafe(
                    db.update_job(job_id, status="running", progress=progress),
                    loop,
                ).result(timeout=2)

        results = await loop.run_in_executor(
            None,
            lambda: run_batch_eval(
                sentences=sentences,
                voices=voices,
                checkpoint_dir=checkpoint_dir,
                output_dir=output_dir,
                language=language,
                temperature=temperature,
                progress_cb=progress_cb,
                is_cancelled=lambda: is_cancelled(job_id),
            ),
        )

        cancelled = is_cancelled(job_id)

        # Save results JSON
        results_path = str(Path(EVAL_DIR) / f"{job_id}.json")
        Path(EVAL_DIR).mkdir(parents=True, exist_ok=True)
        save_results(results, results_path)

        # Compute summary stats
        ok = [r for r in results if not r.get("error")]
        summary = {}
        for key in ("mcd", "speaker_sim", "snr", "rtf"):
            vals = [r[key] for r in ok if r.get(key) is not None]
            summary[f"avg_{key}"] = round(sum(vals) / len(vals), 4) if vals else None

        status = "cancelled" if cancelled else "completed"
        final_msg = (
            f"{'Cancelled' if cancelled else 'Done'}: {len(ok)}/{len(results)} OK | "
            + " | ".join(f"{k}={v}" for k, v in summary.items() if v is not None)
        )

        await db.update_job(job_id, status=status, progress=1.0,
                            message=final_msg,
                            completed_at=datetime.utcnow().isoformat())
        await _broadcast_job_update(job_id, status, 1.0, final_msg)
        await _broadcast_log(job_id, f"DONE Results saved → {results_path}")

    except asyncio.CancelledError:
        await db.update_job(job_id, status="cancelled",
                            message="Cancelled",
                            completed_at=datetime.utcnow().isoformat())
        await _broadcast_job_update(job_id, "cancelled", 0.0, "Cancelled")
    except Exception as e:
        logger.exception("Eval job failed")
        await db.update_job(job_id, status="failed", error=str(e),
                            completed_at=datetime.utcnow().isoformat())
        await _broadcast_job_update(job_id, "failed", 0.0, f"Error: {e}")
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
        "type": "eval_log",
        "job_id": job_id,
        "line": line,
    })
