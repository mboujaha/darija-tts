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

# Auto-accept Coqui TOS for non-interactive environments
os.environ["COQUI_TOS_AGREED"] = "1"


def emit(data: dict):
    print(json.dumps(data, ensure_ascii=False), flush=True)


def info(msg: str):
    emit({"type": "info", "line": msg})


def error(msg: str):
    emit({"type": "error", "line": msg})


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

    # Count samples for a quick sanity check
    def count_csv(path):
        if not Path(path).exists():
            return 0
        with open(path) as f:
            return sum(1 for l in f if l.strip() and not l.startswith("audio_file"))

    n_train = count_csv(train_csv)
    n_eval = count_csv(eval_csv)
    if n_train == 0:
        error("No training samples found. Check metadata_train.csv.")
        sys.exit(1)
    info(f"Loaded {n_train} train samples, {n_eval} eval samples")

    # --- Import Coqui TTS ---
    try:
        from trainer import Trainer, TrainerArgs
        from TTS.config.shared_configs import BaseDatasetConfig
        from TTS.tts.datasets import load_tts_samples
        from TTS.tts.layers.xtts.trainer.gpt_trainer import (
            GPTArgs, GPTTrainer, GPTTrainerConfig, XttsAudioConfig,
        )
        from TTS.utils.manage import ModelManager
    except ImportError as e:
        error(f"Coqui TTS not installed: {e}")
        error("Install with: pip install TTS")
        sys.exit(2)

    # --- Resolve base checkpoint files ---
    model_dir_default = Path.home() / ".local/share/tts/tts_models--multilingual--multi-dataset--xtts_v2"

    if base_checkpoint and Path(base_checkpoint).is_dir():
        model_dir = Path(base_checkpoint)
        info(f"Using local checkpoint: {model_dir}")
    elif model_dir_default.exists():
        model_dir = model_dir_default
        info(f"Using cached model at {model_dir}")
    else:
        info("Downloading XTTS v2 base model (this may take a while)…")
        try:
            model_path, _, _ = ModelManager().download_model(
                "tts_models/multilingual/multi-dataset/xtts_v2"
            )
            model_dir = Path(model_path) if Path(model_path).is_dir() else Path(model_path).parent
            info(f"Base model ready at {model_dir}")
        except Exception as e:
            error(f"Failed to obtain base model: {e}")
            sys.exit(3)

    # DVAE + mel_norm are required by GPTArgs but not bundled with the model download.
    # Cache them alongside the model.
    dvae_path = model_dir / "dvae.pth"
    mel_norm_path = model_dir / "mel_stats.pth"

    if not dvae_path.exists() or not mel_norm_path.exists():
        info("Downloading DVAE and mel-norm files…")
        try:
            ModelManager._download_model_files(
                [
                    "https://coqui.gateway.scarf.sh/hf-coqui/XTTS-v2/main/dvae.pth",
                    "https://coqui.gateway.scarf.sh/hf-coqui/XTTS-v2/main/mel_stats.pth",
                ],
                str(model_dir),
                progress_bar=False,
            )
        except Exception as e:
            error(f"Failed to download auxiliary model files: {e}")
            sys.exit(3)

    xtts_checkpoint = str(model_dir / "model.pth")
    tokenizer_file = str(model_dir / "vocab.json")
    dvae_checkpoint = str(dvae_path)
    mel_norm_file = str(mel_norm_path)

    # --- Output path ---
    out_path = Path(output_dir) / run_id
    out_path.mkdir(parents=True, exist_ok=True)

    # --- Dataset config ---
    dataset_cfg = BaseDatasetConfig(
        formatter="coqui",
        dataset_name="darija_ft",
        path=dataset_dir,
        meta_file_train=str(train_csv),
        meta_file_val=str(eval_csv) if eval_csv.exists() else "",
        language="ar",
    )

    # --- GPT model args ---
    model_args = GPTArgs(
        max_conditioning_length=132300,   # 6 s at 22050 Hz
        min_conditioning_length=66150,    # 3 s
        debug_loading_failures=False,
        max_wav_length=255995,            # ~11.6 s
        max_text_length=200,
        mel_norm_file=mel_norm_file,
        dvae_checkpoint=dvae_checkpoint,
        xtts_checkpoint=xtts_checkpoint,
        tokenizer_file=tokenizer_file,
        gpt_num_audio_tokens=1026,
        gpt_start_audio_token=1024,
        gpt_stop_audio_token=1025,
        gpt_use_masking_gt_prompt_approach=True,
        gpt_use_perceiver_resampler=True,
    )

    audio_config = XttsAudioConfig(
        sample_rate=22050,
        dvae_sample_rate=22050,
        output_sample_rate=24000,
    )

    # --- Freeze encoder if requested ---
    # GPTTrainer only trains the GPT component by default; full fine-tune
    # means we allow all GPT weights. "freeze_encoder" is handled via the
    # optimizer targeting only GPT weights — which GPTTrainer already does.
    # We flag it in the run name for visibility.
    run_name = f"XTTS_FT_{'freeze' if training_type == 'freeze_encoder' else 'full'}"

    train_cfg = GPTTrainerConfig(
        epochs=epochs,
        output_path=str(out_path),
        model_args=model_args,
        run_name=run_name,
        project_name="darija_xtts",
        audio=audio_config,
        batch_size=batch_size,
        batch_group_size=48,
        eval_batch_size=max(1, batch_size // 2),
        num_loader_workers=4,
        eval_split_max_size=256,
        print_step=50,
        plot_step=100,
        log_model_step=1000,
        save_step=1000,
        save_n_checkpoints=2,
        save_checkpoints=True,
        print_eval=False,
        optimizer="AdamW",
        optimizer_wd_only_on_weights=True,
        optimizer_params={"betas": [0.9, 0.96], "eps": 1e-8, "weight_decay": 1e-2},
        lr=lr,
        lr_scheduler="MultiStepLR",
        lr_scheduler_params={
            "milestones": [50000 * 18, 150000 * 18, 300000 * 18],
            "gamma": 0.5,
            "last_epoch": -1,
        },
        test_sentences=[],
        start_with_eval=False,
    )

    # --- Load samples ---
    info("Loading dataset samples…")
    try:
        train_samples, eval_samples = load_tts_samples(
            [dataset_cfg],
            eval_split=True,
            eval_split_max_size=train_cfg.eval_split_max_size,
            eval_split_size=train_cfg.eval_split_size,
        )
    except Exception as e:
        error(f"Failed to load dataset: {e}")
        traceback.print_exc()
        sys.exit(4)

    info(f"Dataset ready: {len(train_samples)} train, {len(eval_samples)} eval")

    # --- Init model ---
    info("Initialising GPTTrainer model…")
    try:
        model = GPTTrainer.init_from_config(train_cfg)
    except Exception as e:
        error(f"Failed to init model: {e}")
        traceback.print_exc()
        sys.exit(4)

    # --- Freeze encoder layers if requested ---
    if training_type == "freeze_encoder":
        frozen = 0
        for name, param in model.named_parameters():
            if "gpt" not in name:
                param.requires_grad = False
                frozen += 1
        info(f"Freeze-encoder mode: {frozen} parameter tensors frozen")

    # --- Progress-tracking trainer ---
    _state = {"step": 0, "best_loss": None, "checkpoint_path": None}

    class ProgressTrainer(Trainer):
        def train_step(self, batch, criterion, optimizer_idx):
            result = super().train_step(batch, criterion, optimizer_idx)
            _state["step"] += 1
            if _state["step"] % train_cfg.print_step == 0:
                loss_val = None
                if isinstance(result, dict):
                    loss_val = result.get("loss")
                    if loss_val is not None:
                        loss_val = float(loss_val)
                if loss_val is not None and (
                    _state["best_loss"] is None or loss_val < _state["best_loss"]
                ):
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

    info("Initialising trainer…")
    try:
        trainer = ProgressTrainer(
            TrainerArgs(
                restore_path=None,
                skip_train_epoch=False,
                start_with_eval=False,
                grad_accum_steps=grad_accum,
            ),
            train_cfg,
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
