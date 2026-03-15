import logging
import math

from server.utils.arabic_text import remove_hallucinations, normalize_darija, is_valid_darija

logger = logging.getLogger(__name__)

_whisper_model = None
_current_model_size: str | None = None


def _get_model(model_size: str, device: str = "cuda", compute_type: str = "float16"):
    global _whisper_model, _current_model_size
    if _whisper_model is None or _current_model_size != model_size:
        from faster_whisper import WhisperModel
        logger.info("Loading Whisper model: %s on %s (%s)", model_size, device, compute_type)
        _whisper_model = WhisperModel(model_size, device=device, compute_type=compute_type)
        _current_model_size = model_size
    return _whisper_model


def transcribe_clip(
    wav_path: str,
    model_size: str = "large-v3",
    min_confidence: float = 0.6,
    language: str = "ar",
) -> dict | None:
    try:
        model = _get_model(model_size)
    except Exception:
        # Fallback to CPU if CUDA not available
        try:
            model = _get_model(model_size, device="cpu", compute_type="int8")
        except Exception as e:
            logger.error("Failed to load Whisper model: %s", e)
            return None

    try:
        segments_gen, _info = model.transcribe(
            wav_path, language=language, beam_size=5, word_timestamps=True
        )
        all_segments = list(segments_gen)
    except Exception as e:
        logger.error("Transcription failed for %s: %s", wav_path, e)
        return None

    if not all_segments:
        return None

    avg_logprob = sum(s.avg_logprob for s in all_segments) / len(all_segments)
    confidence = min(1.0, max(0.0, math.exp(avg_logprob)))

    text = " ".join(s.text.strip() for s in all_segments)
    text = remove_hallucinations(text)
    text = normalize_darija(text)

    if not is_valid_darija(text):
        return None

    if confidence < min_confidence:
        return None

    return {"text": text, "confidence": confidence}
