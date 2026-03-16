# PTH Download Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a download button to completed training run cards so users can download the best `.pth` checkpoint file.

**Architecture:** New `GET /api/train/checkpoints/{run_id}/download` FastAPI endpoint serves the `.pth` file via `FileResponse`. A download link `<a>` tag is added to the expanded `RunCard` in `TrainPanel.jsx`, shown only for completed runs with a checkpoint.

**Tech Stack:** FastAPI (`FileResponse`), React (`<a download>`), existing `get_checkpoints()` utility.

---

## Chunk 1: Backend download endpoint

### Task 1: Add download endpoint to train routes

**Files:**
- Modify: `server/routes/train.py`

- [ ] **Step 1: Add the download endpoint**

In `server/routes/train.py`, make two edits:

**1a. Add `FileResponse` to the top-level imports** (line 4, alongside the existing fastapi import):

```python
from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import FileResponse
```

**1b. Append the new route at the end of the file** (after line 108, end of file):

```python
@router.get("/checkpoints/{run_id}/download")
async def download_checkpoint(run_id: str):
    checkpoints = get_checkpoints(CHECKPOINTS_DIR)
    ckpt = next((c for c in checkpoints if c["run_id"] == run_id), None)
    if ckpt is None:
        raise HTTPException(404, detail="No checkpoint found for this run")

    return FileResponse(
        ckpt["best_model"],
        media_type="application/octet-stream",
        filename=f"{run_id}_best_model.pth",
    )
```

- [ ] **Step 2: Verify the server starts without errors**

```bash
cd /Users/mohamedboujaha/claudecodeplayground/darija-tts
python -c "from server.routes.train import router; print('OK')"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add server/routes/train.py
git commit -m "feat: add GET /api/train/checkpoints/{run_id}/download endpoint"
```

---

## Chunk 2: Frontend download button

### Task 2: Add download link to RunCard

**Files:**
- Modify: `ui/src/components/TrainPanel.jsx`

- [ ] **Step 1: Update the checkpoint path display in RunCard**

In `TrainPanel.jsx`, find the checkpoint path block at the bottom of the expanded section (lines 218-223):

```jsx
{/* Checkpoint path */}
{run.checkpoint_path && (
  <p className="text-xs text-zinc-500 font-mono truncate">
    Checkpoint: {run.checkpoint_path}
  </p>
)}
```

Replace it with:

```jsx
{/* Checkpoint path + download */}
{run.checkpoint_path && (
  <div className="flex items-center justify-between gap-2">
    <p className="text-xs text-zinc-500 font-mono truncate">
      {run.checkpoint_path}
    </p>
    {run.status === 'completed' && (
      <a
        href={`/api/train/checkpoints/${run.id}/download`}
        download
        className="flex-shrink-0 text-xs px-2 py-1 bg-zinc-700 hover:bg-emerald-900/40 text-zinc-400 hover:text-emerald-400 rounded transition-colors"
      >
        Download .pth
      </a>
    )}
  </div>
)}
```

- [ ] **Step 2: Verify the UI builds without errors**

```bash
cd /Users/mohamedboujaha/claudecodeplayground/darija-tts/ui
npm run build 2>&1 | tail -20
```

Expected: build succeeds with no errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/TrainPanel.jsx
git commit -m "feat: add download .pth button to completed RunCard"
```
