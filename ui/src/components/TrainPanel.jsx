import React, { useEffect, useRef, useState } from 'react'
import api from '../api'

import { WS_JOBS_URL } from '../config'
const WS_URL = WS_JOBS_URL
const MAX_LOG_LINES = 300

const statusColors = {
  running:    'bg-emerald-500',
  queued:     'bg-slate-500',
  completed:  'bg-slate-600',
  failed:     'bg-red-600',
  cancelling: 'bg-yellow-500',
  cancelled:  'bg-slate-600',
}

const runStatusCls = (s) => {
  if (s === 'completed') return 'text-emerald-400'
  if (s === 'failed')    return 'text-red-400'
  if (s === 'cancelled') return 'text-slate-500'
  if (s === 'running')   return 'text-yellow-400'
  return 'text-slate-400'
}

const logLineCls = (line) => {
  if (line.startsWith('STEP') || line.startsWith('CKPT') || line.startsWith('Training complete'))
    return 'text-emerald-400'
  if (line.startsWith('EVAL')) return 'text-blue-400'
  if (line.startsWith('ERROR') || line.startsWith('Failed') || line.startsWith('Training failed'))
    return 'text-red-400'
  if (line.startsWith('Training interrupted') || line.startsWith('Cancelled'))
    return 'text-yellow-400'
  return 'text-slate-300'
}

// Tiny SVG sparkline — no deps
function Sparkline({ data, color = '#10b981', height = 40 }) {
  if (!data || data.length < 2) {
    return (
      <div className="h-10 flex items-center justify-center text-xs text-slate-600">
        No data yet
      </div>
    )
  }

  const w = 300
  const h = height
  const pad = 4

  const vals = data.map(d => d.value).filter(v => v != null)
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const range = max - min || 1

  const pts = data
    .filter(d => d.value != null)
    .map((d, i, arr) => {
      const x = pad + (i / (arr.length - 1)) * (w - pad * 2)
      const y = h - pad - ((d.value - min) / range) * (h - pad * 2)
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height }}>
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

function JobCard({ job, logs, onCancel }) {
  const logRef = useRef(null)
  const jobLogs = logs[job.id] || []

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [jobLogs.length])

  const canCancel = job.status === 'running' || job.status === 'queued'

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-lg overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-700">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusColors[job.status] || 'bg-slate-500'}`} />
        <span className="text-sm font-mono text-slate-300 flex-1 truncate">{job.id}</span>
        <span className="text-xs text-slate-500 capitalize">{job.status}</span>
        {canCancel && (
          <button
            onClick={() => onCancel(job.id)}
            className="text-xs px-2 py-1 bg-slate-700 hover:bg-red-900/40 text-slate-400 hover:text-red-400 rounded transition-colors"
          >
            Cancel
          </button>
        )}
      </div>

      <div className="px-4 py-2">
        <div className="flex justify-between text-xs text-slate-400 mb-1">
          <span>{job.message || '—'}</span>
          <span>{Math.round((job.progress || 0) * 100)}%</span>
        </div>
        <div className="w-full bg-slate-900 rounded-full h-1.5">
          <div
            className={`h-1.5 rounded-full transition-all ${statusColors[job.status] || 'bg-slate-500'}`}
            style={{ width: `${Math.round((job.progress || 0) * 100)}%` }}
          />
        </div>
      </div>

      {jobLogs.length > 0 && (
        <div
          ref={logRef}
          className="px-4 py-2 max-h-48 overflow-y-auto bg-slate-900/60 font-mono text-xs space-y-0.5"
        >
          {jobLogs.map((line, i) => (
            <div key={i} className={logLineCls(line)}>{line}</div>
          ))}
        </div>
      )}
    </div>
  )
}

