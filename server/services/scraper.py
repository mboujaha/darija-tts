import asyncio
import re
from pathlib import Path

COOKIES_FILE = "/app/cookies.txt"


def _cookies_args() -> list[str]:
    if Path(COOKIES_FILE).exists():
        return ["--cookies", COOKIES_FILE]
    return []


class DownloadError(Exception):
    pass


class AgeRestrictedError(DownloadError):
    pass


class GeoBlockedError(DownloadError):
    pass


class VideoUnavailableError(DownloadError):
    pass


def extract_video_id(url: str) -> str | None:
    # youtu.be/VIDEO_ID or ?v=VIDEO_ID or &v=VIDEO_ID
    m = re.search(r'youtu\.be/([A-Za-z0-9_-]{11})', url)
    if m:
        return m.group(1)
    m = re.search(r'[?&]v=([A-Za-z0-9_-]{11})', url)
    if m:
        return m.group(1)
    return None


async def list_videos(url: str, max_videos: int) -> list[str]:
    proc = await asyncio.create_subprocess_exec(
        "yt-dlp", "--flat-playlist", "--print", "url", "--playlist-end", str(max_videos),
        *_cookies_args(), url,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        err = stderr.decode()
        raise DownloadError(f"yt-dlp list failed: {err[:300]}")
    lines = [line.strip() for line in stdout.decode().splitlines() if line.strip()]
    return lines


async def download_video(url: str, output_dir: Path, video_id: str) -> tuple[Path, float]:
    output_dir.mkdir(parents=True, exist_ok=True)
    output_template = str(output_dir / f"{video_id}.%(ext)s")
    proc = await asyncio.create_subprocess_exec(
        "yt-dlp",
        "--extract-audio",
        "--audio-format", "wav",
        "--postprocessor-args", "ffmpeg:-ar 22050 -ac 1",
        "-o", output_template,
        "--no-playlist",
        "--age-limit", "99",
        *_cookies_args(),
        url,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, stderr = await proc.communicate()
    combined = stdout.decode() + stderr.decode()

    if proc.returncode != 0:
        lower = combined.lower()
        if "sign in to confirm" in lower or "cookies" in lower:
            raise AgeRestrictedError(f"Auth required (add cookies.txt): {video_id}")
        if "age" in lower and ("restrict" in lower or "confirm" in lower):
            raise AgeRestrictedError(f"Age restricted: {video_id}")
        if "geo" in lower or "not available in your country" in lower or "blocked" in lower:
            raise GeoBlockedError(f"Geo-blocked: {video_id}")
        if "video unavailable" in lower or "private video" in lower or "has been removed" in lower:
            raise VideoUnavailableError(f"Video unavailable: {video_id}")
        raise DownloadError(f"Download failed for {video_id}: {combined[:300]}")

    wav_path = output_dir / f"{video_id}.wav"
    if not wav_path.exists():
        # yt-dlp may have produced a different name — search for it
        candidates = list(output_dir.glob(f"{video_id}*.wav"))
        if candidates:
            wav_path = candidates[0]
        else:
            raise DownloadError(f"WAV file not found after download: {video_id}")

    duration = await _get_wav_duration(wav_path)
    return wav_path, duration


async def _get_wav_duration(path: Path) -> float:
    proc = await asyncio.create_subprocess_exec(
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await proc.communicate()
    try:
        return float(stdout.decode().strip())
    except (ValueError, TypeError):
        return 0.0
