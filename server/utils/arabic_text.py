import re
import unicodedata

DARIJA_CHARS = "ءآأؤإئابةتثجحخدذرزسشصضطظعغفقكلمنهوىيپچژگڤ"
FRENCH_CHARS = "abcdefghijklmnopqrstuvwxyzàâéèêëïîôùûüç"
PUNCTUATION  = "!,.؟،؛-:\"' "

HALLUCINATIONS = [
    "بسم الله الرحمن الرحيم",
    "اشترك في القناة",
    "شكرا على المشاهدة",
    "subscribe",
    "thanks for watching",
]


def normalize_darija(text: str) -> str:
    # Strip tatweel (ـ U+0640)
    text = text.replace("\u0640", "")
    # Normalize repeated punctuation (e.g. "..." → ".")
    text = re.sub(r'([!,\.؟،؛\-])\1+', r'\1', text)
    # Collapse multiple spaces
    text = re.sub(r' +', ' ', text)
    return text.strip()


def is_valid_darija(text: str) -> bool:
    if not text:
        return False
    has_arabic = any(c in DARIJA_CHARS for c in text)
    if not has_arabic:
        return False
    # Strip punctuation/digits/spaces and check non-empty
    cleaned = re.sub(r'[\d\s\W]', '', text)
    return len(cleaned) > 0


def remove_hallucinations(text: str) -> str:
    for h in HALLUCINATIONS:
        text = re.sub(re.escape(h), '', text, flags=re.IGNORECASE)
    return text.strip()


def detect_code_switching(text: str) -> dict:
    total = len(text.replace(' ', ''))
    if total == 0:
        return {"arabic_ratio": 0.0, "french_ratio": 0.0, "other_ratio": 1.0}

    arabic_count = sum(1 for c in text if c in DARIJA_CHARS)
    french_count = sum(1 for c in text.lower() if c in FRENCH_CHARS)
    other_count = max(0, total - arabic_count - french_count)

    return {
        "arabic_ratio": round(arabic_count / total, 3),
        "french_ratio": round(french_count / total, 3),
        "other_ratio": round(other_count / total, 3),
    }
