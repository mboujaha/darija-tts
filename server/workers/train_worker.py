import asyncio
import logging
from datetime import datetime
from pathlib import Path

from server import db
from server.config import DATA_DIR, CHECKPOINTS_DIR
from server.services.trainer import launch_training
from server.ws import ws_manager

logger = logging.getLogger(__name__)

_cancel_flags: dict[str, bool] = {}


def request_cancel(job_id: str):
    _cancel_flags[job_id] = True


def is_cancelled(job_id: str) -> bool:
    return _cancel_flags.get(job_id, False)


async def run_train_job(job_id: str, run_id: str, config: dict):
    _cancel_flags[job_id] = False
    await db.update_job(job_id, status="running", started_at=datetime.utcnow().isoformat())
    await db.update_training_run(run_id, status="running")
    await _broadcast_job_update(job_id, "running", 0.0, "Starting training…")

    dataset_dir = str(Path(DATA_DIR) / "dataset")
    output_dir = CHECKPOINTS_DIR
    total_epochs = config.get("epochs", 10)

    loop = asyncio.get_event_loop()

    # DB update throttle: only persist every N steps to avoid hammering SQLite
    _last_db_step = [0]
    DB_UPDATE_EVERY = 50

    def progress_cb(epoch, step, train_loss, eval_loss, line):
        if is_cancelled(job_id):
            raise asyncio.CancelledError()

        # Broadcast log line
        asyncio.run_coroutine_threadsafe(
            _broadcast_log(job_id, line), loop
        ).result(timeout=2)

        # Broadcast job progress
        progress = round(epoch / total_epochs, 4) if total_epochs > 0 else 0.0
        msg_parts = [f"Epoch {epoch}/{total_epochs}"]
        if train_loss is not None:
            msg_parts.append(f"loss={train_loss:.4f}")
        msg = " | ".join(msg_parts)

        asyncio.run_coroutine_threadsafe(
            _broadcast_job_update(job_id, "running", progress, msg), loop
        ).result(timeout=2)

        # Persist to DB periodically
        if step - _last_db_step[0] >= DB_UPDATE_EVERY:
            _last_db_step[0] = step
            update_kwargs = dict(
                current_epoch=epoch,
                current_step=step,
                status="running",
            )
            if train_loss is not None:
                update_kwargs["current_loss"] = train_loss
            asyncio.run_coroutine_threadsafe(
                db.update_training_run(run_id, **update_kwargs), loop
            ).result(timeout=2)

            if train_loss is not None or eval_loss is not None:
                asyncio.run_coroutine_threadsafe(
                    db.add_loss_entry(run_id, step, epoch, train_loss, eval_loss), loop
                ).result(timeout=2)

            asyncio.run_coroutine_threadsafe(
                db.update_job(job_id, status="running", progress=progress, message=msg), loop
            ).result(timeout=2)

    try:
        result = await loop.run_in_executor(
            None,
            lambda: launch_training(
                run_id=run_id,
                dataset_dir=dataset_dir,
                output_dir=output_dir,
                config=config,
                progress_cb=progress_cb,
                is_cancelled=lambda: is_cancelled(job_id),
            ),
        )

        status = result.get("status", "completed")
        best_loss = result.get("best_loss")
        checkpoint_path = result.get("checkpoint_path")
        final_epoch = result.get("current_epoch", 0)

        if status == "cancelled":
            await db.update_training_run(
                run_id,
                status="cancelled",
                current_epoch=final_epoch,
                best_loss=best_loss,
                checkpoint_path=checkpoint_path,
            )
            await db.update_job(
                job_id, status="cancelled",
                message="Cancelled",
                completed_at=datetime.utcnow().isoformat(),
            )
            await _broadcast_job_update(job_id, "cancelled", 0.0, "Cancelled")
            return

        if status == "failed":
            await db.update_training_run(run_id, status="failed")
            await db.update_job(
                job_id, status="failed",
                error="Training subprocess exited with error",
                completed_at=datetime.utcnow().isoformat(),
            )
            await _broadcast_job_update(job_id, "failed", 0.0, "Training failed — check logs")
            return

        # Completed
        await db.update_training_run(
            run_id,
            status="completed",
            current_epoch=total_epochs,
            best_loss=best_loss,
            checkpoint_path=checkpoint_path,
        )
        final_msg = f"Done — best loss: {best_loss:.4f}" if best_loss else "Done"
        if checkpoint_path:
            final_msg += f" | checkpoint saved"
        await db.update_job(
            job_id, status="completed", progress=1.0,
            message=final_msg,
            completed_at=datetime.utcnow().isoformat(),
        )
        await _broadcast_job_update(job_id, "completed", 1.0, final_msg)

    except asyncio.CancelledError:
        await db.update_training_run(run_id, status="cancelled")
        await db.update_job(
            job_id, status="cancelled",
            message="Cancelled",
            completed_at=datetime.utcnow().isoformat(),
        )
        await _broadcast_job_update(job_id, "cancelled", 0.0, "Cancelled")
    except Exception as e:
        logger.exception("Train job failed")
        await db.update_training_run(run_id, status="failed")
        await db.update_job(
            job_id, status="failed", error=str(e),
            completed_at=datetime.utcnow().isoformat(),
        )
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
        "type": "train_log",
        "job_id": job_id,
        "line": line,
    })
