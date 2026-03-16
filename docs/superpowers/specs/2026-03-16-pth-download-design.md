# Design: Download .pth Files for Completed Training Runs

**Date:** 2026-03-16

## Overview

Allow users to download the best `.pth` checkpoint file for any completed training run directly from the Train page.

## Architecture

Two-part change: a new backend download endpoint and a download button in the frontend `RunCard` component.

### Backend — `server/routes/train.py`

Add `GET /api/train/checkpoints/{run_id}/download`:

- Calls `get_checkpoints(CHECKPOINTS_DIR)` and finds the entry matching `run_id`
- Returns `FileResponse(best_model_path, filename="{run_id}_best_model.pth", media_type="application/octet-stream")`
- Returns 404 if no checkpoint found for that run

### Frontend — `ui/src/components/TrainPanel.jsx`

In `RunCard`, when `run.status === 'completed'` and `run.checkpoint_path` is set, render a download link in the expanded section next to the existing checkpoint path display:

```
<a href={`/api/train/checkpoints/${run.id}/download`} download>
  Download .pth
</a>
```

No JS state or blob handling needed — the browser handles the file download natively.

## Data Flow

1. User expands a completed `RunCard`
2. User clicks "Download .pth"
3. Browser navigates to `/api/train/checkpoints/{run_id}/download`
4. Backend locates the `.pth` file via `get_checkpoints()`, streams it as a file download
5. Browser saves the file as `{run_id}_best_model.pth`

## Error Handling

- 404 returned if run has no `.pth` file (e.g., training was cancelled before any checkpoint saved)
- Button is only shown when `run.checkpoint_path` is truthy, minimizing 404 cases

## Out of Scope

- Downloading intermediate checkpoints (only best model)
- Auth/token-based download protection (no auth in this app)
