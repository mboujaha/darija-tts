import logging
from pathlib import Path

import numpy as np
import soundfile as sf

logger = logging.getLogger(__name__)

_vad_model = None
_diarize_pipeline = None


def _get_vad_model():
    global _vad_model
    if _vad_model is None:
        from silero_vad import load_silero_vad
        _vad_model = load_silero_vad()
    return _vad_model


def _get_diarize_pipeline(hf_token: str):
    global _diarize_pipeline
    if _diarize_pipeline is None:
        from pyannote.audio import Pipeline
        _diarize_pipeline = Pipeline.from_pretrained(
            "pyannote/speaker-diarization-3.1",
            use_auth_token=hf_token,
        )
    return _diarize_pipeline


def get_speech_segments(wav_path: str, min_dur: float, max_dur: float) -> list[dict]:
    from silero_vad import load_silero_vad, get_speech_timestamps, read_audio

    model = _get_vad_model()
    wav_16k = read_audio(wav_path, sampling_rate=16000)
    timestamps = get_speech_timestamps(
        wav_16k,
        model,
        return_seconds=True,
        min_speech_duration_ms=int(min_dur * 1000),
        max_speech_duration_s=max_dur,
    )
    return [t for t in timestamps if min_dur <= (t["end"] - t["start"]) <= max_dur]


def compute_snr(audio: np.ndarray) -> float:
    frame_size = 1024
    n_frames = len(audio) // frame_size
    if n_frames == 0:
        return 99.0

    frames = audio[:n_frames * frame_size].reshape(n_frames, frame_size)
    energies = np.mean(frames ** 2, axis=1)
    energies_sorted = np.sort(energies)

    noise_count = max(1, int(n_frames * 0.2))
    noise_energies = energies_sorted[:noise_count]
    signal_energies = energies_sorted[noise_count:]

    noise_energy = np.mean(noise_energies)
    if noise_energy < 1e-10:
        return 99.0

    signal_energy = np.mean(signal_energies) if len(signal_energies) > 0 else noise_energy
    return float(10 * np.log10(signal_energy / noise_energy))


def denoise_audio(audio: np.ndarray, sr: int) -> np.ndarray:
    import noisereduce as nr
    return nr.reduce_noise(y=audio, sr=sr)


def get_speaker_map(wav_path: str, hf_token: str) -> dict:
    pipeline = _get_diarize_pipeline(hf_token)
    diarization = pipeline(wav_path)
    speaker_map = {}
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        speaker_map[(turn.start, turn.end)] = speaker
    return speaker_map


def assign_speaker(start: float, end: float, speaker_map: dict) -> str | None:
    best_speaker = None
    best_overlap = 0.0
    for (seg_start, seg_end), speaker in speaker_map.items():
        overlap = max(0.0, min(end, seg_end) - max(start, seg_start))
        if overlap > best_overlap:
            best_overlap = overlap
            best_speaker = speaker
    return best_speaker


def extract_and_save_clip(audio: np.ndarray, sr: int, start: float, end: float, out_path: str):
    start_sample = int(start * sr)
    end_sample = int(end * sr)
    clip = audio[start_sample:end_sample]
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    sf.write(out_path, clip, sr)
