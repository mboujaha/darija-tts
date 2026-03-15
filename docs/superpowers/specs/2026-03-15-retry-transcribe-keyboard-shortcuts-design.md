# Design: Retry Transcription + Keyboard Shortcuts for Reviewers

**Date:** 2026-03-15
**Status:** Approved

---

## Overview

1. **Per-clip retry** — ↺ button on each review row, re-transcribes with a chosen Whisper model, updates the row inline via WebSocket
2. **Keyboard shortcuts** — `j/k` navigation, `Space` playback, `a/r/e` actions on the focused row

---

## Files to Modify

- `server/routes/transcribe.py`
- `server/workers/transcribe_worker.py`
- `server/db.py`
- `ui/src/components/TranscribePanel.jsx`

---

## Backend

### Core design decision: non-destructive retry

The endpoint does **not** reset the clip's status or delete its existing transcription. The worker overwrites the transcription unconditionally when `is_retry` is set. On worker failure the old transcription and old status are preserved — the clip stays visible in the review table unchanged.

### New endpoint: `POST /transcribe/retry-clip`

No auth guard — the app has no auth layer.

**Pydantic model:**
```python
class RetryClip(BaseModel):
    clip_id: str
    model: str = DEFAULT_WHISPER_MODEL
    # min_confidence intentionally not exposed in the popover
    min_confidence: float = DEFAULT_MIN_CONFIDENCE
```

**Module-level lock:**
```python
_retry_locks: set[str] = set()   # module-level in transcribe.py
```

**Endpoint:**
```python
@router.post("/retry-clip")
async def retry_clip(body: RetryClip, background_tasks: BackgroundTasks):
    if body.clip_id in _retry_locks:
        raise HTTPException(409, "retry already in progress")

    _retry_locks.add(body.clip_id)
    try:
        clip = await db.get_clip(body.clip_id)  # raises 404 if not found
        job_id = str(uuid4())
        config = {
            "model": body.model,
            "min_confidence": body.min_confidence,
            "clip_ids": [body.clip_id],
            "is_retry": True,
        }
        await db.create_job(job_id, job_type="transcribe", config=json.dumps(config))
        background_tasks.add_task(run_transcribe_job, job_id, None, config)
        return {"job_id": job_id}
    except Exception:
        # Release lock for ANY failure including add_task or create_job errors.
        # Worker also calls discard in its finally — discard is idempotent.
        _retry_locks.discard(body.clip_id)
        raise
```

The `try/except` wraps all steps including `add_task`, so no failure path leaks the lock. The worker's `finally` also discards (idempotent) to handle the normal completion path.

**Known limitation:** `_retry_locks` is process-local — cleared on server restart. Acceptable for single-process deployment.

**Error responses:** `404` clip not found · `409` already retrying · `422` invalid input · `500` server error

### New DB helper (`server/db.py`)

```python
async def get_clips_by_ids(clip_ids: list[str]) -> list[dict]:
    # SELECT id, file_path, dialect FROM clips WHERE id IN (?, ...)
    # No status filter — retry jobs bypass the status check entirely
```

Also add an upsert helper:
```python
async def upsert_transcription(clip_id: str, text: str, confidence: float) -> None:
    # INSERT INTO transcriptions (clip_id, text, confidence, updated_at)
    # VALUES (?, ?, ?, ?) ON CONFLICT(clip_id) DO UPDATE SET
    #   text=excluded.text, confidence=excluded.confidence,
    #   updated_at=excluded.updated_at, is_corrected=0, corrected_by=NULL
```

### Worker changes (`transcribe_worker.py`)

Read `clip_ids` and `is_retry` from config:
```python
clip_ids: list[str] | None = config.get("clip_ids")
is_retry: bool = config.get("is_retry", False)
```

When `is_retry` is True:
- Use `db.get_clips_by_ids(clip_ids)` (no status filter).
- **Skip** the `transcription_exists` check — always process the clip.
- **On success:** call `db.upsert_transcription(clip_id, text, confidence)` and `db.update_clip_status(clip_id, "transcribed")`.
- **If clip list is empty** (edge case: clip deleted between job creation and execution): emit `transcribe_clip_done` with `failed: true` immediately, then complete the job normally.
- **On failure** (result is None): do **not** change the clip's status or transcription. Old transcription is preserved. Emit `transcribe_clip_done` with `failed: true`.

