"""Trainer service — launches training subprocess, parses progress, returns stats.

All functions are synchronous (called via run_in_executor from the worker).
"""

import json
import os
import subprocess
import sys
from pathlib import Path


def launch_training(
    run_id: str,
    dataset_dir: str,
    output_dir: str,
    config: dict,
    progress_cb=None,   # (epoch, step, train_loss, eval_loss, line) — called for each parsed event
    is_cancelled=None,  # callable() -> bool — checked between lines
) -> dict:
    """
    Launch server/train_script.py as a subprocess.
    Streams stdout, calls progress_cb for each meaningful event.

    Returns:
        {current_epoch, current_step, best_loss, checkpoint_path, status}
    """
    # Write config to a temp JSON file in the output dir
    run_out = Path(output_dir) / run_id
    run_out.mkdir(parents=True, exist_ok=True)
    cfg_path = run_out / "train_config.json"

    full_config = {
        "run_id": run_id,
        "dataset_dir": dataset_dir,
        "output_dir": output_dir,
        **config,
    }
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump(full_config, f, ensure_ascii=False)

    script = Path(__file__).parent.parent / "train_script.py"

    proc = subprocess.Popen(
        [sys.executable, str(script), "--config", str(cfg_path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )

    state = {
        "current_epoch": 0,
        "current_step": 0,
        "best_loss": None,
        "checkpoint_path": None,
        "status": "running",
    }

    try:
        for raw_line in proc.stdout:
            line = raw_line.rstrip()
            if not line:
                continue

            if is_cancelled and is_cancelled():
                proc.terminate()
                try:
                    proc.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
                state["status"] = "cancelled"
                return state

            # Try JSON parse
            epoch = state["current_epoch"]
            step = state["current_step"]
            train_loss = None
            eval_loss = None
            parsed = False

            if line.startswith("{"):
                try:
                    data = json.loads(line)
                    epoch = data.get("epoch", epoch)
                    step = data.get("step", step)
                    train_loss = data.get("train_loss")
                    eval_loss = data.get("eval_loss")
                    ckpt = data.get("checkpoint_path")

                    state["current_epoch"] = epoch
                    state["current_step"] = step

                    if train_loss is not None:
                        if state["best_loss"] is None or train_loss < state["best_loss"]:
                            state["best_loss"] = train_loss

                    if ckpt:
                        state["checkpoint_path"] = ckpt

                    if data.get("status") == "completed":
                        state["status"] = "completed"
                        best = data.get("best_loss")
                        if best is not None:
                            state["best_loss"] = best

                    # Build a human-readable log line for the UI
                    if data.get("type") in ("info", "error"):
                        display_line = data["line"]
                    elif train_loss is not None:
                        display_line = f"STEP e{epoch} s{step}: loss={train_loss:.4f}"
                    elif eval_loss is not None:
                        display_line = f"EVAL  e{epoch} s{step}: loss={eval_loss:.4f}"
                    elif ckpt:
                        display_line = f"CKPT  saved → {Path(ckpt).name}"
                    else:
                        display_line = line

                    parsed = True
                except json.JSONDecodeError:
                    pass

            if not parsed:
                display_line = line

            if progress_cb:
                progress_cb(epoch, step, train_loss, eval_loss, display_line)

        proc.wait()

    except Exception:
        try:
            proc.kill()
            proc.wait()
        except Exception:
            pass
        raise

    if state["status"] == "running":
        state["status"] = "completed" if proc.returncode == 0 else "failed"

    return state


def get_checkpoints(checkpoints_dir: str) -> list:
    """Return list of checkpoint dirs (each containing best_model.pth or similar)."""
    base = Path(checkpoints_dir)
    if not base.exists():
        return []

    results = []
    for run_dir in sorted(base.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if not run_dir.is_dir():
            continue
        pth_files = list(run_dir.glob("**/*.pth"))
        if pth_files:
            best = max(pth_files, key=lambda p: p.stat().st_mtime)
            results.append({
                "run_id": run_dir.name,
                "path": str(run_dir),
                "best_model": str(best),
                "size_mb": round(best.stat().st_size / 1024 / 1024, 1),
                "modified_at": best.stat().st_mtime,
            })

    return results
