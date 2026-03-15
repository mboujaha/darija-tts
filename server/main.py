import uvicorn
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pathlib import Path

from server import db
from server.config import HOST, PORT, DATA_DIR
from server.ws import ws_manager
from server.routes import settings, monitor, sources, scrape, process, transcribe, dataset, train, synthesize, evaluate, export


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.init_db()
    yield


app = FastAPI(title="Darija TTS API", version="1.0.0", lifespan=lifespan, redirect_slashes=False)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://fm.cosumar.app",
        "http://fm.cosumar.app",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(settings.router)
app.include_router(monitor.router)
app.include_router(sources.router)
app.include_router(scrape.router)
app.include_router(process.router)
app.include_router(transcribe.router)
app.include_router(dataset.router)
app.include_router(train.router)
app.include_router(synthesize.router)
app.include_router(evaluate.router)
app.include_router(export.router)


@app.websocket("/ws/jobs")
async def websocket_jobs(websocket: WebSocket):
    await ws_manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
    except WebSocketDisconnect:
        await ws_manager.disconnect(websocket)


@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "darija-tts"}


# Serve audio files
data_path = Path(DATA_DIR)
if data_path.exists():
    app.mount("/api/audio", StaticFiles(directory=str(data_path)), name="audio")


if __name__ == "__main__":
    uvicorn.run("server.main:app", host=HOST, port=PORT, reload=True)
