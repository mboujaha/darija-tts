import React, { useEffect, useRef, useState } from 'react'
import api from '../api'

const DIALECTS = ['casablanca', 'marrakech', 'north', 'east', 'south']
const WS_URL = 'ws://localhost:8000/ws/jobs'
const MAX_LOG_LINES = 200

const statusColors = {
  running:    'bg-emerald-500',
  queued:     'bg-slate-500',
  completed:  'bg-slate-600',
  failed:     'bg-red-600',
  cancelling: 'bg-yellow-500',
  cancelled:  'bg-slate-600',
}

const logLineCls = (line) => {
  if (line.startsWith('SPEAKER') || line.startsWith('COPY') || line.startsWith('DONE')) return 'text-emerald-400'
  if (line.startsWith('SKIP')) return 'text-yellow-400'
  if (line.startsWith('ERROR')) return 'text-red-400'
  return 'text-slate-300'
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
          className="px-4 py-2 max-h-40 overflow-y-auto bg-slate-900/60 font-mono text-xs space-y-0.5"
        >
          {jobLogs.map((line, i) => (
            <div key={i} className={logLineCls(line)}>{line}</div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function DatasetPanel() {
  const [dialect, setDialect] = useState('')
  const [minDuration, setMinDuration] = useState(3.0)
  const [maxDuration, setMaxDuration] = useState(11.0)
  const [minSpeakerClips, setMinSpeakerClips] = useState(20)
  const [jobs, setJobs] = useState([])
  const [logs, setLogs] = useState({})
  const [stats, setStats] = useState(null)
  const [preview, setPreview] = useState([])
  const [starting, setStarting] = useState(false)
  const wsRef = useRef(null)

  const loadJobs = async () => {
    try {
      const r = await api.get('/dataset/jobs')
      setJobs(r.data.jobs)
    } catch (e) {}
  }

  const loadStats = async () => {
    try {
      const r = await api.get('/dataset/stats')
      setStats(r.data.stats)
    } catch (e) {}
  }

  const loadPreview = async () => {
    try {
      const r = await api.get('/dataset/preview')
      setPreview(r.data.items || [])
    } catch (e) {}
  }

  useEffect(() => {
    loadJobs()
    loadStats()
    loadPreview()
    const iv = setInterval(loadStats, 10000)

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
        } else if (msg.type === 'dataset_log') {
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

  const startBuild = async () => {
    setStarting(true)
    try {
      const body = {
        min_duration: minDuration,
        max_duration: maxDuration,
        min_speaker_clips: minSpeakerClips,
      }
      if (dialect) body.dialect = dialect
      const r = await api.post('/dataset/build', body)
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
      await api.post(`/dataset/cancel/${job_id}`)
      setJobs(prev => prev.map(j => j.id === job_id ? { ...j, status: 'cancelling' } : j))
    } catch (e) {}
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-slate-100">Dataset Builder</h2>
      </div>

      {/* Config panel */}
      <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 space-y-4">
        {/* Dialect */}
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Dialect (optional)</label>
          <select
            className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-emerald-500"
            value={dialect}
            onChange={e => setDialect(e.target.value)}
          >
            <option value="">All dialects</option>
            {DIALECTS.map(d => <option key={d} value={d} className="capitalize">{d}</option>)}
          </select>
        </div>

        {/* Min duration */}
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">
            Min Duration: <span className="text-slate-200">{minDuration}s</span>
          </label>
          <div className="flex gap-3 items-center">
            <input
              type="range" min={1} max={11} step={0.5} value={minDuration}
              onChange={e => setMinDuration(Number(e.target.value))}
              className="flex-1 accent-emerald-500"
            />
            <input
              type="number" min={1} max={11} step={0.5} value={minDuration}
              onChange={e => setMinDuration(Number(e.target.value))}
              className="w-16 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm text-slate-100 text-center"
            />
          </div>
        </div>

        {/* Max duration */}
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">
            Max Duration: <span className="text-slate-200">{maxDuration}s</span>
          </label>
          <div className="flex gap-3 items-center">
            <input
              type="range" min={3} max={15} step={0.5} value={maxDuration}
              onChange={e => setMaxDuration(Number(e.target.value))}
              className="flex-1 accent-emerald-500"
            />
            <input
              type="number" min={3} max={15} step={0.5} value={maxDuration}
              onChange={e => setMaxDuration(Number(e.target.value))}
              className="w-16 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm text-slate-100 text-center"
            />
          </div>
        </div>

        {/* Min clips per speaker */}
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">Min Clips per Speaker</label>
          <input
            type="number" min={1} max={500} step={1} value={minSpeakerClips}
            onChange={e => setMinSpeakerClips(Number(e.target.value))}
            className="w-24 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm text-slate-100 text-center focus:outline-none focus:border-emerald-500"
          />
        </div>

        <button
          onClick={startBuild}
          disabled={starting}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
        >
          {starting ? 'Starting…' : 'Build Dataset'}
        </button>
      </div>

      {/* Stats grid */}
      {stats && (
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Dataset Stats</p>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div className="bg-slate-800 border border-slate-700 rounded-lg p-3 text-center">
              <p className="text-xs text-slate-400 mb-1">Total Clips</p>
              <p className="text-2xl font-bold text-slate-100">{stats.total_clips}</p>
            </div>
            <div className="bg-slate-800 border border-slate-700 rounded-lg p-3 text-center">
              <p className="text-xs text-slate-400 mb-1">Total Hours</p>
              <p className="text-2xl font-bold text-slate-100">{stats.total_hours}h</p>
            </div>
          </div>
          {Object.keys(stats.by_dialect || {}).length > 0 && (
            <div className="grid grid-cols-5 gap-2">
              {DIALECTS.map(d => {
                const s = (stats.by_dialect || {})[d] || { clips: 0, hours: 0 }
                return (
                  <div key={d} className="bg-slate-800 border border-slate-700 rounded-lg p-3 text-center">
                    <p className="text-xs text-slate-400 capitalize mb-1">{d}</p>
                    <p className="text-lg font-bold text-slate-100">{s.clips}</p>
                    <p className="text-xs text-slate-500">{s.hours}h</p>
                  </div>
                )
              })}
            </div>
          )}
          {(stats.by_speaker || []).length > 0 && (
            <p className="text-xs text-slate-500 mt-2">
              {stats.by_speaker.length} speaker{stats.by_speaker.length !== 1 ? 's' : ''} total
            </p>
          )}
        </div>
      )}

      {/* Sample preview */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Sample Preview</p>
          <button
            onClick={loadPreview}
            className="text-xs px-3 py-1.5 bg-slate-800 border border-slate-700 rounded hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors"
          >
            Refresh Sample
          </button>
        </div>

        {preview.length === 0 ? (
          <p className="text-sm text-slate-500 py-4">No transcribed clips available for preview.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-700">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-slate-400 bg-slate-800 border-b border-slate-700">
                  <th className="px-3 py-2">Dialect</th>
                  <th className="px-3 py-2">Audio</th>
                  <th className="px-3 py-2 text-right">Text</th>
                  <th className="px-3 py-2">Duration</th>
                  <th className="px-3 py-2">SNR</th>
                </tr>
              </thead>
              <tbody className="bg-slate-900/40">
                {preview.map(item => (
                  <tr key={item.id} className="border-b border-slate-700 hover:bg-slate-800/50">
                    <td className="px-3 py-2">
                      <span className="text-xs px-2 py-0.5 rounded bg-slate-700 text-slate-300 capitalize">
                        {item.dialect}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <audio
                        controls
                        src={`/api/audio/processed/${item.dialect}/${item.id}.wav`}
                        className="h-7 w-36"
                        preload="none"
                      />
                    </td>
                    <td className="px-3 py-2 max-w-xs">
                      <span
                        dir="rtl"
                        className="text-sm text-slate-200 block text-right"
                        style={{ fontFamily: "'Noto Sans Arabic', Arial, sans-serif" }}
                      >
                        {item.text || '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-400 font-mono">
                      {item.duration != null ? item.duration.toFixed(1) + 's' : '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-400 font-mono">
                      {item.snr != null ? item.snr.toFixed(1) + ' dB' : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Job cards */}
      <div className="space-y-3">
        {jobs.length === 0 ? (
          <p className="text-sm text-slate-500 py-4">No dataset jobs yet.</p>
        ) : (
          jobs.map(job => (
            <JobCard key={job.id} job={job} logs={logs} onCancel={cancelJob} />
          ))
        )}
      </div>
    </div>
  )
}
