# Retry Transcription + Keyboard Shortcuts Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-clip retry button (with model selector) to the transcription review table, plus keyboard shortcuts for reviewers.

**Architecture:** Non-destructive retry — existing transcription is preserved until a new one succeeds. Worker overwrites on success; on failure, old data stays intact. Retry state is tracked in the parent `TranscribePanel` component and passed as props to `ReviewRow`. WebSocket delivers inline row updates.

**Tech Stack:** FastAPI + aiosqlite (backend), React + Tailwind (frontend), faster-whisper (transcription), WebSocket for real-time updates.

**Spec:** `docs/superpowers/specs/2026-03-15-retry-transcribe-keyboard-shortcuts-design.md`

---

## Chunk 1: Backend

### Task 1: Add DB helpers — `get_clip` + `get_clips_by_ids` + `upsert_transcription`

**Files:**
- Modify: `server/db.py`

- [ ] **Step 1: Add `get_clip` after `transcription_exists`**

Find `async def transcription_exists` in `server/db.py` and add below it:

```python
async def get_clip(clip_id: str) -> Optional[dict]:
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            "SELECT id, file_path, dialect, status FROM clips WHERE id = ?", (clip_id,)
        ) as cur:
            row = await cur.fetchone()
    return dict(row) if row else None


async def get_clips_by_ids(clip_ids: list[str]) -> list[dict]:
    """Fetch clips by explicit IDs with no status filter — used for retry jobs."""
    if not clip_ids:
        return []
    placeholders = ",".join("?" * len(clip_ids))
    async with aiosqlite.connect(DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        async with db.execute(
            f"SELECT id, file_path, dialect FROM clips WHERE id IN ({placeholders})",
            clip_ids,
        ) as cur:
            rows = await cur.fetchall()
    return [dict(r) for r in rows]


async def upsert_transcription(clip_id: str, text: str, confidence: float) -> None:
    """Create or overwrite a transcription, resetting corrected state."""
    async with aiosqlite.connect(DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO transcriptions (clip_id, text, confidence, is_corrected, corrected_by, updated_at)
            VALUES (?, ?, ?, 0, NULL, ?)
            ON CONFLICT(clip_id) DO UPDATE SET
                text       = excluded.text,
                confidence = excluded.confidence,
                is_corrected = 0,
                corrected_by = NULL,
                updated_at = excluded.updated_at
            """,
            (clip_id, text, confidence, datetime.utcnow().isoformat()),
        )
        await db.commit()
```

- [ ] **Step 2: Commit**

```bash
git add server/db.py
git commit -m "feat(db): add get_clip, get_clips_by_ids, upsert_transcription helpers"
```

---

### Task 2: Add `POST /transcribe/retry-clip` endpoint

**Files:**
- Modify: `server/routes/transcribe.py`

- [ ] **Step 1: Add imports and lock + model at top of file**

After the existing imports, add `import json` (if not present) and the lock set. Find `router = APIRouter(...)` line and add above it:

```python
import json
from uuid import uuid4

_retry_locks: set[str] = set()
```

Note: `uuid` is already imported as `import uuid` — change the job_id generation to use `str(uuid4())` or keep `uuid.uuid4().hex`. Just add `from uuid import uuid4` to the existing import or use `uuid.uuid4()`.

- [ ] **Step 2: Add `RetryClip` model after `BulkApprove`**

```python
class RetryClip(BaseModel):
    clip_id: str
    model: str = DEFAULT_WHISPER_MODEL
    min_confidence: float = DEFAULT_MIN_CONFIDENCE
```

- [ ] **Step 3: Add endpoint after `bulk_approve`**

```python
@router.post("/retry-clip")
async def retry_clip(body: RetryClip, background_tasks: BackgroundTasks):
    if body.clip_id in _retry_locks:
        raise HTTPException(409, detail="retry already in progress")

    _retry_locks.add(body.clip_id)
    try:
        clip = await db.get_clip(body.clip_id)
        if clip is None:
            raise HTTPException(404, detail="Clip not found")
        job_id = f"retry-{uuid.uuid4().hex[:12]}"
        config = {
            "model": body.model,
            "min_confidence": body.min_confidence,
            "clip_ids": [body.clip_id],
            "is_retry": True,
        }
        await db.create_job(job_id, job_type="transcribe", config=config)
        background_tasks.add_task(run_transcribe_job, job_id, None, config)
        return {"job_id": job_id}
    except Exception:
        _retry_locks.discard(body.clip_id)
        raise
```

