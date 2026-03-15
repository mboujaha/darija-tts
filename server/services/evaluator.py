"""Evaluation service — computes TTS quality metrics.

Metrics (all pure numpy/scipy, optional librosa/resemblyzer):
  - MCD   : Mel Cepstral Distortion (dB) — lower is better
  - Sim   : Speaker cosine similarity 0–1  — higher is better
  - SNR   : Signal-to-noise ratio (dB) of generated audio — higher is better
  - RTF   : Real-Time Factor (synthesis_time / audio_duration) — lower is better

All heavy functions are synchronous (called via run_in_executor).
"""

import json
import time
from pathlib import Path
from typing import Optional

import numpy as np
import soundfile as sf

from server.services.audio_processor import compute_snr
from server.services.synthesizer import synthesize


# ── Audio helpers ──────────────────────────────────────────────

def _load_mono(path: str) -> tuple:
    """Return (audio_float32, sample_rate)."""
    audio, sr = sf.read(path, dtype="float32", always_2d=True)
    return audio.mean(axis=1), sr


def _resample(audio: np.ndarray, src_sr: int, dst_sr: int) -> np.ndarray:
    if src_sr == dst_sr:
        return audio
    try:
        import librosa
        return librosa.resample(audio, orig_sr=src_sr, target_sr=dst_sr)
    except ImportError:
        # Crude linear resample via scipy
        from scipy.signal import resample_poly
        from math import gcd
        g = gcd(src_sr, dst_sr)
        return resample_poly(audio, dst_sr // g, src_sr // g).astype(np.float32)


def _extract_mfcc(audio: np.ndarray, sr: int, n_mfcc: int = 24, n_fft: int = 512,
                   hop: int = 256) -> np.ndarray:
    """Return (T, n_mfcc) MFCC matrix. Uses librosa if available, else scipy DCT."""
    try:
        import librosa
        mfcc = librosa.feature.mfcc(y=audio, sr=sr, n_mfcc=n_mfcc,
                                     n_fft=n_fft, hop_length=hop)
        return mfcc.T  # (T, n_mfcc)
    except ImportError:
        pass

    # Fallback: log-mel spectrogram → DCT
    from scipy.fft import dct
    n_mels = 80
    n_frames = (len(audio) - n_fft) // hop + 1
    if n_frames <= 0:
        return np.zeros((1, n_mfcc), dtype=np.float32)

    mel_filters = _mel_filterbank(sr, n_fft, n_mels)
    frames_matrix = np.stack([
        audio[i * hop: i * hop + n_fft] * np.hanning(n_fft)
        for i in range(n_frames)
    ])
    spec = np.abs(np.fft.rfft(frames_matrix, n=n_fft)) ** 2
    mel_spec = np.maximum(spec @ mel_filters.T, 1e-10)
    log_mel = np.log(mel_spec)
    mfcc = dct(log_mel, type=2, axis=1, norm="ortho")[:, :n_mfcc]
    return mfcc.astype(np.float32)


def _mel_filterbank(sr: int, n_fft: int, n_mels: int) -> np.ndarray:
    """Compute a mel filterbank matrix (n_mels, n_fft//2+1)."""
    f_min, f_max = 0.0, sr / 2.0
    def hz_to_mel(f): return 2595 * np.log10(1 + f / 700)
    def mel_to_hz(m): return 700 * (10 ** (m / 2595) - 1)
    mel_points = np.linspace(hz_to_mel(f_min), hz_to_mel(f_max), n_mels + 2)
    hz_points = mel_to_hz(mel_points)
    bin_points = np.floor((n_fft + 1) * hz_points / sr).astype(int)
    filters = np.zeros((n_mels, n_fft // 2 + 1))
    for m in range(1, n_mels + 1):
        l, c, r = bin_points[m - 1], bin_points[m], bin_points[m + 1]
        for k in range(l, c):
            if c != l:
                filters[m - 1, k] = (k - l) / (c - l)
        for k in range(c, r):
            if r != c:
                filters[m - 1, k] = (r - k) / (r - c)
    return filters


# ── Metrics ───────────────────────────────────────────────────

def compute_mcd(ref_path: str, gen_path: str, n_mfcc: int = 24) -> float:
    """Mel Cepstral Distortion (dB). Lower = better. Skip first coeff (energy)."""
    ref_audio, ref_sr = _load_mono(ref_path)
    gen_audio, gen_sr = _load_mono(gen_path)

    # Align to same sr
    target_sr = max(ref_sr, gen_sr)
    ref_audio = _resample(ref_audio, ref_sr, target_sr)
    gen_audio = _resample(gen_audio, gen_sr, target_sr)

    ref_mfcc = _extract_mfcc(ref_audio, target_sr, n_mfcc)[:, 1:]   # drop c0
    gen_mfcc = _extract_mfcc(gen_audio, target_sr, n_mfcc)[:, 1:]

    # Pad/truncate to same length for frame-by-frame comparison
    min_len = min(len(ref_mfcc), len(gen_mfcc))
    if min_len == 0:
        return 0.0
    ref_mfcc = ref_mfcc[:min_len]
    gen_mfcc = gen_mfcc[:min_len]

    diff = ref_mfcc - gen_mfcc
    mcd = (10.0 / np.log(10)) * np.sqrt(2) * np.mean(np.sqrt(np.sum(diff ** 2, axis=1)))
    return round(float(mcd), 4)


def compute_speaker_similarity(ref_path: str, gen_path: str) -> float:
    """Cosine similarity 0–1 between speaker embeddings. Higher = more similar."""
    # Try resemblyzer
    try:
        from resemblyzer import VoiceEncoder, preprocess_wav
        encoder = VoiceEncoder()
        ref_emb = encoder.embed_utterance(preprocess_wav(ref_path))
        gen_emb = encoder.embed_utterance(preprocess_wav(gen_path))
        sim = float(np.dot(ref_emb, gen_emb) /
                    (np.linalg.norm(ref_emb) * np.linalg.norm(gen_emb) + 1e-9))
        return round(max(0.0, sim), 4)
    except ImportError:
        pass

    # Fallback: average MFCC vector cosine similarity
    ref_audio, ref_sr = _load_mono(ref_path)
    gen_audio, gen_sr = _load_mono(gen_path)
    ref_mfcc = _extract_mfcc(ref_audio, ref_sr, n_mfcc=40).mean(axis=0)
    gen_mfcc = _extract_mfcc(gen_audio, gen_sr, n_mfcc=40).mean(axis=0)
    norm_ref = np.linalg.norm(ref_mfcc)
    norm_gen = np.linalg.norm(gen_mfcc)
    if norm_ref < 1e-9 or norm_gen < 1e-9:
        return 0.0
    sim = float(np.dot(ref_mfcc, gen_mfcc) / (norm_ref * norm_gen))
    return round(max(0.0, min(1.0, sim)), 4)


def compute_f0_stats(path: str) -> dict:
    """Return {mean_hz, std_hz} for voiced frames. Requires librosa."""
    try:
        import librosa
        audio, sr = _load_mono(path)
        f0, voiced, _ = librosa.pyin(audio, fmin=50, fmax=500, sr=sr)
        f0_voiced = f0[voiced & ~np.isnan(f0)]
        if len(f0_voiced) == 0:
            return {"mean_hz": None, "std_hz": None}
        return {
            "mean_hz": round(float(np.mean(f0_voiced)), 2),
            "std_hz":  round(float(np.std(f0_voiced)), 2),
        }
    except Exception:
        return {"mean_hz": None, "std_hz": None}


def compute_metrics(gen_path: str, ref_path: str) -> dict:
    """Run all metrics for one generated file vs its speaker reference."""
    gen_audio, _ = _load_mono(gen_path)
    snr = compute_snr(gen_audio)
    mcd = compute_mcd(ref_path, gen_path)
    sim = compute_speaker_similarity(ref_path, gen_path)
    f0 = compute_f0_stats(gen_path)
    return {
        "snr": round(snr, 2),
        "mcd": mcd,
        "speaker_sim": sim,
        "f0_mean_hz": f0["mean_hz"],
        "f0_std_hz": f0["std_hz"],
    }


# ── Batch evaluation ──────────────────────────────────────────

def run_batch_eval(
    sentences: list,       # list of str
    voices: list,          # [{id, name, file_path}]
    checkpoint_dir: Optional[str],
    output_dir: str,
    language: str = "ar",
    temperature: float = 0.65,
    progress_cb=None,      # (done, total, line) or None
    is_cancelled=None,     # () -> bool
) -> list:
    """
    For each (sentence, voice) pair: synthesize, compute metrics, return results.

    Returns list of dicts:
        {sentence, speaker_id, speaker_name, gen_path, gen_url,
         duration, rtf, snr, mcd, speaker_sim, f0_mean_hz, f0_std_hz, error}
    """
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    pairs = [(s, v) for s in sentences for v in voices]
    total = len(pairs)
    results = []

    for i, (sentence, voice) in enumerate(pairs):
        if is_cancelled and is_cancelled():
            break

        speaker_id = voice["id"]
        ref_path = voice["file_path"]
        filename = f"eval_{speaker_id}_{i:04d}.wav"
        gen_path = str(Path(output_dir) / filename)

        row = {
            "sentence": sentence,
            "speaker_id": speaker_id,
            "speaker_name": voice.get("name", speaker_id),
            "gen_path": gen_path,
            "gen_url": f"/api/audio/evaluations/{filename}",
            "duration": None, "rtf": None,
            "snr": None, "mcd": None,
            "speaker_sim": None,
            "f0_mean_hz": None, "f0_std_hz": None,
            "error": None,
        }

        t0 = time.time()
        try:
            syn_result = synthesize(
                text=sentence,
                speaker_wav=ref_path,
                output_path=gen_path,
                language=language,
                temperature=temperature,
                checkpoint_dir=checkpoint_dir,
            )
            elapsed = time.time() - t0
            duration = syn_result["duration"]
            rtf = round(elapsed / duration, 3) if duration > 0 else None

            row["duration"] = duration
            row["rtf"] = rtf

            metrics = compute_metrics(gen_path, ref_path)
            row.update(metrics)

            line = (f"OK   [{i+1}/{total}] {speaker_id} | "
                    f"MCD={row['mcd']} sim={row['speaker_sim']} "
                    f"SNR={row['snr']} RTF={rtf}")
        except Exception as e:
            row["error"] = str(e)
            line = f"ERR  [{i+1}/{total}] {speaker_id}: {e}"

        results.append(row)
        if progress_cb:
            progress_cb(i + 1, total, line)

    return results


def save_results(results: list, path: str):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)


def load_results(path: str) -> list:
    with open(path, encoding="utf-8") as f:
        return json.load(f)