**`transcribe_clip_done` event** — emitted **only** when `is_retry is True`. Non-retry jobs never emit this event type, so the frontend ignores any `transcribe_clip_done` whose `job_id` is not in `retryingClipsRef`.

Success:
```json
{
  "type": "transcribe_clip_done",
  "job_id": "...",
  "clip_id": "...",
  "text": "...",
  "confidence": 0.82,
  "status": "transcribed"
}
```

Failure:
```json
{
  "type": "transcribe_clip_done",
  "job_id": "...",
  "clip_id": "...",
  "failed": true
}
```

**`finally` block addition:**
```python
finally:
    _cancel_flags.pop(job_id, None)
    if is_retry:
        # Guard against empty list (edge case where clip was deleted before worker ran)
        retry_clip_id = clip_ids[0] if clip_ids else None
        if retry_clip_id:
            from server.routes.transcribe import _retry_locks
            _retry_locks.discard(retry_clip_id)
```

`discard` is idempotent — safe to call even if the endpoint's `except` already removed the entry.

---

## Frontend

### Retry popover

- ↺ button added to the Actions column (after ✎, before ✗).
- Clicking opens a small popover. Opening the popover is mutually exclusive with edit mode — if the row is in edit mode, the edit is cancelled.
- Popover: model `<select>` (`large-v3` / `medium` / `small`, default `large-v3`) + "Retry" button.
- On "Retry": `POST /transcribe/retry-clip { clip_id, model }`.
  - **2xx:** close popover, call `addRetrying(clip_id, jobId)`, row enters retrying state.
  - **409:** show `"Already retrying"` inline, keep popover open.
  - **other error:** show `"Server error"` inline, keep popover open.

### `retryingClips` state

```js
const retryingClipsRef = useRef(new Map()) // Map<clip_id, { jobId, timeoutId }>
const [retryingSet, setRetryingSet] = useState(new Set())  // for re-renders

function addRetrying(clip_id, jobId) {
  const timeoutId = setTimeout(() => removeRetrying(clip_id, true), 5 * 60 * 1000)
  retryingClipsRef.current.set(clip_id, { jobId, timeoutId })
  setRetryingSet(prev => new Set([...prev, clip_id]))
  // Drain any buffered WS events for this job_id
  const buffered = unhandledRetryEventsRef.current.filter(e => e.job_id === jobId)
  unhandledRetryEventsRef.current = unhandledRetryEventsRef.current.filter(e => e.job_id !== jobId)
  buffered.forEach(handleClipDoneEvent)
}

function removeRetrying(clip_id, timedOut = false) {
  const entry = retryingClipsRef.current.get(clip_id)
  if (!entry) return
  clearTimeout(entry.timeoutId)
  retryingClipsRef.current.delete(clip_id)
  setRetryingSet(prev => { const s = new Set(prev); s.delete(clip_id); return s })
  if (timedOut) {
    // Treat as failed: flash red, row reverts to old data display (no row removal).
    // The job may still be running on the server — the reviewer can refresh to check.
    flashRow(clip_id, 'red')
  }
}
```

**On mount / WS reconnect:** call `GET /transcribe/jobs`. For each job where `status` is `'running'` or `'queued'` and `JSON.parse(job.config).is_retry === true`, call `addRetrying(clip_ids[0], job.id)`. The `is_retry` flag distinguishes retry jobs from any bulk job that happens to target a single clip.

### Race condition guard

```js
// Flat array of raw WS event objects. Keyed on event.job_id when draining.
const unhandledRetryEventsRef = useRef([])  // Array<{type, job_id, clip_id, ...}>
```

When `transcribe_clip_done` arrives:
1. Check if any entry in `retryingClipsRef.current` has `.jobId === msg.job_id`.
2. **Yes** → call `handleClipDoneEvent(msg)` immediately.
3. **No** → push `msg` to `unhandledRetryEventsRef`.

