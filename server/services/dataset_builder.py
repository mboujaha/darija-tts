import csv
import random
import shutil
from pathlib import Path


def build_dataset(
    clips: list,
    output_dir: str,
    min_duration: float = 3.0,
    max_duration: float = 11.0,
    min_speaker_clips: int = 20,
    progress_cb=None,
) -> dict:
    """Build a Coqui-formatted TTS dataset from transcribed clips.

    Returns {total_clips, total_speakers, skipped, train_count, eval_count, output_dir}
    """
    out = Path(output_dir)
    wavs_dir = out / "wavs"
    speaker_wavs_dir = out / "speaker_wavs"
    wavs_dir.mkdir(parents=True, exist_ok=True)
    speaker_wavs_dir.mkdir(parents=True, exist_ok=True)

    # Step 1: Filter by duration
    filtered = [
        c for c in clips
        if c["duration"] is not None
        and min_duration <= c["duration"] <= max_duration
    ]
    skipped_duration = len(clips) - len(filtered)

    # Step 2: Group by speaker key
    by_speaker: dict[str, list] = {}
    for clip in filtered:
        speaker_key = clip["speaker"] or f"{clip['dialect']}_default"
        by_speaker.setdefault(speaker_key, []).append(clip)

    # Step 3: Remove speakers below threshold
    qualified: dict[str, list] = {
        spk: clist
        for spk, clist in by_speaker.items()
        if len(clist) >= min_speaker_clips
    }
    skipped_speakers = sum(
        len(clist)
        for spk, clist in by_speaker.items()
        if spk not in qualified
    )

    total_skipped = skipped_duration + skipped_speakers

    # Log speaker info
    for spk, clist in qualified.items():
        line = f"SPEAKER {spk}: {len(clist)} clips selected"
        if progress_cb:
            progress_cb(0, 0, line)

    # Step 4: Pick reference clips (highest SNR)
    references: dict[str, dict] = {}
    for spk, clist in qualified.items():
        ref = max(clist, key=lambda c: c["snr"] if c["snr"] is not None else -999)
        references[spk] = ref

    # Collect all qualifying clips
    all_clips = []
    for spk, clist in qualified.items():
        for clip in clist:
            all_clips.append((spk, clip))

    total = len(all_clips)

    # Step 5: Copy WAV files
    for i, (spk, clip) in enumerate(all_clips):
        clip_id = clip["id"]
        src = Path(clip["file_path"])
        dest = wavs_dir / f"{clip_id}.wav"
        try:
            shutil.copy2(str(src), str(dest))
            line = f"COPY {clip_id}: wavs/{clip_id}.wav"
        except Exception as e:
            line = f"ERROR {clip_id}: {e}"
        if progress_cb:
            progress_cb(i + 1, total, line)

    # Step 6: Copy reference WAVs
    for spk, ref in references.items():
        src = Path(ref["file_path"])
        dest = speaker_wavs_dir / f"{spk}.wav"
        try:
            shutil.copy2(str(src), str(dest))
        except Exception as e:
            pass

    # Step 7: Build metadata rows per speaker, then split
    train_rows = []
    eval_rows = []

    for spk, clist in qualified.items():
        # Sort by clip id for deterministic split
        sorted_clips = sorted(clist, key=lambda c: c["id"])
        n = len(sorted_clips)
        n_eval = max(1, int(n * 0.05))
        train_part = sorted_clips[:n - n_eval]
        eval_part = sorted_clips[n - n_eval:]

        for clip in train_part:
            clip_id = clip["id"]
            text = (clip.get("text") or "").replace("|", " ")
            train_rows.append(f"wavs/{clip_id}.wav|{text}|{spk}")

        for clip in eval_part:
            clip_id = clip["id"]
            text = (clip.get("text") or "").replace("|", " ")
            eval_rows.append(f"wavs/{clip_id}.wav|{text}|{spk}")

    # Shuffle rows
    random.shuffle(train_rows)
    random.shuffle(eval_rows)
    all_rows = train_rows + eval_rows

    header = "audio_file|text|speaker_name"

    def write_csv(path: Path, rows: list):
        with open(path, "w", encoding="utf-8") as f:
            f.write(header + "\n")
            for row in rows:
                f.write(row + "\n")

    write_csv(out / "metadata.csv", all_rows)
    write_csv(out / "metadata_train.csv", train_rows)
    write_csv(out / "metadata_eval.csv", eval_rows)

    done_line = f"DONE: {len(all_rows)} clips total, {len(train_rows)} train, {len(eval_rows)} eval"
    if progress_cb:
        progress_cb(total, total, done_line)

    return {
        "total_clips": len(all_rows),
        "total_speakers": len(qualified),
        "skipped": total_skipped,
        "train_count": len(train_rows),
        "eval_count": len(eval_rows),
        "output_dir": str(out),
    }
