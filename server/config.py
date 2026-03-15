import os
from pathlib import Path

BASE_DIR = Path(__file__).parent.parent

DATA_DIR = os.getenv("DATA_DIR", str(BASE_DIR / "data"))
CHECKPOINTS_DIR = os.getenv("CHECKPOINTS_DIR", str(BASE_DIR / "checkpoints"))
CONFIGS_DIR = os.getenv("CONFIGS_DIR", str(BASE_DIR / "configs"))

SAMPLE_RATE = 22050
OUTPUT_SAMPLE_RATE = 24000
DIALECTS = ["casablanca", "marrakech", "north", "east", "south"]

DEFAULT_WHISPER_MODEL = "large-v3"
DEFAULT_MIN_SNR = 15.0
DEFAULT_MIN_CONFIDENCE = 0.6
DEFAULT_MIN_DURATION = 3.0
DEFAULT_MAX_DURATION = 11.0
DEFAULT_MIN_SPEAKER_CLIPS = 20
DEFAULT_TRAINING_TYPE = "full"
DEFAULT_BATCH_SIZE = 2
DEFAULT_GRAD_ACCUMULATION = 8
DEFAULT_LEARNING_RATE = 5e-6
DEFAULT_EPOCHS = 50

HF_TOKEN = os.getenv("HF_TOKEN", "")
HOST = os.getenv("HOST", "0.0.0.0")
PORT = int(os.getenv("PORT", "8000"))

DB_PATH = os.getenv("DB_PATH", str(BASE_DIR / "darija_tts.db"))

# Ensure data directories exist
for subdir in ["raw", "processed", "transcribed", "corrections", "dataset", "reference_speakers", "generated", "evaluations"]:
    Path(DATA_DIR, subdir).mkdir(parents=True, exist_ok=True)

Path(CHECKPOINTS_DIR).mkdir(parents=True, exist_ok=True)
Path(CONFIGS_DIR).mkdir(parents=True, exist_ok=True)