Draining (inside `addRetrying`, after registering the new job_id):
```js
// Only drain events matching THIS job_id — never drain the whole buffer
const buffered = unhandledRetryEventsRef.current.filter(e => e.job_id === jobId)
unhandledRetryEventsRef.current = unhandledRetryEventsRef.current.filter(e => e.job_id !== jobId)
buffered.forEach(handleClipDoneEvent)
```

Events for other job_ids remain buffered until their corresponding `addRetrying` call.

### `handleClipDoneEvent(msg)`

```js
function handleClipDoneEvent(msg) {
  // Find clip_id from retryingClipsRef by jobId
  const clip_id = [...retryingClipsRef.current.entries()]
    .find(([, v]) => v.jobId === msg.job_id)?.[0]
  if (!clip_id) return

  removeRetrying(clip_id)

  if (!msg.failed) {
    // Success: update row in place
    flashRow(clip_id, 'green')
    setReviewItems(prev => prev.map(item =>
      item.clip_id === clip_id
        ? { ...item, text: msg.text, confidence: msg.confidence, status: msg.status }
        : item
    ))
  } else {
    // Failure: flash red, show transient badge — old data preserved in row
    flashRow(clip_id, 'red')
    setRetryFailedClips(prev => new Set([...prev, clip_id]))
    setTimeout(() => {
      setRetryFailedClips(prev => { const s = new Set(prev); s.delete(clip_id); return s })
    }, 3000)
    // Row stays in reviewItems with old transcription and old status intact
  }
}
```

### Row retrying state (while in `retryingSet`)

- Action buttons replaced with a spinner.
- Text cell: `opacity-50 animate-pulse`.
- Audio player remains functional.

### Keyboard shortcuts

`keydown` listener on `document`, registered/cleaned in `useEffect`. Active when `document.activeElement` is not `INPUT`, `TEXTAREA`, or `SELECT`.

Focus key: `focusedClipId: string | null` (clip ID, not array index — survives row reorders and inline updates).

| Key | Action |
|-----|--------|
| `j` / `↓` | Focus next clip in `reviewItems` |
| `k` / `↑` | Focus previous clip |
| `Space` | Play or pause audio for focused row |
| `a` | Approve focused clip (same handler as ✓ click) |
| `r` | Reject focused clip (same handler as ✗ click) |
| `e` | Focus `<textarea>` in focused row; close retry popover if open; silently no-op if row is retrying |
| `Escape` | Close retry popover if open; else cancel edit mode. (The two states are mutually exclusive so at most one fires per keypress.) |

Focused row: `border-l-2 border-emerald-500 bg-zinc-800/80`. Clicking any row sets `focusedClipId`.

**Hint strip** below the table:
```
j/k navigate · Space play · a approve · r reject · e edit    [×]
```
Dismiss via ✕. Persisted in `localStorage` key `darija-tts:transcribe_shortcuts_dismissed`.

---

## Data Flow

```
Reviewer clicks ↺
  → popover opens (edit mode cancelled if active)
  → selects model, clicks Retry
  → POST /transcribe/retry-clip {clip_id, model}
      → 409: inline error, popover stays open
      → pre-task exception: lock released in except, error shown
      → 2xx: {job_id}
          → addRetrying(clip_id, jobId) + 5-min timeout
          → drain unhandledRetryEventsRef for this job_id
          → row: spinner + pulse; job visible in jobs panel
  → worker processes clip (no status filter, no transcription_exists check)
      → success: upsert transcription, set status=transcribed
               → broadcast transcribe_clip_done {job_id, clip_id, text, confidence, status}
      → failure: old data preserved unchanged
               → broadcast transcribe_clip_done {job_id, clip_id, failed:true}
      → finally: _retry_locks.discard(clip_id)
  → WS handler
      → job_id unknown: buffer in unhandledRetryEventsRef (matched by job_id only)
      → job_id known (handleClipDoneEvent):
          → success: removeRetrying, flash green, update row in place
          → failure: removeRetrying, flash red, "Retry failed" badge 3s, row stays with old data
  → 5-min timeout (no WS event): flash red, clear retrying state, row stays with old data
```

---

## Non-Goals

- Batch retry — deferred
- Storing which model produced each transcription — deferred
- Per-session WebSocket channels — deferred
- `min_confidence` control in retry popover — deferred
- DB-backed lock for multi-process deployments — deferred