- [ ] **Step 4: Commit**

```bash
git add server/routes/transcribe.py
git commit -m "feat(transcribe): add POST /retry-clip endpoint with lock guard"
```

---

### Task 3: Update worker to handle retry jobs

**Files:**
- Modify: `server/workers/transcribe_worker.py`

- [ ] **Step 1: Read `is_retry` and `clip_ids` from config at top of `run_transcribe_job`**

In `run_transcribe_job`, after reading `model_size` and `min_confidence` from config, add:

```python
clip_ids: list[str] | None = config.get("clip_ids")
is_retry: bool = config.get("is_retry", False)
```

- [ ] **Step 2: Replace clip-fetching logic with branching**

Replace:
```python
clips = await db.get_clips_for_transcription(dialect)
```

With:
```python
if is_retry and clip_ids:
    clips = await db.get_clips_by_ids(clip_ids)
else:
    clips = await db.get_clips_for_transcription(dialect)
```

- [ ] **Step 3: Handle empty clip list for retry (deleted clip edge case)**

After the existing "if not clips" block, it already handles empty — but for retry jobs we need to emit `transcribe_clip_done` with `failed: true`:

Replace the existing empty-clips block:
```python
if not clips:
    await db.update_job(job_id, status="completed", progress=1.0,
                        message="No processed clips found",
                        completed_at=datetime.utcnow().isoformat())
    await _broadcast_job_update(job_id, "completed", 1.0, "No processed clips found")
    return
```

With:
```python
if not clips:
    msg = "No clips found"
    await db.update_job(job_id, status="completed", progress=1.0, message=msg,
                        completed_at=datetime.utcnow().isoformat())
    await _broadcast_job_update(job_id, "completed", 1.0, msg)
    if is_retry and clip_ids:
        await _broadcast_clip_done(job_id, clip_ids[0], failed=True)
    return
```

- [ ] **Step 4: Skip `transcription_exists` check for retry; use upsert on success**

Inside the per-clip loop, the existing code is:
```python
if await db.transcription_exists(clip_id):
    ...
    continue
```

Wrap this skip in a condition:
```python
if not is_retry and await db.transcription_exists(clip_id):
    ...
    continue
```

Then replace the success path:
```python
await db.create_transcription(clip_id, text, confidence)
await db.update_clip_status(clip_id, "transcribed")
```

With:
```python
if is_retry:
    await db.upsert_transcription(clip_id, text, confidence)
else:
    await db.create_transcription(clip_id, text, confidence)
await db.update_clip_status(clip_id, "transcribed")
```

- [ ] **Step 5: Emit `transcribe_clip_done` on retry completion (success and failure)**

After result processing inside the loop, add:
```python
if is_retry:
    if result is not None:
        await _broadcast_clip_done(job_id, clip_id, text=text,
                                   confidence=confidence, status="transcribed")
    else:
        await _broadcast_clip_done(job_id, clip_id, failed=True)
```

- [ ] **Step 6: Add `_broadcast_clip_done` helper and update `finally` block**

Add helper function:
```python
async def _broadcast_clip_done(job_id: str, clip_id: str, *,
                               failed: bool = False, text: str = "",
                               confidence: float = 0.0, status: str = ""):
    payload = {"type": "transcribe_clip_done", "job_id": job_id, "clip_id": clip_id}
    if failed:
        payload["failed"] = True
    else:
        payload.update({"text": text, "confidence": confidence, "status": status})
    await ws_manager.broadcast(payload)
```

Update `finally` block at bottom of `run_transcribe_job`:
```python
finally:
    _cancel_flags.pop(job_id, None)
    if is_retry and clip_ids:
        retry_clip_id = clip_ids[0]
        from server.routes.transcribe import _retry_locks
        _retry_locks.discard(retry_clip_id)
```

- [ ] **Step 7: Commit**

```bash
git add server/workers/transcribe_worker.py
git commit -m "feat(worker): support retry jobs — upsert, skip exists-check, emit transcribe_clip_done"
```

---

## Chunk 2: Frontend

### Task 4: Add retry state + WS handler to `TranscribePanel`

**Files:**
- Modify: `ui/src/components/TranscribePanel.jsx`

- [ ] **Step 1: Add retry state variables to `TranscribePanel`**

