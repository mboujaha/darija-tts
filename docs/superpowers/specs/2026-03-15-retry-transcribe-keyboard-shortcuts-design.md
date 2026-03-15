# Design: Retry Transcription + Keyboard Shortcuts for Reviewers

**Date:** 2026-03-15
**Status:** Approved

---

## Overview

Two features to make the transcription review workflow faster:

1. **Per-clip retry** — a ↺ button on each review row that re-transcribes a clip with a chosen Whisper model, showing the result inline without losing the reviewer's place
2. **Keyboard shortcuts** — `j/k` navigation, `Space` audio, `a/r/e` actions on the focused row

---

## Files to Modify

- `server/routes/transcribe.py` — new `/retry-clip` endpoint
- `server/workers/transcribe_worker.py` — support single-clip scoped job + emit `transcribe_clip_done` event
- `ui/src/components/TranscribePanel.jsx` — retry popover, row retrying state, WS handler, keyboard shortcuts

---

## Backend

### New endpoint: `POST /transcribe/retry-clip`

**Request body:**
```json
{ "clip_id": "string", "model": "large-v3|medium|small", "min_confidence": 0.6 }
```

**Steps:**
1. Reset `clips.status = 'processed'` for the clip
2. Delete existing row from `transcriptions` table (so worker treats it as fresh)
3. Start a transcription job scoped to that single `clip_id` via `transcribe_worker`
4. Return `{ "job_id": "..." }`

**Pydantic model:**
```python
class RetryClip(BaseModel):
    clip_id: str
    model: str = DEFAULT_WHISPER_MODEL
    min_confidence: float = DEFAULT_MIN_CONFIDENCE
```

### Worker changes

The existing `run_transcribe_job` accepts an optional `clip_ids: list[str] | None` filter. When provided, it processes only those clips instead of all unprocessed clips for the dialect.

**New WebSocket event emitted on job completion (single-clip job):**

Success:
```json
{
  "type": "transcribe_clip_done",
  "clip_id": "...",
  "text": "...",
  "confidence": 0.82,
  "status": "transcribed"
}
```

Failure (confidence below threshold or validation rejected):
```json
{
  "type": "transcribe_clip_done",
  "clip_id": "...",
  "failed": true
}
```

This event is only emitted for single-clip retry jobs (when `clip_ids` has exactly one entry).

---

## Frontend

### Retry popover

- New ↺ button added to the Actions column (between ✎ and ✗)
- Clicking opens a small popover anchored to the row containing:
  - Model `<select>` defaulting to `large-v3`
  - "Retry" confirm button
- On submit: `POST /transcribe/retry-clip`, popover closes

### Row retrying state

While a retry job is in progress for a clip:
- Action buttons replaced with a spinner
- Text cell shows a subtle pulse/opacity animation
- Audio player remains functional
- Job appears in the jobs panel at the top as normal

### Inline update on completion

The existing WebSocket listener is extended to handle `transcribe_clip_done`:

- **Success:** row flashes green (reusing existing flash mechanism), text + confidence + status update in place, action buttons return
- **Failure:** row flashes red, status badge shows "retry failed", action buttons return so reviewer can try a different model

State: `retryingClips: Set<clip_id>` tracks which clips are currently being retried.

### Keyboard shortcuts

Active whenever the review table is rendered and no `<input>` or `<textarea>` is focused.

| Key | Action |
|-----|--------|
| `j` or `↓` | Move focus to next row |
| `k` or `↑` | Move focus to previous row |
| `Space` | Play/pause audio on focused row |
| `a` | Approve focused row |
| `r` | Reject focused row |
| `e` | Enter edit mode on focused row |
| `Escape` | Cancel edit / close retry popover |

**Focused row styling:** subtle left border highlight (`border-l-2 border-emerald-500`) and slightly lighter background.

**Hint strip:** a single line below the table showing the key bindings. Dismissible with an ✕ button. Dismissed state persisted in `localStorage` under key `transcribe_shortcuts_dismissed`.

---

## Data Flow

```
Reviewer clicks ↺
  → popover opens, selects model
  → POST /transcribe/retry-clip {clip_id, model}
  → backend resets clip, starts single-clip job → returns {job_id}
  → row enters retrying state, job visible in jobs panel
  → worker processes clip, broadcasts transcribe_clip_done {clip_id, ...}
  → WS listener receives event
      → success: flash green, update row in place
      → failure: flash red, show retry-failed badge
```

---

## Non-Goals

- Batch retry (select multiple rows → retry all) — deferred
- Persisting which model produced each transcription — deferred
- Confidence threshold override per-row — deferred
