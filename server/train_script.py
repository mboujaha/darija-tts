#!/usr/bin/env python3
"""Standalone XTTS v2 fine-tuning script.

Launched as a subprocess by the train worker.
Reads config from --config <json_file>.
Emits JSON progress lines to stdout so the worker can parse them.

Progress line shapes:
  {"type": "info",  "line": "some message"}
  {"type": "error", "line": "error message"}
  {"epoch": 3, "step": 150, "train_loss": 0.34}
  {"epoch": 3, "step": 150, "eval_loss": 0.28}
  {"epoch": 5, "step": 300, "train_loss": 0.21, "checkpoint_path": "/..."}
  {"status": "completed", "checkpoint_path": "/..."}
"""

import argparse
import json
import os
import sys
import traceback
from pathlib import Path


def emit(data: dict):
    print(json.dumps(data, ensure_ascii=False), flush=True)


def info(msg: str):
    emit({"type": "info", "line": msg})


def error(msg: str):
    emit({"type": "error", "line": msg})


def load_samples(csv_path: str, dataset_dir: str) -> list:
    samples = []
    with open(csv_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("audio_file"):
                continue
            parts = line.split("|", 2)
            if len(parts) < 3:
                continue
            audio_rel, text, speaker = parts
            audio_abs = str(Path(dataset_dir) / audio_rel)
            samples.append({
                "audio_file": audio_abs,
                "text": text.strip(),
                "speaker_name": speaker.strip(),
                "language": "ar",
                "root_path": dataset_dir,
            })
    return samples


def run(config: dict):
    dataset_dir = config["dataset_dir"]
    output_dir = config["output_dir"]
    run_id = config["run_id"]
    epochs = int(config.get("epochs", 10))
    batch_size = int(config.get("batch_size", 2))
    grad_accum = int(config.get("grad_accumulation", 8))
    lr = float(config.get("learning_rate", 5e-6))
    training_type = config.get("training_type", "full")
    base_checkpoint = config.get("base_checkpoint") or None

    info(f"Run ID: {run_id}")
    info(f"Epochs: {epochs} | Batch: {batch_size} | Grad accum: {grad_accum} | LR: {lr}")
    info(f"Training type: {training_type}")

    train_csv = Path(dataset_dir) / "metadata_train.csv"
    eval_csv = Path(dataset_dir) / "metadata_eval.csv"

    if not train_csv.exists():
        error(f"metadata_train.csv not found at {train_csv}. Run Dataset Builder first.")
        sys.exit(1)

    train_samples = load_samples(str(train_csv), dataset_dir)
    eval_samples = load_samples(str(eval_csv), dataset_dir) if eval_csv.exists() else []

    if not train_samples:
        error("No training samples found. Check metadata_train.csv.")
        sys.exit(1)

    info(f"Loaded {len(train_samples)} train samples, {len(eval_samples)} eval samples")

    # --- Import Coqui TTS ---
    try:
        from TTS.tts.configs.xtts_config import XttsConfig
        from TTS.tts.models.xtts import Xtts
        from trainer import Trainer, TrainerArgs
    except ImportError as e:
        error(f"Coqui TTS not installed: {e}")
        error("Install with: pip install TTS")
        sys.exit(2)

    # --- Resolve base checkpoint ---
    if base_checkpoint and Path(base_checkpoint).exists():
        checkpoint_dir = base_checkpoint
        info(f"Using local checkpoint: {checkpoint_dir}")
    else:
        info("Downloading XTTS v2 base model (this may take a while)…")
        try:
            os.environ["COQUI_TOS_AGREED"] = "1"
            from TTS.utils.manage import ModelManager
            manager = ModelManager()
            model_path, cfg_path, _ = manager.download_model(
                "tts_models/multilingual/multi-dataset/xtts_v2"
            )
            checkpoint_dir = str(Path(model_path).parent)
            info(f"Base model ready at {checkpoint_dir}")
        except Exception as e:
            error(f"Failed to obtain base model: {e}")
            sys.exit(3)

    # --- Build config ---
    cfg = XttsConfig()
    base_cfg_json = Path(checkpoint_dir) / "config.json"
    if base_cfg_json.exists():
        cfg.load_json(str(base_cfg_json))

    cfg.epochs = epochs
    cfg.batch_size = batch_size
    cfg.eval_batch_size = 1
    cfg.num_loader_workers = 4
    cfg.num_eval_loader_workers = 1
    cfg.run_eval = len(eval_samples) > 0
    cfg.test_delay_epochs = -1
    cfg.print_step = 50
    cfg.plot_step = 100
    cfg.save_step = 10000
    cfg.save_n_checkpoints = 2
    cfg.save_checkpoints = True
    cfg.save_best_after = 0
    cfg.lr = lr
    cfg.grad_accumulation_steps = grad_accum

    out_path = Path(output_dir) / run_id
    out_path.mkdir(parents=True, exist_ok=True)

    # --- Load model ---
    info("Loading XTTS v2 base model weights…")
    try:
        model = Xtts.init_from_config(cfg)
        model.load_checkpoint(cfg, checkpoint_dir=checkpoint_dir, eval=True)
    except Exception as e:
        error(f"Failed to load model: {e}")
        traceback.print_exc()
        sys.exit(4)

    # --- Freeze layers for non-full training ---
    if training_type == "freeze_encoder":
        frozen = 0
        for name, param in model.named_parameters():
            if "gpt" not in name:
                param.requires_grad = False
                frozen += 1
        info(f"Freeze-encoder mode: {frozen} parameter tensors frozen")

    info("Initialising trainer…")

    # Track progress via closure
    _state = {"step": 0, "best_loss": None, "checkpoint_path": None}

    # Patch the trainer's log method to capture step-level losses
    # We subclass Trainer to intercept fit_step output
    class ProgressTrainer(Trainer):
        def train_step(self, batch, criterion, optimizer_idx):
            result = super().train_step(batch, criterion, optimizer_idx)
            _state["step"] += 1
            if _state["step"] % cfg.print_step == 0:
                loss_val = None
                if isinstance(result, dict):
                    loss_val = result.get("loss")
                    if loss_val is not None:
                        loss_val = float(loss_val)
                if _state["best_loss"] is None or (loss_val and loss_val < _state["best_loss"]):
                    _state["best_loss"] = loss_val
                emit({
                    "epoch": self.epochs_done,
                    "step": _state["step"],
                    "train_loss": loss_val,
                })
            return result

        def eval_step(self, batch, criterion, optimizer_idx):
            result = super().eval_step(batch, criterion, optimizer_idx)
            if isinstance(result, dict):
                eval_loss = result.get("loss")
                if eval_loss is not None:
                    emit({
                        "epoch": self.epochs_done,
                        "step": _state["step"],
                        "eval_loss": float(eval_loss),
                    })
            return result

        def save_best_model(self):
            super().save_best_model()
            ckpt = str(out_path / "best_model.pth")
            _state["checkpoint_path"] = ckpt
            emit({
                "epoch": self.epochs_done,
                "step": _state["step"],
                "train_loss": _state["best_loss"],
                "checkpoint_path": ckpt,
            })

    try:
        trainer = ProgressTrainer(
            TrainerArgs(
                restore_path=None,
                skip_train_epoch=False,
                start_with_eval=False,
                grad_accum_steps=grad_accum,
            ),
            cfg,
            output_path=str(out_path),
            model=model,
            train_samples=train_samples,
            eval_samples=eval_samples,
        )
        info("Training started — watching for progress…")
        trainer.fit()
    except KeyboardInterrupt:
        info("Training interrupted by signal")
        sys.exit(0)
    except Exception as e:
        error(f"Training failed: {e}")
        traceback.print_exc()
        sys.exit(5)

    checkpoint_path = _state["checkpoint_path"] or str(out_path / "best_model.pth")
    emit({
        "status": "completed",
        "checkpoint_path": checkpoint_path,
        "best_loss": _state["best_loss"],
    })
    info(f"Training complete. Best loss: {_state['best_loss']}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="XTTS v2 fine-tuning script")
    parser.add_argument("--config", required=True, help="Path to JSON config file")
    args = parser.parse_args()

    with open(args.config, encoding="utf-8") as f:
        cfg = json.load(f)

    run(cfg)