After the existing state declarations (`savedCount`, etc.), add:

```js
// Retry state — Map<clip_id, {jobId, timeoutId}>
const retryingClipsRef = useRef(new Map())
const [retryingSet, setRetryingSet] = useState(new Set())
// Map<clip_id, 'success'|'failed'> — transient, clears after flash
const [retryFlashes, setRetryFlashes] = useState({})
// Unhandled WS events that arrived before POST response
const unhandledRetryEventsRef = useRef([])
```

- [ ] **Step 2: Add `addRetrying` / `removeRetrying` helpers inside `TranscribePanel`**

These go inside the component body, before `loadJobs`:

```js
const addRetrying = (clipId, jobId) => {
  const timeoutId = setTimeout(() => removeRetrying(clipId, true), 5 * 60 * 1000)
  retryingClipsRef.current.set(clipId, { jobId, timeoutId })
  setRetryingSet(prev => new Set([...prev, clipId]))
  // Drain any buffered WS events for this job_id
  const buffered = unhandledRetryEventsRef.current.filter(e => e.job_id === jobId)
  unhandledRetryEventsRef.current = unhandledRetryEventsRef.current.filter(e => e.job_id !== jobId)
  buffered.forEach(handleClipDoneEvent)
}

const removeRetrying = (clipId, timedOut = false) => {
  const entry = retryingClipsRef.current.get(clipId)
  if (!entry) return
  clearTimeout(entry.timeoutId)
  retryingClipsRef.current.delete(clipId)
  setRetryingSet(prev => { const s = new Set(prev); s.delete(clipId); return s })
  if (timedOut) triggerRetryFlash(clipId, 'failed')
}

const triggerRetryFlash = (clipId, type) => {
  setRetryFlashes(prev => ({ ...prev, [clipId]: type }))
  setTimeout(() => setRetryFlashes(prev => {
    const next = { ...prev }
    delete next[clipId]
    return next
  }), 1200)
}

const handleClipDoneEvent = (msg) => {
  const clipId = [...retryingClipsRef.current.entries()]
    .find(([, v]) => v.jobId === msg.job_id)?.[0]
  if (!clipId) return
  removeRetrying(clipId)
  if (!msg.failed) {
    triggerRetryFlash(clipId, 'success')
    setReviewItems(prev => prev.map(item =>
      item.id === clipId
        ? { ...item, text: msg.text, confidence: msg.confidence, status: msg.status }
        : item
    ))
  } else {
    triggerRetryFlash(clipId, 'failed')
  }
}
```

**Note:** `addRetrying` calls `handleClipDoneEvent` which is defined after it. In JavaScript this is fine because they're all function declarations in the same scope — but since they're `const`, declare `handleClipDoneEvent` first (before `addRetrying`).

- [ ] **Step 3: Handle `transcribe_clip_done` in WS `onmessage`**

Inside the existing `ws.onmessage` handler, add a branch after the `transcribe_log` branch:

```js
} else if (msg.type === 'transcribe_clip_done') {
  const isKnown = [...retryingClipsRef.current.values()].some(v => v.jobId === msg.job_id)
  if (isKnown) {
    handleClipDoneEvent(msg)
  } else {
    unhandledRetryEventsRef.current.push(msg)
  }
}
```

- [ ] **Step 4: Rebuild `retryingSet` on mount from active retry jobs**

In the existing `loadJobs` function (or in `useEffect` after `loadJobs()`), add:

```js
const loadJobs = async () => {
  try {
    const r = await api.get('/transcribe/jobs')
    setJobs(r.data.jobs)
    // Rebuild retrying state for any in-flight retry jobs
    ;(r.data.jobs || []).forEach(job => {
      if (['running', 'queued'].includes(job.status)) {
        const cfg = typeof job.config === 'string' ? JSON.parse(job.config) : job.config
        if (cfg?.is_retry && cfg?.clip_ids?.length === 1) {
          addRetrying(cfg.clip_ids[0], job.id)
        }
      }
    })
  } catch (e) {}
}
```

- [ ] **Step 5: Add `handleRetry` callback passed down to `ReviewRow`**

```js
const handleRetry = async (clipId, model) => {
  try {
    const r = await api.post('/transcribe/retry-clip', { clip_id: clipId, model })
    addRetrying(clipId, r.data.job_id)
    // Add new job to jobs panel
    const newJob = { id: r.data.job_id, status: 'queued', progress: 0, message: 'Queued (retry)' }
    setJobs(prev => [newJob, ...prev])
    return { ok: true }
  } catch (e) {
    const status = e.response?.status
    if (status === 409) return { error: 'Already retrying' }
    return { error: 'Server error' }
  }
}
```

