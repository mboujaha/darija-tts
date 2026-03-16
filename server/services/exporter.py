"""Exporter service — packages the dataset or a checkpoint as a ZIP/tar.gz.

Formats:
  coqui      — pipe-delimited metadata.csv + wavs/ + speaker_wavs/ (Coqui TTS default)
  ljspeech   — LJSpeech-style: metadata.csv (id|text|text), wavs/ flat
  huggingface — metadata.jsonl + wavs/

All functions are synchronous (called via run_in_executor or at startup).
No new dependencies — stdlib zipfile + tarfile only.
"""

import json
import tarfile
import zipfile
from pathlib import Path


# ── Helpers ────────────────────────────────────────────────────

def _read_metadata(dataset_dir: str) -> list:
    """Parse metadata.csv → list of {audio_file, text, speaker_name}."""
    rows = []
    csv_path = Path(dataset_dir) / "metadata.csv"
    if not csv_path.exists():
        return rows
    with open(csv_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("audio_file"):
                continue
            parts = line.split("|", 2)
            if len(parts) == 3:
                rows.append({
                    "audio_file": parts[0],
                    "text": parts[1],
                    "speaker_name": parts[2],
                })
    return rows


def _zip_add_file(zf: zipfile.ZipFile, disk_path: str, arc_path: str):
    if Path(disk_path).exists():
        zf.write(disk_path, arc_path)


# ── Format builders ────────────────────────────────────────────

def _build_coqui(dataset_dir: str, zf: zipfile.ZipFile, progress_cb=None):
    """Original Coqui format: metadata*.csv + wavs/ + speaker_wavs/."""
    base = Path(dataset_dir)
    files_to_add = []

    for csv_name in ("metadata.csv", "metadata_train.csv", "metadata_eval.csv"):
        p = base / csv_name
        if p.exists():
            files_to_add.append((str(p), csv_name))

    wavs_dir = base / "wavs"
    if wavs_dir.exists():
        for wav in sorted(wavs_dir.glob("*.wav")):
            files_to_add.append((str(wav), f"wavs/{wav.name}"))

    spk_dir = base / "speaker_wavs"
    if spk_dir.exists():
        for wav in sorted(spk_dir.glob("*.wav")):
            files_to_add.append((str(wav), f"speaker_wavs/{wav.name}"))

    total = len(files_to_add)
    for i, (disk, arc) in enumerate(files_to_add):
        zf.write(disk, arc)
        if progress_cb:
            progress_cb(i + 1, total)


def _build_ljspeech(dataset_dir: str, zf: zipfile.ZipFile, progress_cb=None):
    """LJSpeech format: flat wavs/, metadata.csv with id|text|text."""
    rows = _read_metadata(dataset_dir)
    base = Path(dataset_dir)

    meta_lines = ["id|transcription|normalized_transcription"]
    wav_entries = []
    for row in rows:
        audio_rel = row["audio_file"]          # e.g. wavs/abc001.wav
        stem = Path(audio_rel).stem            # abc001
        text = row["text"].replace("|", " ")
        meta_lines.append(f"{stem}|{text}|{text}")
        disk_path = str(base / audio_rel)
        if Path(disk_path).exists():
            wav_entries.append((disk_path, f"wavs/{stem}.wav"))

    # Write metadata
    meta_bytes = "\n".join(meta_lines).encode("utf-8")
    zf.writestr("metadata.csv", meta_bytes)

    total = len(wav_entries)
    for i, (disk, arc) in enumerate(wav_entries):
        zf.write(disk, arc)
        if progress_cb:
            progress_cb(i + 1, total)


def _build_huggingface(dataset_dir: str, zf: zipfile.ZipFile, progress_cb=None):
    """HuggingFace datasets format: metadata.jsonl + wavs/."""
    rows = _read_metadata(dataset_dir)
    base = Path(dataset_dir)

    jsonl_lines = []
    wav_entries = []
    for row in rows:
        audio_rel = row["audio_file"]
        disk_path = str(base / audio_rel)
        if Path(disk_path).exists():
            jsonl_lines.append(json.dumps({
                "file_name": audio_rel,
                "transcription": row["text"],
                "speaker_id": row["speaker_name"],
            }, ensure_ascii=False))
            wav_entries.append((disk_path, audio_rel))

    zf.writestr("metadata.jsonl", "\n".join(jsonl_lines).encode("utf-8"))

    total = len(wav_entries)
    for i, (disk, arc) in enumerate(wav_entries):
        zf.write(disk, arc)
        if progress_cb:
            progress_cb(i + 1, total)


# ── Public API ─────────────────────────────────────────────────

FORMATS = ("coqui", "ljspeech", "huggingface")


def build_dataset_zip(
    dataset_dir: str,
    output_path: str,
    fmt: str = "coqui",
    progress_cb=None,   # (done, total) or None
) -> dict:
    """Build a ZIP at output_path. Returns {path, size_mb, n_files}."""
    if fmt not in FORMATS:
        raise ValueError(f"Unknown format '{fmt}'. Choose from: {FORMATS}")

    dataset_dir = str(dataset_dir)
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        if fmt == "coqui":
            _build_coqui(dataset_dir, zf, progress_cb)
        elif fmt == "ljspeech":
            _build_ljspeech(dataset_dir, zf, progress_cb)
        elif fmt == "huggingface":
            _build_huggingface(dataset_dir, zf, progress_cb)

        n_files = len(zf.namelist())

    size_bytes = Path(output_path).stat().st_size
    return {
        "path": output_path,
        "size_mb": round(size_bytes / 1024 / 1024, 1),
        "n_files": n_files,
        "format": fmt,
    }


def build_checkpoint_tar(
    checkpoint_run_dir: str,
    output_path: str,
) -> dict:
    """Tar.gz a training run directory. Returns {path, size_mb}."""
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    src = Path(checkpoint_run_dir)
    if not src.exists():
        raise FileNotFoundError(f"Checkpoint directory not found: {checkpoint_run_dir}")

    with tarfile.open(output_path, "w:gz") as tf:
        tf.add(str(src), arcname=src.name)

    size_bytes = Path(output_path).stat().st_size
    return {
        "path": output_path,
        "size_mb": round(size_bytes / 1024 / 1024, 1),
        "run_id": src.name,
    }



def dataset_stats(dataset_dir: str) -> dict:
    """Return quick stats about what's exportable."""
    base = Path(dataset_dir)

    def csv_lines(name):
        p = base / name
        if not p.exists():
            return 0
        with open(p, encoding="utf-8") as f:
            return sum(1 for l in f if l.strip() and not l.startswith("audio_file"))

    wavs = list((base / "wavs").glob("*.wav")) if (base / "wavs").exists() else []
    speaker_wavs = list((base / "speaker_wavs").glob("*.wav")) if (base / "speaker_wavs").exists() else []
    total_bytes = sum(w.stat().st_size for w in wavs)

    return {
        "train_clips": csv_lines("metadata_train.csv"),
        "eval_clips": csv_lines("metadata_eval.csv"),
        "total_clips": csv_lines("metadata.csv"),
        "wav_files": len(wavs),
        "speaker_wavs": len(speaker_wavs),
        "wav_size_gb": round(total_bytes / 1e9, 2),
        "ready": len(wavs) > 0,
    }
