import aiosqlite
import json
from datetime import datetime
from typing import Optional, Any
from server.config import DB_PATH

CREATE_TABLES_SQL = """
CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    source_type TEXT NOT NULL,
    dialect TEXT NOT NULL,
    max_videos INTEGER DEFAULT 50,
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS clips (
    id TEXT PRIMARY KEY,
    source_id INTEGER REFERENCES sources(id),
    dialect TEXT NOT NULL,
    speaker TEXT,
    file_path TEXT NOT NULL,
    duration REAL NOT NULL,
    snr REAL,
    status TEXT DEFAULT 'processed',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS transcriptions (
    clip_id TEXT PRIMARY KEY REFERENCES clips(id),
    text TEXT NOT NULL,
    confidence REAL,
    is_corrected BOOLEAN DEFAULT FALSE,
    corrected_by TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS reference_speakers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    dialect TEXT NOT NULL,
    file_path TEXT NOT NULL,
    duration REAL NOT NULL,
    description TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    status TEXT DEFAULT 'queued',
    progress REAL DEFAULT 0,
    message TEXT,
    config TEXT,
    error TEXT,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS training_runs (
    id TEXT PRIMARY KEY,
    job_id TEXT REFERENCES jobs(id),
    config TEXT NOT NULL,
    current_epoch INTEGER DEFAULT 0,
    total_epochs INTEGER,
    current_step INTEGER DEFAULT 0,
    current_loss REAL,
    best_loss REAL,
    checkpoint_path TEXT,
    training_type TEXT DEFAULT 'full',
    status TEXT DEFAULT 'running',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS downloaded_videos (
    video_id TEXT NOT NULL,
    source_id INTEGER REFERENCES sources(id) ON DELETE SET NULL,
    dialect TEXT NOT NULL,
    file_path TEXT,
    duration_seconds REAL,
    status TEXT DEFAULT 'ok',
    error_message TEXT,
    downloaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (video_id, dialect)
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS loss_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES training_runs(id),
    step INTEGER NOT NULL,
    epoch INTEGER,
    train_loss REAL,
    eval_loss REAL,
    recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
"""


async def init_db():
    async with aiosqlite.connect(DB_PATH) as db:
        for statement in CREATE_TABLES_SQL.split(";"):
            stmt = statement.strip()
            if stmt:
                await db.execute(stmt)
        await db.commit()


async def get_setting(key: str, default: Any = None) -> Any:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT value FROM settings WHERE key = ?", (key,)) as cur:
            row = await cur.fetchone()
            if row is None:
                return default
            try:
                return json.loads(row[0])
            except (json.JSONDecodeError, TypeError):
                return row[0]


async def set_setting(key: str, value: Any):
    serialized = json.dumps(value) if not isinstance(value, str) else value
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (key, serialized, datetime.utcnow().isoformat()),
        )
        await db.commit()


async def get_all_settings() -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT key, value FROM settings") as cur:
            rows = await cur.fetchall()
    result = {}
    for key, value in rows:
        try:
            result[key] = json.loads(value)
        except (json.JSONDecodeError, TypeError):
            result[key] = value
    return result


async def create_job(job_id: str, job_type: str, config: dict = None) -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO jobs (id, job_type, status, progress, config, created_at) VALUES (?, ?, 'queued', 0, ?, ?)",
            (job_id, job_type, json.dumps(config or {}), datetime.utcnow().isoformat()),
        )
        await db.commit()
    return {"id": job_id, "job_type": job_type, "status": "queued"}


async def update_job(job_id: str, **kwargs):
    if not kwargs:
        return
    allowed = {"status", "progress", "message", "error", "started_at", "completed_at"}
    fields = {k: v for k, v in kwargs.items() if k in allowed}
    if not fields:
        return
    set_clause = ", ".join(f"{k} = ?" for k in fields)
    values = list(fields.values()) + [job_id]
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(f"UPDATE jobs SET {set_clause} WHERE id = ?", values)
        await db.commit()