- [ ] **Step 6: Pass new props to `ReviewRow` in the table render**

Change:
```jsx
<ReviewRow
  key={item.id}
  item={item}
  onApprove={handleApprove}
  onReject={handleReject}
  onCorrect={handleCorrect}
/>
```

To:
```jsx
<ReviewRow
  key={item.id}
  item={item}
  onApprove={handleApprove}
  onReject={handleReject}
  onCorrect={handleCorrect}
  onRetry={handleRetry}
  isRetrying={retryingSet.has(item.id)}
  retryFlash={retryFlashes[item.id]}
/>
```

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/TranscribePanel.jsx
git commit -m "feat(transcribe): add retry state management and WS handler to TranscribePanel"
```

---

### Task 5: Add retry popover + retrying state to `ReviewRow`

**Files:**
- Modify: `ui/src/components/TranscribePanel.jsx`

- [ ] **Step 1: Update `ReviewRow` signature to accept new props**

Change:
```js
function ReviewRow({ item, onApprove, onReject, onCorrect }) {
```

To:
```js
function ReviewRow({ item, onApprove, onReject, onCorrect, onRetry, isRetrying, retryFlash }) {
```

- [ ] **Step 2: Add retry popover state to `ReviewRow`**

After existing state declarations, add:
```js
const [showRetryPopover, setShowRetryPopover] = useState(false)
const [retryModel, setRetryModel] = useState('large-v3')
const [retryError, setRetryError] = useState(null)
const [retryPending, setRetryPending] = useState(false)
```

- [ ] **Step 3: Flash on `retryFlash` prop change**

Add a `useEffect` inside `ReviewRow`:
```js
useEffect(() => {
  if (retryFlash === 'success') triggerFlash('approved')
  else if (retryFlash === 'failed') triggerFlash('rejected')
}, [retryFlash])
```

- [ ] **Step 4: Add `handleRetrySubmit`**

```js
const handleRetrySubmit = async () => {
  setRetryPending(true)
  setRetryError(null)
  const result = await onRetry(item.id, retryModel)
  setRetryPending(false)
  if (result.ok) {
    setShowRetryPopover(false)
  } else {
    setRetryError(result.error)
  }
}
```

- [ ] **Step 5: Update `flashCls` to handle retrying row styling**

The existing row `className` uses `flashCls`. The row should also pulse when `isRetrying`. Update the `<tr>` className:

```jsx
<tr className={`border-b border-zinc-700 transition-colors duration-300 ${
  flashCls || (isRetrying ? 'bg-zinc-800/30' : 'hover:bg-zinc-800/50')
}`}>
```

- [ ] **Step 6: Update text cell to pulse when retrying**

The text cell (`<td>` containing the text/input) should show pulse when retrying. Wrap the existing text content:

```jsx
<td className={`px-3 py-2 max-w-xs ${isRetrying ? 'opacity-50 animate-pulse' : ''}`}>
```

- [ ] **Step 7: Replace action buttons with spinner when retrying; add ↺ button**

The actions `<td>` currently renders two states: editing (Save/Cancel) and not-editing (✓/✏/✗).

When `isRetrying`, show a spinner instead of all buttons. When not retrying, add the ↺ button between ✏ and ✗:

```jsx
<td className="px-3 py-2">
  {isRetrying ? (
    <div className="flex items-center gap-1 text-zinc-400 text-xs">
      <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
      </svg>
      <span>Retrying…</span>
    </div>
  ) : editing ? (
    <div className="flex gap-1">
      <button onClick={handleSave} disabled={!!pending} title="Save correction"
        className="text-xs px-2 py-1 bg-emerald-900/40 hover:bg-emerald-700/50 text-emerald-400 rounded transition-colors disabled:opacity-50">
        {pending === 'correcting' ? '…' : 'Save'}
      </button>
      <button onClick={() => { setEditing(false); setEditText(item.text || '') }} title="Cancel"
        className="text-xs px-2 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-400 rounded transition-colors">
        Cancel
      </button>
    </div>
  ) : (
    <div className="flex gap-1 relative">
      <button onClick={handleApproveClick} disabled={!!pending} title="Approve"
        className="text-xs px-2 py-1 bg-emerald-900/40 hover:bg-emerald-700/50 text-emerald-400 rounded transition-colors disabled:opacity-50 min-w-[28px]">
        {pending === 'approving' ? '…' : '✓'}
      </button>
      <button onClick={() => { setEditing(true); setShowRetryPopover(false) }}
        disabled={!!pending} title="Edit text"
        className="text-xs px-2 py-1 bg-blue-900/40 hover:bg-blue-700/50 text-blue-400 rounded transition-colors disabled:opacity-50">
        ✏
      </button>
      <button
        onClick={() => { setShowRetryPopover(p => !p); setEditing(false); setRetryError(null) }}
        disabled={!!pending}
        title="Retry transcription"
        className={`text-xs px-2 py-1 rounded transition-colors disabled:opacity-50 ${
          showRetryPopover ? 'bg-amber-700/50 text-amber-300' : 'bg-zinc-700 hover:bg-zinc-600 text-zinc-300'
        }`}>
        ↺
      </button>
      <button onClick={handleRejectClick} disabled={!!pending} title="Reject"
        className="text-xs px-2 py-1 bg-red-900/40 hover:bg-red-700/50 text-red-400 rounded transition-colors disabled:opacity-50 min-w-[28px]">
        {pending === 'rejecting' ? '…' : '✗'}
      </button>

      {/* Retry popover */}
      {showRetryPopover && (
        <div className="absolute right-0 top-8 z-10 bg-zinc-800 border border-zinc-600 rounded-lg shadow-xl p-3 w-48">
          <p className="text-xs font-medium text-zinc-300 mb-2">Retry with model:</p>
          <select
            value={retryModel}
            onChange={e => setRetryModel(e.target.value)}
            className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-100 mb-2 focus:outline-none focus:border-emerald-500"
          >
            <option value="large-v3">large-v3</option>
            <option value="medium">medium</option>
            <option value="small">small</option>
          </select>
          {retryError && (
            <p className="text-xs text-red-400 mb-2">{retryError}</p>
          )}
          <div className="flex gap-1">
            <button
              onClick={handleRetrySubmit}
              disabled={retryPending}
              className="flex-1 text-xs px-2 py-1 bg-amber-700/50 hover:bg-amber-600/60 text-amber-200 rounded transition-colors disabled:opacity-50"
            >
              {retryPending ? '…' : 'Retry'}
            </button>
            <button
              onClick={() => setShowRetryPopover(false)}
              className="text-xs px-2 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-400 rounded transition-colors"
            >
              ✕
            </button>
          </div>
        </div>
      )}
    </div>
  )}
</td>
```

- [ ] **Step 8: Commit**

```bash
git add ui/src/components/TranscribePanel.jsx
git commit -m "feat(transcribe): add retry popover and retrying state to ReviewRow"
```

---

### Task 6: Add keyboard shortcuts + hint strip

**Files:**
- Modify: `ui/src/components/TranscribePanel.jsx`

- [ ] **Step 1: Add `focusedClipId` state and audio refs map**

In `TranscribePanel`, add:
```js
const [focusedClipId, setFocusedClipId] = useState(null)
const audioRefsMap = useRef({})  // Map<clip_id, HTMLAudioElement>
```

- [ ] **Step 2: Pass `focused`, `onFocus`, and `audioRef` callback to `ReviewRow`**

```jsx
<ReviewRow
  key={item.id}
  item={item}
  onApprove={handleApprove}
  onReject={handleReject}
  onCorrect={handleCorrect}
  onRetry={handleRetry}
  isRetrying={retryingSet.has(item.id)}
  retryFlash={retryFlashes[item.id]}
  focused={focusedClipId === item.id}
  onFocus={() => setFocusedClipId(item.id)}
  registerAudio={(el) => { if (el) audioRefsMap.current[item.id] = el; else delete audioRefsMap.current[item.id] }}
/>
```

- [ ] **Step 3: Update `ReviewRow` to use `focused`, `onFocus`, `registerAudio`**

Add props to signature:
```js
function ReviewRow({ item, onApprove, onReject, onCorrect, onRetry,
                     isRetrying, retryFlash, focused, onFocus, registerAudio }) {
```

Update audio element (merging with the existing `audioRef` / loop button added earlier):
```jsx
<audio
  ref={el => { audioRef.current = el; registerAudio?.(el) }}
  controls src={audioUrl} className="h-7 w-36" preload="none" loop={looping}
/>
```

Update `<tr>` to handle focus click and styling:
```jsx
<tr
  onClick={onFocus}
  className={`border-b border-zinc-700 transition-colors duration-300 cursor-pointer ${
    flashCls ? flashCls
    : focused ? 'border-l-2 border-emerald-500 bg-zinc-800/80'
    : isRetrying ? 'bg-zinc-800/30'
    : 'hover:bg-zinc-800/50'
  }`}
>
```

- [ ] **Step 4: Add keyboard shortcut `useEffect` in `TranscribePanel`**

Add this effect (after the WS effect):
```js
useEffect(() => {
  const onKeyDown = (e) => {
    const tag = document.activeElement?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

    const ids = reviewItems.map(i => i.id)
    const idx = focusedClipId ? ids.indexOf(focusedClipId) : -1

    if (e.key === 'j' || e.key === 'ArrowDown') {
      e.preventDefault()
      setFocusedClipId(ids[Math.min(idx + 1, ids.length - 1)] ?? ids[0])
    } else if (e.key === 'k' || e.key === 'ArrowUp') {
      e.preventDefault()
      setFocusedClipId(ids[Math.max(idx - 1, 0)] ?? ids[0])
    } else if (e.key === ' ') {
      e.preventDefault()
      if (focusedClipId) {
        const audio = audioRefsMap.current[focusedClipId]
        if (audio) audio.paused ? audio.play() : audio.pause()
      }
    } else if (e.key === 'a' && focusedClipId) {
      const item = reviewItems.find(i => i.id === focusedClipId)
      if (item && !retryingSet.has(focusedClipId)) handleApprove(focusedClipId)
    } else if (e.key === 'r' && focusedClipId) {
      if (!retryingSet.has(focusedClipId)) handleReject(focusedClipId)
    }
    // 'e' and Escape are handled inside ReviewRow itself
  }
  document.addEventListener('keydown', onKeyDown)
  return () => document.removeEventListener('keydown', onKeyDown)
}, [reviewItems, focusedClipId, retryingSet])
```

Note: `e` (edit) and `Escape` are handled locally within `ReviewRow` via the existing `handleKeyDown` on the input. For `e` to trigger edit mode from outside, we'd need an imperative ref — keep it simple: `j/k/Space/a/r` are global; `e` and `Escape` only work when the row's input is focused.

- [ ] **Step 5: Add dismissible hint strip below the review table**

Add state:
```js
const [shortcutsHidden, setShortcutsHidden] = useState(
  () => localStorage.getItem('darija-tts:transcribe_shortcuts_dismissed') === '1'
)
```

Add the strip just before the closing `</div>` of the review section (after pagination):
```jsx
{!shortcutsHidden && (
  <div className="mt-2 flex items-center justify-between px-3 py-1.5 bg-zinc-800/60 border border-zinc-700 rounded text-xs text-zinc-500">
    <span>j/k navigate · Space play · a approve · r reject</span>
    <button
      onClick={() => {
        setShortcutsHidden(true)
        localStorage.setItem('darija-tts:transcribe_shortcuts_dismissed', '1')
      }}
      className="ml-3 text-zinc-600 hover:text-zinc-400 transition-colors"
    >
      ✕
    </button>
  </div>
)}
```

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/TranscribePanel.jsx
git commit -m "feat(transcribe): keyboard shortcuts j/k/Space/a/r and hint strip"
```

---

## Chunk 3: Deploy

### Task 7: Push and redeploy

- [ ] **Step 1: Push**

```bash
git push origin main
```

- [ ] **Step 2: Deploy on server**

```bash
ssh -i ~/Downloads/boujaha.pem -o StrictHostKeyChecking=no boujaha@20.19.125.213 \
  'cd /home/boujaha/tts && git pull && docker compose build frontend backend && docker compose up -d frontend backend'
```

- [ ] **Step 3: Verify in browser**

Open `https://fm.cosumar.app/transcribe`, load the review table, confirm:
1. ↺ button appears in Actions column
2. Clicking ↺ shows popover with model selector
3. Row shows spinner + pulse animation while retrying
4. Keyboard `j/k` moves focus between rows
5. `Space` plays audio on focused row
6. `a` approves, `r` rejects focused row
7. Hint strip appears below table and can be dismissed