function RunCard({ run }) {
  const [lossHistory, setLossHistory] = useState(null)
  const [expanded, setExpanded] = useState(false)

  const loadLoss = async () => {
    try {
      const r = await api.get(`/train/runs/${run.id}/loss`)
      setLossHistory(r.data.history || [])
    } catch (e) {}
  }

  const handleExpand = () => {
    if (!expanded && !lossHistory) loadLoss()
    setExpanded(e => !e)
  }

  const cfg = run.config || {}
  const trainData = lossHistory
    ? lossHistory.filter(h => h.train_loss != null).map(h => ({ value: h.train_loss, step: h.step }))
    : []
  const evalData = lossHistory
    ? lossHistory.filter(h => h.eval_loss != null).map(h => ({ value: h.eval_loss, step: h.step }))
    : []

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-700/30 transition-colors"
        onClick={handleExpand}
      >
        <span className={`text-xs font-medium ${runStatusCls(run.status)} capitalize w-20 flex-shrink-0`}>
          {run.status}
        </span>
        <span className="text-sm font-mono text-slate-300 flex-1 truncate">{run.id}</span>
        <div className="flex items-center gap-3 text-xs text-slate-500 flex-shrink-0">
          <span>{cfg.training_type || 'full'}</span>
          <span>{run.current_epoch || 0}/{run.total_epochs || '?'} ep</span>
          {run.best_loss != null && (
            <span className="text-emerald-400">loss {run.best_loss.toFixed(4)}</span>
          )}
          <span className="text-slate-600">{expanded ? '▲' : '▼'}</span>
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-slate-700">
          {/* Config summary */}
          <div className="grid grid-cols-4 gap-2 pt-3">
            {[
              ['Epochs', cfg.epochs],
              ['Batch', cfg.batch_size],
              ['Grad acc', cfg.grad_accumulation],
              ['LR', cfg.learning_rate],
            ].map(([label, val]) => (
              <div key={label} className="text-center">
                <p className="text-xs text-slate-500">{label}</p>
                <p className="text-sm font-mono text-slate-200">{val ?? '—'}</p>
              </div>
            ))}
          </div>

          {/* Loss charts */}
          {lossHistory === null ? (
            <p className="text-xs text-slate-500">Loading loss history…</p>
          ) : lossHistory.length === 0 ? (
            <p className="text-xs text-slate-500">No loss data recorded yet.</p>
          ) : (
            <div className="space-y-2">
              {trainData.length > 1 && (
                <div>
                  <p className="text-xs text-slate-500 mb-1">Train loss</p>
                  <div className="bg-slate-900 rounded p-2">
                    <Sparkline data={trainData} color="#10b981" />
                  </div>
                </div>
              )}
              {evalData.length > 1 && (
                <div>
                  <p className="text-xs text-slate-500 mb-1">Eval loss</p>
                  <div className="bg-slate-900 rounded p-2">
                    <Sparkline data={evalData} color="#60a5fa" height={32} />
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Checkpoint path */}
          {run.checkpoint_path && (
            <p className="text-xs text-slate-500 font-mono truncate">
              Checkpoint: {run.checkpoint_path}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export default function TrainPanel() {
  const [trainingType, setTrainingType] = useState('full')
  const [epochs, setEpochs] = useState(10)
  const [batchSize, setBatchSize] = useState(2)
  const [gradAccum, setGradAccum] = useState(8)
  const [learningRate, setLearningRate] = useState(5e-6)
  const [baseCheckpoint, setBaseCheckpoint] = useState('')

  const [jobs, setJobs] = useState([])
  const [logs, setLogs] = useState({})
  const [runs, setRuns] = useState([])
  const [checkpoints, setCheckpoints] = useState([])
  const [starting, setStarting] = useState(false)
  const wsRef = useRef(null)

  const loadJobs = async () => {
    try {
      const r = await api.get('/train/jobs')
      setJobs(r.data.jobs)
    } catch (e) {}
  }

  const loadRuns = async () => {
    try {
      const r = await api.get('/train/runs')
      setRuns(r.data.runs)
    } catch (e) {}
  }

  const loadCheckpoints = async () => {
    try {
      const r = await api.get('/train/checkpoints')
      setCheckpoints(r.data.checkpoints)
    } catch (e) {}
  }

  useEffect(() => {
    loadJobs()
    loadRuns()
    loadCheckpoints()
    const iv = setInterval(() => { loadRuns(); loadCheckpoints() }, 15000)

    const ws = new WebSocket(WS_URL)
    wsRef.current = ws

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data)
        if (msg.type === 'job_update') {
          setJobs(prev => {
            const idx = prev.findIndex(j => j.id === msg.job_id)
            if (idx === -1) { loadJobs(); return prev }
            const updated = [...prev]
            updated[idx] = { ...updated[idx], status: msg.status, progress: msg.progress, message: msg.message }
            return updated
          })
          // Refresh runs on job completion
          if (['completed', 'failed', 'cancelled'].includes(msg.status)) {
            loadRuns()
            loadCheckpoints()
          }
        } else if (msg.type === 'train_log') {
          setLogs(prev => {
            const existing = prev[msg.job_id] || []
            const next = [...existing, msg.line].slice(-MAX_LOG_LINES)
            return { ...prev, [msg.job_id]: next }
          })
        }
      } catch (e) {}
    }

    return () => {
      clearInterval(iv)
      ws.close()
    }
  }, [])

  const startTraining = async () => {
    setStarting(true)
    try {
      const body = {
        training_type: trainingType,
        epochs,
        batch_size: batchSize,
        grad_accumulation: gradAccum,
        learning_rate: learningRate,
      }
      if (baseCheckpoint.trim()) body.base_checkpoint = baseCheckpoint.trim()
      const r = await api.post('/train/start', body)
      const newJob = { id: r.data.job_id, status: 'queued', progress: 0, message: 'Queued' }
      setJobs(prev => [newJob, ...prev])
    } catch (e) {
      console.error(e)
    } finally {
      setStarting(false)
    }
  }

  const cancelJob = async (job_id) => {
    try {
      await api.post(`/train/cancel/${job_id}`)
      setJobs(prev => prev.map(j => j.id === job_id ? { ...j, status: 'cancelling' } : j))
    } catch (e) {}
  }

  const effectiveLR = learningRate

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-slate-100">Train</h2>
      </div>

      {/* Config panel */}
      <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 space-y-4">
        {/* Training type */}
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Training Type</label>
          <div className="flex gap-2">
            {[
              { val: 'full', label: 'Full Fine-tune' },
              { val: 'freeze_encoder', label: 'Freeze Encoder' },
            ].map(({ val, label }) => (
              <button
                key={val}
                onClick={() => setTrainingType(val)}
                className={`px-3 py-1.5 text-xs rounded transition-colors ${
                  trainingType === val
                    ? 'bg-emerald-700 text-white'
                    : 'bg-slate-900 border border-slate-600 text-slate-400 hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          {/* Epochs */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">
              Epochs: <span className="text-slate-200">{epochs}</span>
            </label>
            <div className="flex gap-2 items-center">
              <input
                type="range" min={1} max={100} step={1} value={epochs}
                onChange={e => setEpochs(Number(e.target.value))}
                className="flex-1 accent-emerald-500"
              />
              <input
                type="number" min={1} max={1000} value={epochs}
                onChange={e => setEpochs(Number(e.target.value))}
                className="w-16 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm text-slate-100 text-center"
              />
            </div>
          </div>

          {/* Batch size */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">
              Batch Size: <span className="text-slate-200">{batchSize}</span>
            </label>
            <div className="flex gap-2 items-center">
              <input
                type="range" min={1} max={16} step={1} value={batchSize}
                onChange={e => setBatchSize(Number(e.target.value))}
                className="flex-1 accent-emerald-500"
              />
              <input
                type="number" min={1} max={64} value={batchSize}
                onChange={e => setBatchSize(Number(e.target.value))}
                className="w-16 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm text-slate-100 text-center"
              />
            </div>
          </div>

          {/* Grad accumulation */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">
              Grad Accumulation: <span className="text-slate-200">{gradAccum}</span>
            </label>
            <div className="flex gap-2 items-center">
              <input
                type="range" min={1} max={32} step={1} value={gradAccum}
                onChange={e => setGradAccum(Number(e.target.value))}
                className="flex-1 accent-emerald-500"
              />
              <input
                type="number" min={1} max={128} value={gradAccum}
                onChange={e => setGradAccum(Number(e.target.value))}
                className="w-16 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm text-slate-100 text-center"
              />
            </div>
          </div>

          {/* Learning rate */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Learning Rate</label>
            <select
              value={effectiveLR}
              onChange={e => setLearningRate(Number(e.target.value))}
              className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-emerald-500"
            >
              <option value={1e-5}>1e-5</option>
              <option value={5e-6}>5e-6</option>
              <option value={1e-6}>1e-6</option>
              <option value={5e-7}>5e-7</option>
              <option value={1e-7}>1e-7</option>
            </select>
          </div>
        </div>

        {/* Base checkpoint */}
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">
            Base Checkpoint Path{' '}
            <span className="text-slate-600">(leave empty to download XTTS v2)</span>
          </label>
          <input
            type="text"
            value={baseCheckpoint}
            onChange={e => setBaseCheckpoint(e.target.value)}
            placeholder="/path/to/xtts_v2_checkpoint_dir"
            className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm text-slate-100 font-mono placeholder-slate-600 focus:outline-none focus:border-emerald-500"
          />
          {checkpoints.length > 0 && (
            <div className="mt-1 space-y-0.5">
              <p className="text-xs text-slate-600">Or select a local checkpoint:</p>
              {checkpoints.map(ck => (
                <button
                  key={ck.path}
                  onClick={() => setBaseCheckpoint(ck.path)}
                  className="block text-xs text-slate-400 hover:text-emerald-400 font-mono truncate max-w-full"
                >
                  {ck.run_id} ({ck.size_mb} MB)
                </button>
              ))}
            </div>
          )}
        </div>

        <button
          onClick={startTraining}
          disabled={starting}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
        >
          {starting ? 'Starting…' : 'Start Training'}
        </button>
      </div>

      {/* Training runs */}
      {runs.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
            Training Runs
          </p>
          <div className="space-y-2">
            {runs.map(run => (
              <RunCard key={run.id} run={run} />
            ))}
          </div>
        </div>
      )}

      {/* Job cards */}
      <div className="space-y-3">
        {jobs.length === 0 ? (
          <p className="text-sm text-slate-500 py-4">No training jobs yet.</p>
        ) : (
          jobs.map(job => (
            <JobCard key={job.id} job={job} logs={logs} onCancel={cancelJob} />
          ))
        )}
      </div>
    </div>
  )
}