async def get_job(job_id: str) -> Optional[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)) as cur:
            row = await cur.fetchone()
    if row is None:
        return None
    d = dict(row)
    if d.get("config"):
        try:
            d["config"] = json.loads(d["config"])
        except Exception:
            pass
    return d


async def get_jobs(limit: int = 50, job_type: str = None) -> list:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if job_type:
            async with db.execute(
                "SELECT * FROM jobs WHERE job_type = ? ORDER BY created_at DESC LIMIT ?",
                (job_type, limit),
            ) as cur:
                rows = await cur.fetchall()
        else:
            async with db.execute(
                "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)
            ) as cur:
                rows = await cur.fetchall()
    result = []
    for row in rows:
        d = dict(row)
        if d.get("config"):
            try:
                d["config"] = json.loads(d["config"])
            except Exception:
                pass
        result.append(d)
    return result


async def create_source(url: str, source_type: str, dialect: str, max_videos: int = 50, notes: str = None) -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(
            "INSERT INTO sources (url, source_type, dialect, max_videos, notes) VALUES (?, ?, ?, ?, ?)",
            (url, source_type, dialect, max_videos, notes),
        )
        await db.commit()
        source_id = cur.lastrowid
    return {"id": source_id, "url": url, "source_type": source_type, "dialect": dialect, "max_videos": max_videos, "notes": notes}


async def get_sources(dialect: str = None) -> list:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if dialect:
            async with db.execute("SELECT * FROM sources WHERE dialect = ? ORDER BY created_at DESC", (dialect,)) as cur:
                rows = await cur.fetchall()
        else:
            async with db.execute("SELECT * FROM sources ORDER BY dialect, created_at DESC") as cur:
                rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def delete_source(source_id: int):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("DELETE FROM sources WHERE id = ?", (source_id,))
        await db.commit()


async def update_source(source_id: int, **kwargs):
    allowed = {"url", "source_type", "dialect", "max_videos", "notes"}
    fields = {k: v for k, v in kwargs.items() if k in allowed}
    if not fields:
        return
    set_clause = ", ".join(f"{k} = ?" for k in fields)
    values = list(fields.values()) + [source_id]
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(f"UPDATE sources SET {set_clause} WHERE id = ?", values)
        await db.commit()


async def is_video_downloaded(video_id: str, dialect: str) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT 1 FROM downloaded_videos WHERE video_id = ? AND dialect = ? AND status = 'ok'",
            (video_id, dialect),
        ) as cur:
            row = await cur.fetchone()
    return row is not None


