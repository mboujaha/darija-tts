"""Synthesizer service — wraps XTTS v2 inference.

Keeps a single model instance in memory between requests.
All heavy functions are synchronous (called via run_in_executor).
"""

import os
import time
import wave
from pathlib import Path
from typing import Optional

# Module-level singleton
_model = None
_model_checkpoint: Optional[str] = None
_model_config = None


def _get_duration(wav_path: str) -> float:
    try:
        with wave.open(wav_path, "r") as wf:
            return wf.getnframes() / wf.getframerate()
    except Exception:
        return 0.0


def ensure_model_loaded(checkpoint_dir: Optional[str] = None) -> tuple:
    """Load (or reload) the XTTS v2 model. Returns (model, config).

    Uses a fine-tuned checkpoint if provided, otherwise downloads the base model.
    Reloads only when checkpoint_dir changes.
    """
    global _model, _model_checkpoint, _model_config

    if _model is not None and _model_checkpoint == (checkpoint_dir or "base"):
        return _model, _model_config

    try:
        from TTS.tts.configs.xtts_config import XttsConfig
        from TTS.tts.models.xtts import Xtts
    except ImportError as e:
        raise RuntimeError(
            f"Coqui TTS not installed: {e}. Install with: pip install TTS"
        ) from e

    resolved_dir = checkpoint_dir
    fine_tuned_pth = None  # path to a specific .pth for fine-tuned models

    # Resolve base model dir (always needed for config.json)
    base_model_dir = Path.home() / ".local/share/tts/tts_models--multilingual--multi-dataset--xtts_v2"

    if not resolved_dir or not Path(resolved_dir).exists():
        # Download / locate base XTTS v2 model
        try:
            from TTS.utils.manage import ModelManager
            manager = ModelManager()
            model_path, cfg_path, _ = manager.download_model(
                "tts_models/multilingual/multi-dataset/xtts_v2"
            )
            resolved_dir = str(Path(model_path).parent if not Path(model_path).is_dir() else Path(model_path))
            base_model_dir = Path(resolved_dir)
        except Exception as e:
            raise RuntimeError(f"Could not obtain XTTS v2 base model: {e}") from e
    else:
        # Fine-tuned run dir: find the best .pth nested inside it
        run_path = Path(resolved_dir)
        pth_files = list(run_path.glob("**/*.pth"))
        if pth_files:
            fine_tuned_pth = str(max(pth_files, key=lambda p: p.stat().st_mtime))
        # Fall back to cached base model for config.json if not present locally
        if not base_model_dir.exists():
            base_model_dir = run_path

    cfg = XttsConfig()
    # Always prefer base model config.json (fine-tuned models don't ship one)
    cfg_json = base_model_dir / "config.json"
    if not cfg_json.exists():
        cfg_json = Path(resolved_dir) / "config.json"
    if cfg_json.exists():
        cfg.load_json(str(cfg_json))

    model = Xtts.init_from_config(cfg)
    if fine_tuned_pth:
        # checkpoint_dir provides vocab.json/speaker encoder; checkpoint_path overrides model weights
        model.load_checkpoint(cfg, checkpoint_dir=str(base_model_dir), checkpoint_path=fine_tuned_pth, eval=True)
    else:
        model.load_checkpoint(cfg, checkpoint_dir=resolved_dir, eval=True)

    # Move to GPU if available
    try:
        import torch
        if torch.cuda.is_available():
            model.cuda()
    except Exception:
        pass

    _model = model
    _model_config = cfg
    _model_checkpoint = checkpoint_dir or "base"

    return _model, _model_config


def synthesize(
    text: str,
    speaker_wav: str,
    output_path: str,
    language: str = "ar",
    temperature: float = 0.65,
    speed: float = 1.0,
    checkpoint_dir: Optional[str] = None,
    gpt_cond_len: int = 6,
) -> dict:
    """Generate speech and write to output_path WAV.

    Returns {output_path, duration, checkpoint_used}
    """
    if not text.strip():
        raise ValueError("Text cannot be empty")
    if not Path(speaker_wav).exists():
        raise FileNotFoundError(f"Speaker WAV not found: {speaker_wav}")

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    model, cfg = ensure_model_loaded(checkpoint_dir)

    try:
        import torch
        import soundfile as sf
        import numpy as np

        with torch.no_grad():
            outputs = model.synthesize(
                text,
                cfg,
                speaker_wav=speaker_wav,
                language=language,
                gpt_cond_len=gpt_cond_len,
                temperature=temperature,
                speed=speed,
            )

        wav = outputs.get("wav")
        if wav is None:
            wav = outputs.get("audio")
        if wav is None:
            raise RuntimeError("Model returned no audio output")

        if hasattr(wav, "cpu"):
            wav = wav.cpu().numpy()

        sample_rate = cfg.audio.output_sample_rate if hasattr(cfg, "audio") else 24000
        sf.write(output_path, wav, sample_rate, subtype="PCM_16")

    except Exception as e:
        # If model fails, reset singleton so next call reloads
        global _model
        _model = None
        raise RuntimeError(f"Synthesis failed: {e}") from e

    duration = _get_duration(output_path)
    return {
        "output_path": output_path,
        "duration": round(duration, 3),
        "checkpoint_used": _model_checkpoint,
    }


def list_voices(dataset_dir: str) -> list:
    """Scan dataset/speaker_wavs and reference_speakers for usable voices."""
    voices = []
    seen = set()

    dirs_to_scan = [
        ("dataset", Path(dataset_dir) / "speaker_wavs"),
        ("reference", Path(dataset_dir).parent / "reference_speakers"),
    ]

    for source, d in dirs_to_scan:
        if not d.exists():
            continue
        for wav in sorted(d.glob("*.wav")):
            key = wav.stem
            if key in seen:
                continue
            seen.add(key)
            voices.append({
                "id": key,
                "name": key.replace("_", " ").title(),
                "file_path": str(wav),
                "source": source,
            })

    return voices


def list_generated(generated_dir: str, limit: int = 30) -> list:
    """List recently generated WAV files, newest first."""
    d = Path(generated_dir)
    if not d.exists():
        return []
    wavs = sorted(d.glob("*.wav"), key=lambda p: p.stat().st_mtime, reverse=True)
    results = []
    for wav in wavs[:limit]:
        results.append({
            "filename": wav.name,
            "url": f"/api/audio/generated/{wav.name}",
            "duration": round(_get_duration(str(wav)), 3),
            "created_at": wav.stat().st_mtime,
        })
    return results


def unload_model():
    """Free GPU/CPU memory — useful when switching to training."""
    global _model, _model_checkpoint, _model_config
    if _model is not None:
        try:
            import torch
            del _model
            torch.cuda.empty_cache()
        except Exception:
            pass
    _model = None
    _model_checkpoint = None
    _model_config = None
