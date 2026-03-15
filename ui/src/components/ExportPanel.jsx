import React, { useEffect, useState } from 'react'
import api from '../api'

const FORMATS = [
  {
    id: 'coqui',
    label: 'Coqui TTS',
    desc: 'Pipe-delimited metadata.csv + wavs/ + speaker_wavs/. Use directly with Coqui trainer.',
    ext: '.zip',
  },
  {
    id: 'ljspeech',
    label: 'LJSpeech',
    desc: 'Standard LJSpeech layout: id|text|text in metadata.csv, flat wavs/.',
    ext: '.zip',
  },
  {
    id: 'huggingface',
    label: 'HuggingFace Datasets',
    desc: 'metadata.jsonl with file_name / transcription / speaker_id + wavs/.',
    ext: '.zip',
  },
]

function SizeBar({ used, total, label }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0
  return (
    <div>
      <div className="flex justify-between text-xs text-zinc-400 mb-1">
        <span>{label}</span>
        <span>{used} / {total}</span>
      </div>
      <div className="w-full bg-zinc-900 rounded-full h-1.5">
        <div
          className="h-1.5 rounded-full bg-emerald-500 transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

export default function ExportPanel() {
  const [stats, setStats] = useState(null)
  const [selectedFmt, setSelectedFmt] = useState('coqui')
  const [downloading, setDownloading] = useState(false)
  const [downloadingCkpt, setDownloadingCkpt] = useState('')
  const [error, setError] = useState('')

  const loadStats = async () => {
    try {
      const r = await api.get('/export/stats')
      setStats(r.data)
    } catch (e) {}
  }

  useEffect(() => {
    loadStats()
  }, [])

  const downloadDataset = async () => {
    setError('')
    setDownloading(true)
    try {
      // Trigger download via anchor — FileResponse streams the file
      const url = `/api/export/dataset?fmt=${selectedFmt}`
      const a = document.createElement('a')
      a.href = url
      a.download = `darija_dataset_${selectedFmt}.zip`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } catch (e) {
      setError('Download failed. Check server logs.')
    } finally {
      // Give the browser a moment to start the download before re-enabling
      setTimeout(() => setDownloading(false), 2000)
    }
  }

  const downloadCheckpoint = async (runId) => {
    setDownloadingCkpt(runId)
    try {
      const url = `/api/export/checkpoint/${encodeURIComponent(runId)}`
      const a = document.createElement('a')
      a.href = url
      a.download = `${runId}.tar.gz`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } catch (e) {
      setError('Checkpoint download failed.')
    } finally {
      setTimeout(() => setDownloadingCkpt(''), 2000)
    }
  }

  const ds = stats?.dataset
  const checkpoints = stats?.checkpoints || []

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-zinc-100">Export</h2>
        <button
          onClick={loadStats}
          className="text-xs px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Dataset stats */}
      <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 space-y-4">
        <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Dataset</p>

        {!ds ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : !ds.ready ? (
          <div className="bg-yellow-950/30 border border-yellow-800/40 rounded p-3">
            <p className="text-sm text-yellow-400">Dataset not ready.</p>
            <p className="text-xs text-yellow-600 mt-1">
              Run the Dataset Builder first to populate wavs/ and metadata.csv.
            </p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3">
              {[
                ['Train clips', ds.train_clips],
                ['Eval clips', ds.eval_clips],
                ['Speakers', ds.speaker_wavs],
              ].map(([label, val]) => (
                <div key={label} className="bg-zinc-900/60 rounded p-3 text-center">
                  <p className="text-xs text-zinc-500 mb-1">{label}</p>
                  <p className="text-lg font-bold text-zinc-100">{val.toLocaleString()}</p>
                </div>
              ))}
            </div>

            <SizeBar
              used={ds.train_clips + ds.eval_clips}
              total={ds.wav_files}
              label={`${ds.wav_files.toLocaleString()} WAV files · ${ds.wav_size_gb} GB uncompressed`}
            />

            {/* Format selector */}
            <div className="space-y-2">
              <p className="text-xs font-medium text-zinc-400">Export format</p>
              {FORMATS.map(fmt => (
                <label
                  key={fmt.id}
                  className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                    selectedFmt === fmt.id
                      ? 'border-emerald-600/60 bg-emerald-950/20'
                      : 'border-zinc-700 hover:border-zinc-600'
                  }`}
                >
                  <input
                    type="radio"
                    name="format"
                    value={fmt.id}
                    checked={selectedFmt === fmt.id}
                    onChange={() => setSelectedFmt(fmt.id)}
                    className="mt-0.5 accent-emerald-500"
                  />
                  <div>
                    <p className="text-sm font-medium text-zinc-200">{fmt.label}</p>
                    <p className="text-xs text-zinc-500 mt-0.5">{fmt.desc}</p>
                  </div>
                </label>
              ))}
            </div>

            {error && (
              <p className="text-xs text-red-400 bg-red-950/40 border border-red-900/40 rounded px-3 py-2">
                {error}
              </p>
            )}

            <div className="flex items-center gap-3">
              <button
                onClick={downloadDataset}
                disabled={downloading}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
              >
                {downloading ? 'Building ZIP…' : `Download ${selectedFmt.toUpperCase()} ZIP`}
              </button>
              <p className="text-xs text-zinc-500">
                ZIP will be built on-the-fly — large datasets may take a minute.
              </p>
            </div>
          </>
        )}
      </div>

      {/* Checkpoint export */}
      <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 space-y-3">
        <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
          Trained Checkpoints
        </p>

        {checkpoints.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No trained checkpoints found. Complete a training run first.
          </p>
        ) : (
          <div className="space-y-2">
            {checkpoints.map(ck => (
              <div
                key={ck.run_id}
                className="flex items-center gap-3 px-3 py-2.5 bg-zinc-900/50 rounded border border-zinc-700"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-mono text-zinc-200 truncate">{ck.run_id}</p>
                  <p className="text-xs text-zinc-500">{ck.size_mb} MB</p>
                </div>
                <button
                  onClick={() => downloadCheckpoint(ck.run_id)}
                  disabled={downloadingCkpt === ck.run_id}
                  className="flex-shrink-0 px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 text-xs rounded transition-colors disabled:opacity-50"
                >
                  {downloadingCkpt === ck.run_id ? 'Packing…' : 'Download .tar.gz'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