async def mark_video_downloaded(
    video_id: str,
    dialect: str,
    source_id: Optional[int],
    file_path: Optional[str],
    duration_seconds: Optional[float],
    status: str = "ok",
    error_message: Optional[str] = None,
):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO downloaded_videos
               (video_id, dialect, source_id, file_path, duration_seconds, status, error_message, downloaded_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(video_id, dialect) DO UPDATE SET
               file_path=excluded.file_path,
               duration_seconds=excluded.duration_seconds,
               status=excluded.status,
               error_message=excluded.error_message,
               downloaded_at=excluded.downloaded_at""",
            (video_id, dialect, source_id, file_path, duration_seconds, status, error_message,
             datetime.utcnow().isoformat()),
        )
        await db.commit()


async def get_downloaded_videos(dialect: str = None) -> list:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if dialect:
            async with db.execute(
                "SELECT * FROM downloaded_videos WHERE status='ok' AND dialect = ?",
                (dialect,),
            ) as cur:
                rows = await cur.fetchall()
        else:
            async with db.execute(
                "SELECT * FROM downloaded_videos WHERE status='ok'",
            ) as cur:
                rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def get_all_downloaded_videos(
    dialect: str = None,
    status: str = None,
    limit: int = 200,
) -> list:
    conditions = []
    params: list = []
    if dialect:
        conditions.append("dialect = ?")
        params.append(dialect)
    if status and status != "all":
        conditions.append("status = ?")
        params.append(status)
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    params.append(limit)
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            f"SELECT * FROM downloaded_videos {where} ORDER BY downloaded_at DESC LIMIT ?",
            params,
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def delete_failed_videos(dialect: str = None) -> int:
    conditions = ["status != 'ok'"]
    params: list = []
    if dialect:
        conditions.append("dialect = ?")
        params.append(dialect)
    where = "WHERE " + " AND ".join(conditions)
    async with aiosqlite.connect(DB_PATH) as db:
        cur = await db.execute(f"DELETE FROM downloaded_videos {where}", params)
        await db.commit()
        return cur.rowcount


async def clip_exists(clip_id: str) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute("SELECT 1 FROM clips WHERE id = ?", (clip_id,)) as cur:
            row = await cur.fetchone()
    return row is not None


async def create_clip(
    clip_id: str,
    source_id: Optional[int],
    dialect: str,
    speaker: Optional[str],
    file_path: str,
    duration: float,
    snr: Optional[float],
) -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO clips (id, source_id, dialect, speaker, file_path, duration, snr, status) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, 'processed')",
            (clip_id, source_id, dialect, speaker, file_path, duration, snr),
        )
        await db.commit()
    return {"id": clip_id, "dialect": dialect, "file_path": file_path, "duration": duration, "snr": snr}


async def get_clips(dialect: str = None, limit: int = 200) -> list:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if dialect:
            async with db.execute(
                "SELECT * FROM clips WHERE dialect = ? ORDER BY created_at DESC LIMIT ?",
                (dialect, limit),
            ) as cur:
                rows = await cur.fetchall()
        else:
            async with db.execute(
                "SELECT * FROM clips ORDER BY created_at DESC LIMIT ?", (limit,)
            ) as cur:
                rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def get_clips_for_transcription(dialect: str = None) -> list:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        if dialect:
            async with db.execute(
                "SELECT * FROM clips WHERE status='processed' AND dialect = ? ORDER BY created_at ASC",
                (dialect,),
            ) as cur:
                rows = await cur.fetchall()
        else:
            async with db.execute(
                "SELECT * FROM clips WHERE status='processed' ORDER BY created_at ASC"
            ) as cur:
                rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def transcription_exists(clip_id: str) -> bool:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT 1 FROM transcriptions WHERE clip_id = ?", (clip_id,)
        ) as cur:
            row = await cur.fetchone()
    return row is not None


async def create_transcription(clip_id: str, text: str, confidence: float) -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO transcriptions (clip_id, text, confidence, updated_at) VALUES (?, ?, ?, ?)",
            (clip_id, text, confidence, datetime.utcnow().isoformat()),
        )
        await db.commit()
    return {"clip_id": clip_id, "text": text, "confidence": confidence}


async def update_transcription(
    clip_id: str,
    text: str,
    is_corrected: bool = True,
    corrected_by: str = "human",
):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "UPDATE transcriptions SET text=?, is_corrected=?, corrected_by=?, updated_at=? WHERE clip_id=?",
            (text, is_corrected, corrected_by, datetime.utcnow().isoformat(), clip_id),
        )
        await db.commit()


async def update_clip_status(clip_id: str, status: str):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute("UPDATE clips SET status=? WHERE id=?", (status, clip_id))
        await db.commit()


async def get_transcriptions(
    dialect: str = None,
    status: str = None,
    min_confidence: float = None,
    max_confidence: float = None,
    limit: int = 50,
    offset: int = 0,
) -> dict:
    conditions = ["c.status IN ('transcribed','corrected','rejected','approved')"]
    params: list = []

    if dialect:
        conditions.append("c.dialect = ?")
        params.append(dialect)
    if status and status != "all":
        if status == "corrected":
            conditions.append("c.status = 'corrected'")
        elif status == "rejected":
            conditions.append("c.status = 'rejected'")
        elif status == "needs_review":
            conditions.append("c.status = 'transcribed' AND t.is_corrected = 0")
        else:
            conditions.append("c.status = ?")
            params.append(status)
    if min_confidence is not None:
        conditions.append("t.confidence >= ?")
        params.append(min_confidence)
    if max_confidence is not None:
        conditions.append("t.confidence <= ?")
        params.append(max_confidence)

    where = " AND ".join(conditions)

    base_query = f"""
        SELECT c.id, c.dialect, c.file_path, c.duration, c.snr, c.status,
               t.text, t.confidence, t.is_corrected, t.corrected_by
        FROM clips c
        JOIN transcriptions t ON t.clip_id = c.id
        WHERE {where}
        ORDER BY t.confidence ASC
    """
    count_query = f"""
        SELECT COUNT(*)
        FROM clips c
        JOIN transcriptions t ON t.clip_id = c.id
        WHERE {where}
    """

    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(count_query, params) as cur:
            row = await cur.fetchone()
            total = row[0] if row else 0
        async with db.execute(base_query + " LIMIT ? OFFSET ?", params + [limit, offset]) as cur:
            rows = await cur.fetchall()

    return {"items": [dict(r) for r in rows], "total": total}


async def create_training_run(
    run_id: str,
    job_id: str,
    config: dict,
    total_epochs: int,
    training_type: str = "full",
) -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """INSERT INTO training_runs
               (id, job_id, config, total_epochs, training_type, status, created_at)
               VALUES (?, ?, ?, ?, ?, 'queued', ?)""",
            (run_id, job_id, json.dumps(config), total_epochs, training_type,
             datetime.utcnow().isoformat()),
        )
        await db.commit()
    return {"id": run_id, "job_id": job_id, "status": "queued"}


async def update_training_run(run_id: str, **kwargs):
    allowed = {
        "status", "current_epoch", "total_epochs", "current_step",
        "current_loss", "best_loss", "checkpoint_path",
    }
    fields = {k: v for k, v in kwargs.items() if k in allowed}
    if not fields:
        return
    set_clause = ", ".join(f"{k} = ?" for k in fields)
    values = list(fields.values()) + [run_id]
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(f"UPDATE training_runs SET {set_clause} WHERE id = ?", values)
        await db.commit()


async def get_training_run(run_id: str) -> Optional[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute("SELECT * FROM training_runs WHERE id = ?", (run_id,)) as cur:
            row = await cur.fetchone()
    if row is None:
        return None
    d = dict(row)
    if d.get("config"):
        try:
            d["config"] = json.loads(d["config"])
        except Exception:
            pass
    return d


async def get_training_runs(limit: int = 20) -> list:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT * FROM training_runs ORDER BY created_at DESC LIMIT ?", (limit,)
        ) as cur:
            rows = await cur.fetchall()
    result = []
    for row in rows:
        d = dict(row)
        if d.get("config"):
            try:
                d["config"] = json.loads(d["config"])
            except Exception:
                pass
        result.append(d)
    return result


async def add_loss_entry(
    run_id: str,
    step: int,
    epoch: int,
    train_loss: Optional[float] = None,
    eval_loss: Optional[float] = None,
):
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            "INSERT INTO loss_history (run_id, step, epoch, train_loss, eval_loss, recorded_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (run_id, step, epoch, train_loss, eval_loss, datetime.utcnow().isoformat()),
        )
        await db.commit()


async def get_loss_history(run_id: str) -> list:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT step, epoch, train_loss, eval_loss, recorded_at "
            "FROM loss_history WHERE run_id = ? ORDER BY step ASC",
            (run_id,),
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def get_clips_for_dataset(
    dialect: str = None,
    min_duration: float = 3.0,
    max_duration: float = 11.0,
) -> list:
    conditions = ["c.status IN ('transcribed', 'corrected')", "c.duration >= ?", "c.duration <= ?"]
    params: list = [min_duration, max_duration]
    if dialect:
        conditions.append("c.dialect = ?")
        params.append(dialect)
    where = " AND ".join(conditions)
    query = f"""
        SELECT c.id, c.dialect, c.speaker, c.file_path, c.duration, c.snr,
               t.text, t.confidence
        FROM clips c
        JOIN transcriptions t ON t.clip_id = c.id
        WHERE {where}
        ORDER BY c.snr DESC
    """
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(query, params) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def get_dataset_stats() -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            """
            SELECT c.dialect, c.speaker, COUNT(*) as clips, COALESCE(SUM(c.duration), 0) as secs
            FROM clips c
            JOIN transcriptions t ON t.clip_id = c.id
            WHERE c.status IN ('transcribed', 'corrected')
            GROUP BY c.dialect, c.speaker
            """
        ) as cur:
            rows = await cur.fetchall()

    by_dialect: dict = {}
    by_speaker: list = []
    total_clips = 0
    total_secs = 0.0

    for row in rows:
        dialect, speaker, clips, secs = row[0], row[1], row[2], row[3]
        total_clips += clips
        total_secs += secs

        if dialect not in by_dialect:
            by_dialect[dialect] = {"clips": 0, "hours": 0.0}
        by_dialect[dialect]["clips"] += clips
        by_dialect[dialect]["hours"] = round(
            by_dialect[dialect]["hours"] + secs / 3600, 3
        )

        by_speaker.append({
            "speaker": speaker or f"{dialect}_default",
            "dialect": dialect,
            "clips": clips,
            "hours": round(secs / 3600, 3),
        })

    return {
        "total_clips": total_clips,
        "total_hours": round(total_secs / 3600, 3),
        "by_dialect": by_dialect,
        "by_speaker": by_speaker,
    }


async def get_dataset_preview(limit: int = 10) -> list:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            """
            SELECT c.id, c.dialect, c.speaker, c.file_path, c.duration, c.snr, t.text
            FROM clips c
            JOIN transcriptions t ON t.clip_id = c.id
            WHERE c.status IN ('transcribed', 'corrected')
            ORDER BY RANDOM()
            LIMIT ?
            """,
            (limit,),
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def get_transcription_stats() -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            """
            SELECT c.dialect,
                   COUNT(*) as total,
                   AVG(t.confidence) as avg_confidence,
                   SUM(CASE WHEN c.status='transcribed' THEN 1 ELSE 0 END) as transcribed,
                   SUM(CASE WHEN c.status='corrected' THEN 1 ELSE 0 END) as corrected,
                   SUM(CASE WHEN c.status='rejected' THEN 1 ELSE 0 END) as rejected
            FROM clips c
            JOIN transcriptions t ON t.clip_id = c.id
            WHERE c.status IN ('transcribed', 'corrected', 'rejected')
            GROUP BY c.dialect
            """
        ) as cur:
            rows = await cur.fetchall()

    result = {}
    for row in rows:
        dialect = row[0]
        result[dialect] = {
            "total": row[1],
            "avg_confidence": round(row[2], 4) if row[2] else 0.0,
            "transcribed": row[3],
            "corrected": row[4],
            "rejected": row[5],
        }
    return result


async def get_process_stats() -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        async with db.execute(
            "SELECT dialect, COUNT(*) as count, COALESCE(SUM(duration), 0) as total_secs "
            "FROM clips WHERE status='processed' GROUP BY dialect",
        ) as cur:
            rows = await cur.fetchall()
    result = {}
    for row in rows:
        result[row[0]] = {"count": row[1], "hours": round(row[2] / 3600, 2)}
    return result


async def get_download_stats(dialect: str = None) -> dict:
    async with aiosqlite.connect(DB_PATH) as db:
        if dialect:
            async with db.execute(
                "SELECT dialect, COUNT(*) as count, COALESCE(SUM(duration_seconds), 0) as total_secs "
                "FROM downloaded_videos WHERE status='ok' AND dialect = ? GROUP BY dialect",
                (dialect,),
            ) as cur:
                rows = await cur.fetchall()
        else:
            async with db.execute(
                "SELECT dialect, COUNT(*) as count, COALESCE(SUM(duration_seconds), 0) as total_secs "
                "FROM downloaded_videos WHERE status='ok' GROUP BY dialect",
            ) as cur:
                rows = await cur.fetchall()
    result = {}
    for row in rows:
        result[row[0]] = {"count": row[1], "hours": round(row[2] / 3600, 2)}
    return result
