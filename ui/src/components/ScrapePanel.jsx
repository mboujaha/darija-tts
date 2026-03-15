import React, { useEffect, useRef, useState } from 'react'
import api from '../api'

const DIALECTS = ['casablanca', 'marrakech', 'north', 'east', 'south']
import { WS_JOBS_URL } from '../config'
const WS_URL = WS_JOBS_URL
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
  if (line.startsWith('OK')) return 'text-emerald-400'
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

      {/* Progress */}
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

      {/* Log */}
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

export default function ScrapePanel() {
  const [dialect, setDialect] = useState('')
  const [jobs, setJobs] = useState([])
  const [logs, setLogs] = useState({})
  const [stats, setStats] = useState({})
  const [starting, setStarting] = useState(false)
  const wsRef = useRef(null)

  const loadJobs = async () => {
    try {
      const r = await api.get('/scrape/jobs')
      setJobs(r.data.jobs)
    } catch (e) {}
  }

  const loadStats = async () => {
    try {
      const r = await api.get('/scrape/stats')
      setStats(r.data.stats)
    } catch (e) {}
  }

  useEffect(() => {
    loadJobs()
    loadStats()
    const iv = setInterval(loadStats, 10000)

    // WebSocket
    const ws = new WebSocket(WS_URL)
    wsRef.current = ws

    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data)
        if (msg.type === 'job_update') {
          setJobs(prev => {
            const idx = prev.findIndex(j => j.id === msg.job_id)
            if (idx === -1) {
              loadJobs()
              return prev
            }
            const updated = [...prev]
            updated[idx] = { ...updated[idx], status: msg.status, progress: msg.progress, message: msg.message }
            return updated
          })
        } else if (msg.type === 'scrape_log') {
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

  const startScrape = async () => {
    setStarting(true)
    try {
      const body = dialect ? { dialect } : {}
      const r = await api.post('/scrape/start', body)
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
      await api.post(`/scrape/cancel/${job_id}`)
      setJobs(prev => prev.map(j => j.id === job_id ? { ...j, status: 'cancelling' } : j))
    } catch (e) {}
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-slate-100">Scrape</h2>
      </div>

      {/* Quick-start */}
      <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 flex gap-3 items-end">
        <div className="flex-1">
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
        <button
          onClick={startScrape}
          disabled={starting}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
        >
          {starting ? 'Starting…' : 'Start Scrape'}
        </button>
      </div>

      {/* Stats grid */}
      {Object.keys(stats).length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Download Stats</p>
          <div className="grid grid-cols-5 gap-2">
            {DIALECTS.map(d => {
              const s = stats[d] || { count: 0, hours: 0 }
              return (
                <div key={d} className="bg-slate-800 border border-slate-700 rounded-lg p-3 text-center">
                  <p className="text-xs text-slate-400 capitalize mb-1">{d}</p>
                  <p className="text-lg font-bold text-slate-100">{s.count}</p>
                  <p className="text-xs text-slate-500">{s.hours}h</p>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Job cards */}
      <div className="space-y-3">
        {jobs.length === 0 ? (
          <p className="text-sm text-slate-500 py-4">No scrape jobs yet.</p>
        ) : (
          jobs.map(job => (
            <JobCard key={job.id} job={job} logs={logs} onCancel={cancelJob} />
          ))
        )}
      </div>
    </div>
  )
}
