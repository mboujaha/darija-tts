FROM pytorch/pytorch:2.3.0-cuda12.1-cudnn8-runtime

WORKDIR /app

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ffmpeg \
    libsndfile1 \
    build-essential \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install deno (required by yt-dlp 2026+ for YouTube n-challenge solving)
RUN curl -fsSL https://deno.land/install.sh | sh
ENV DENO_INSTALL="/root/.deno"
ENV PATH="${DENO_INSTALL}/bin:${PATH}"

# Python deps — torch/torchaudio already in base image, skip them
COPY requirements.txt .
RUN pip install --no-cache-dir \
    fastapi uvicorn[standard] aiosqlite websockets python-multipart \
    pydantic pydantic-settings httpx \
    yt-dlp \
    soundfile noisereduce pyloudnorm \
    faster-whisper \
    && pip install --no-cache-dir \
    paramiko cryptography

# Copy source
COPY server/ ./server/

# Data dir
RUN mkdir -p /app/data

EXPOSE 8000

CMD ["uvicorn", "server.main:app", "--host", "0.0.0.0", "--port", "8000", "--reload"]
