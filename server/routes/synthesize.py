import asyncio
import json
import re
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from server.config import DATA_DIR, CHECKPOINTS_DIR
from server.services.synthesizer import (
    synthesize,
    list_voices,
    list_generated,
    unload_model,
)
from server.services.trainer import get_checkpoints

router = APIRouter(prefix="/api/synthesize", tags=["synthesize"])

GENERATED_DIR = str(Path(DATA_DIR) / "generated")
DATASET_DIR = str(Path(DATA_DIR) / "dataset")

# Ensure generated dir exists
Path(GENERATED_DIR).mkdir(parents=True, exist_ok=True)


def _split_sentences(text: str) -> list:
    """Split text on Arabic/Latin sentence boundaries and newlines."""
    # Split on sentence-ending punctuation followed by whitespace, or newlines
    parts = re.split(r'(?<=[.!?؟\u06D4])\s+|\n+', text.strip())
    result = [p.strip() for p in parts if p.strip()]
    return result or [text.strip()]


class StreamRequest(BaseModel):
    text: str
    speaker_id: str
    language: str = "ar"
    temperature: float = 0.65
    speed: float = 1.0
    checkpoint_dir: Optional[str] = None
    gpt_cond_len: int = 6


class GenerateRequest(BaseModel):
    text: str
    speaker_id: str                    # maps to a voice file_path via /voices
    language: str = "ar"
    temperature: float = 0.65
    speed: float = 1.0
    checkpoint_dir: Optional[str] = None   # path to fine-tuned checkpoint dir
    gpt_cond_len: int = 6


@router.get("/voices")
async def get_voices():
    voices = list_voices(DATASET_DIR)
    return {"voices": voices}


@router.get("/checkpoints")
async def get_checkpoints_list():
    checkpoints = get_checkpoints(CHECKPOINTS_DIR)
    return {"checkpoints": checkpoints}


@router.post("/generate")
async def generate(body: GenerateRequest):
    # Resolve speaker WAV path
    voices = list_voices(DATASET_DIR)
    voice = next((v for v in voices if v["id"] == body.speaker_id), None)
    if voice is None:
        raise HTTPException(400, detail=f"Speaker '{body.speaker_id}' not found. Check /voices.")

    speaker_wav = voice["file_path"]
    filename = f"{int(time.time())}_{uuid.uuid4().hex[:8]}.wav"
    output_path = str(Path(GENERATED_DIR) / filename)

    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(
            None,
            lambda: synthesize(
                text=body.text,
                speaker_wav=speaker_wav,
                output_path=output_path,
                language=body.language,
                temperature=body.temperature,
                speed=body.speed,
                checkpoint_dir=body.checkpoint_dir,
                gpt_cond_len=body.gpt_cond_len,
            ),
        )
    except FileNotFoundError as e:
        raise HTTPException(400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(500, detail=str(e))

    return {
        "filename": filename,
        "url": f"/api/audio/generated/{filename}",
        "duration": result["duration"],
        "checkpoint_used": result["checkpoint_used"],
        "speaker_id": body.speaker_id,
        "text": body.text,
    }


@router.post("/stream")
async def stream_synthesis(body: StreamRequest):
    """
    SSE endpoint — splits text into sentences, synthesizes each chunk in sequence,
    and streams chunk URLs as Server-Sent Events so the client can play audio progressively.

    Event shapes:
      data: {"index":0,"total":3,"url":"/api/audio/generated/x.wav","duration":2.1,"sentence":"...","done":false}
      data: {"done":true,"total":3}
      data: {"index":1,"error":"...","sentence":"...","done":false}
    """
    voices = list_voices(DATASET_DIR)
    voice = next((v for v in voices if v["id"] == body.speaker_id), None)
    if voice is None:
        raise HTTPException(400, detail=f"Speaker '{body.speaker_id}' not found.")

    speaker_wav = voice["file_path"]
    sentences = _split_sentences(body.text)
    loop = asyncio.get_event_loop()

    async def generate():
        for i, sentence in enumerate(sentences):
            filename = f"stream_{int(time.time())}_{uuid.uuid4().hex[:6]}_{i}.wav"
            output_path = str(Path(GENERATED_DIR) / filename)
            try:
                result = await loop.run_in_executor(
                    None,
                    lambda s=sentence, o=output_path: synthesize(
                        text=s,
                        speaker_wav=speaker_wav,
                        output_path=o,
                        language=body.language,
                        temperature=body.temperature,
                        speed=body.speed,
                        checkpoint_dir=body.checkpoint_dir,
                        gpt_cond_len=body.gpt_cond_len,
                    ),
                )
                chunk = {
                    "index": i,
                    "total": len(sentences),
                    "url": f"/api/audio/generated/{filename}",
                    "duration": result["duration"],
                    "sentence": sentence,
                    "done": False,
                }
            except Exception as e:
                chunk = {
                    "index": i,
                    "total": len(sentences),
                    "error": str(e),
                    "sentence": sentence,
                    "done": False,
                }
            yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"

        yield f"data: {json.dumps({'done': True, 'total': len(sentences)})}\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.get("/generated")
async def get_generated(limit: int = 30):
    items = list_generated(GENERATED_DIR, limit=limit)
    return {"items": items}


@router.delete("/generated/{filename}")
async def delete_generated(filename: str):
    # Safety: only allow simple filenames, no path traversal
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(400, detail="Invalid filename")
    path = Path(GENERATED_DIR) / filename
    if not path.exists():
        raise HTTPException(404, detail="File not found")
    path.unlink()
    return {"deleted": filename}


@router.post("/unload-model")
async def unload():
    """Free model from memory (e.g. before starting training)."""
    unload_model()
    return {"status": "unloaded"}
