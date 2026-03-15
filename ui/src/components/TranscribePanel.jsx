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
  if (line.startsWith('OK')) return 'text-emerald-400'
  if (line.startsWith('REJECT')) return 'text-yellow-400'
  if (line.startsWith('ERROR')) return 'text-red-400'
  return 'text-slate-300'
}

const confBadgeCls = (conf) => {
  if (conf >= 0.8) return 'bg-emerald-900/50 text-emerald-300'
  if (conf >= 0.6) return 'bg-yellow-900/50 text-yellow-300'
  return 'bg-red-900/50 text-red-300'
}

const statusBadgeCls = (s) => {
  if (s === 'corrected') return 'bg-blue-900/50 text-blue-300'
  if (s === 'rejected') return 'bg-red-900/50 text-red-300'
  return 'bg-slate-700 text-slate-300'
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

function ReviewRow({ item, onApprove, onReject, onCorrect }) {
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(item.text || '')

  const handleSave = () => {
    if (editText.trim() && editText.trim() !== item.text) {
      onCorrect(item.id, editText.trim())
    }
    setEditing(false)
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleSave()
    if (e.key === 'Escape') setEditing(false)
  }

  const audioUrl = `/api/audio/processed/${item.dialect}/${item.id}.wav`

  return (
    <tr className="border-b border-slate-700 hover:bg-slate-800/50">
      <td className="px-3 py-2">
        <span className="text-xs px-2 py-0.5 rounded bg-slate-700 text-slate-300 capitalize">
          {item.dialect}
        </span>
      </td>
      <td className="px-3 py-2">
        <audio
          controls
          src={audioUrl}
          className="h-7 w-36"
          preload="none"
        />
      </td>
      <td className="px-3 py-2 max-w-xs">
        {editing ? (
          <input
            dir="rtl"
            value={editText}
            onChange={e => setEditText(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
            autoFocus
            className="w-full bg-slate-900 border border-emerald-500 rounded px-2 py-1 text-sm text-slate-100 text-right focus:outline-none"
            style={{ fontFamily: "'Noto Sans Arabic', Arial, sans-serif" }}
          />
        ) : (
          <span
            dir="rtl"
            className="text-sm text-slate-200 block text-right"
            style={{ fontFamily: "'Noto Sans Arabic', Arial, sans-serif" }}
          >
            {item.text || '—'}
          </span>
        )}
      </td>
      <td className="px-3 py-2">
        <span className={`text-xs px-2 py-0.5 rounded font-mono ${confBadgeCls(item.confidence)}`}>
          {item.confidence != null ? (item.confidence * 100).toFixed(0) + '%' : '—'}
        </span>
      </td>
      <td className="px-3 py-2">
        <span className={`text-xs px-2 py-0.5 rounded capitalize ${statusBadgeCls(item.status)}`}>
          {item.status}
        </span>
      </td>
      <td className="px-3 py-2">
        <div className="flex gap-1">
          <button
            onClick={() => onApprove(item.id)}
            title="Approve"
            className="text-xs px-2 py-1 bg-emerald-900/40 hover:bg-emerald-700/50 text-emerald-400 rounded transition-colors"
          >
            ✓
          </button>
          <button
            onClick={() => setEditing(true)}
            title="Edit"
            className="text-xs px-2 py-1 bg-blue-900/40 hover:bg-blue-700/50 text-blue-400 rounded transition-colors"
          >
            ✏
          </button>
          <button
            onClick={() => onReject(item.id)}
            title="Reject"
            className="text-xs px-2 py-1 bg-red-900/40 hover:bg-red-700/50 text-red-400 rounded transition-colors"
          >
            ✗
          </button>
        </div>
      </td>
    </tr>
  )
}

export default function TranscribePanel() {
  const [dialect, setDialect] = useState('')
  const [model, setModel] = useState('large-v3')
  const [minConf, setMinConf] = useState(0.6)
  const [jobs, setJobs] = useState([])
  const [logs, setLogs] = useState({})
  const [stats, setStats] = useState({})
  const [starting, setStarting] = useState(false)

  // Review state
  const [reviewDialect, setReviewDialect] = useState('')
  const [reviewStatus, setReviewStatus] = useState('all')
  const [confRange, setConfRange] = useState([0, 1])
  const [reviewItems, setReviewItems] = useState([])
  const [reviewTotal, setReviewTotal] = useState(0)
  const [reviewOffset, setReviewOffset] = useState(0)
  const REVIEW_LIMIT = 50

  const wsRef = useRef(null)

  const loadJobs = async () => {
    try {
      const r = await api.get('/transcribe/jobs')
      setJobs(r.data.jobs)
    } catch (e) {}
  }

  const loadStats = async () => {
    try {
      const r = await api.get('/transcribe/stats')
      setStats(r.data.stats)
    } catch (e) {}
  }

  const loadReview = async (offset = 0) => {
    try {
      const params = {
        limit: REVIEW_LIMIT,
        offset,
        min_confidence: confRange[0],
        max_confidence: confRange[1],
      }
      if (reviewDialect) params.dialect = reviewDialect
      if (reviewStatus !== 'all') params.status = reviewStatus
      const r = await api.get('/transcribe/review', { params })
      setReviewItems(r.data.items || [])
      setReviewTotal(r.data.total || 0)
      setReviewOffset(offset)
    } catch (e) {}
  }

  useEffect(() => {
    loadJobs()
    loadStats()
    loadReview(0)
    const iv = setInterval(() => { loadStats(); loadReview(reviewOffset) }, 10000)

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
        } else if (msg.type === 'transcribe_log') {
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

  useEffect(() => {
    loadReview(0)
  }, [reviewDialect, reviewStatus, confRange])

  const startTranscribe = async () => {
    setStarting(true)
    try {
      const body = { model, min_confidence: minConf }
      if (dialect) body.dialect = dialect
      const r = await api.post('/transcribe/start', body)
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
      await api.post(`/transcribe/cancel/${job_id}`)
      setJobs(prev => prev.map(j => j.id === job_id ? { ...j, status: 'cancelling' } : j))
    } catch (e) {}
  }

  const handleApprove = async (clip_id) => {
    try {
      await api.post(`/transcribe/bulk-approve`, { clip_ids: [clip_id] })
      setReviewItems(prev => prev.map(i => i.id === clip_id ? { ...i, status: 'transcribed' } : i))
    } catch (e) {}
  }

  const handleReject = async (clip_id) => {
    try {
      await api.post(`/transcribe/reject/${clip_id}`)
      setReviewItems(prev => prev.map(i => i.id === clip_id ? { ...i, status: 'rejected' } : i))
    } catch (e) {}
  }

  const handleCorrect = async (clip_id, text) => {
    try {
      await api.put(`/transcribe/correct/${clip_id}`, { text })
      setReviewItems(prev => prev.map(i => i.id === clip_id ? { ...i, text, status: 'corrected', is_corrected: true } : i))
    } catch (e) {}
  }

  const STATUS_TABS = ['all', 'needs_review', 'corrected', 'rejected']

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-slate-100">Transcribe</h2>
      </div>

      {/* Config panel */}
      <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 space-y-4">
        <div className="grid grid-cols-2 gap-4">
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

          {/* Model */}
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Whisper Model</label>
            <select
              className="w-full bg-slate-900 border border-slate-600 rounded px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-emerald-500"
              value={model}
              onChange={e => setModel(e.target.value)}
            >
              <option value="large-v3">large-v3</option>
              <option value="medium">medium</option>
              <option value="small">small</option>
            </select>
          </div>
        </div>

        {/* Min confidence slider */}
        <div>
          <label className="block text-xs font-medium text-slate-400 mb-1">
            Min Confidence: <span className="text-slate-200">{(minConf * 100).toFixed(0)}%</span>
          </label>
          <input
            type="range" min={0} max={1} step={0.05} value={minConf}
            onChange={e => setMinConf(Number(e.target.value))}
            className="w-full accent-emerald-500"
          />
        </div>

        <button
          onClick={startTranscribe}
          disabled={starting}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
        >
          {starting ? 'Starting…' : 'Start Transcription'}
        </button>
      </div>

      {/* Stats grid */}
      {Object.keys(stats).length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Transcription Stats</p>
          <div className="grid grid-cols-5 gap-2">
            {DIALECTS.map(d => {
              const s = stats[d] || { transcribed: 0, avg_confidence: 0 }
              return (
                <div key={d} className="bg-slate-800 border border-slate-700 rounded-lg p-3 text-center">
                  <p className="text-xs text-slate-400 capitalize mb-1">{d}</p>
                  <p className="text-lg font-bold text-slate-100">{s.transcribed || 0}</p>
                  <p className="text-xs text-slate-500">{s.avg_confidence ? (s.avg_confidence * 100).toFixed(0) + '% avg' : '—'}</p>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Review table */}
      <div>
        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Review</p>

        {/* Filter bar */}
        <div className="flex flex-wrap gap-3 mb-3 items-center">
          <select
            className="bg-slate-800 border border-slate-700 rounded px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-emerald-500"
            value={reviewDialect}
            onChange={e => setReviewDialect(e.target.value)}
          >
            <option value="">All dialects</option>
            {DIALECTS.map(d => <option key={d} value={d} className="capitalize">{d}</option>)}
          </select>

          <div className="flex gap-1">
            {STATUS_TABS.map(tab => (
              <button
                key={tab}
                onClick={() => setReviewStatus(tab)}
                className={`text-xs px-3 py-1.5 rounded capitalize transition-colors ${
                  reviewStatus === tab
                    ? 'bg-emerald-700 text-white'
                    : 'bg-slate-800 border border-slate-700 text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab.replace('_', ' ')}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span>Conf:</span>
            <input
              type="range" min={0} max={1} step={0.05} value={confRange[0]}
              onChange={e => setConfRange([Number(e.target.value), confRange[1]])}
              className="w-20 accent-emerald-500"
            />
            <span>{(confRange[0] * 100).toFixed(0)}%</span>
            <span>–</span>
            <input
              type="range" min={0} max={1} step={0.05} value={confRange[1]}
              onChange={e => setConfRange([confRange[0], Number(e.target.value)])}
              className="w-20 accent-emerald-500"
            />
            <span>{(confRange[1] * 100).toFixed(0)}%</span>
          </div>
        </div>

        {reviewItems.length === 0 ? (
          <p className="text-sm text-slate-500 py-4">No transcriptions to review.</p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-slate-700">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-slate-400 bg-slate-800 border-b border-slate-700">
                    <th className="px-3 py-2">Dialect</th>
                    <th className="px-3 py-2">Audio</th>
                    <th className="px-3 py-2 text-right">Text</th>
                    <th className="px-3 py-2">Conf</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody className="bg-slate-900/40">
                  {reviewItems.map(item => (
                    <ReviewRow
                      key={item.id}
                      item={item}
                      onApprove={handleApprove}
                      onReject={handleReject}
                      onCorrect={handleCorrect}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between mt-3 text-xs text-slate-400">
              <span>
                {reviewOffset + 1}–{Math.min(reviewOffset + REVIEW_LIMIT, reviewTotal)} of {reviewTotal}
              </span>
              <div className="flex gap-2">
                <button
                  disabled={reviewOffset === 0}
                  onClick={() => loadReview(Math.max(0, reviewOffset - REVIEW_LIMIT))}
                  className="px-3 py-1.5 bg-slate-800 border border-slate-700 rounded hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Previous
                </button>
                <button
                  disabled={reviewOffset + REVIEW_LIMIT >= reviewTotal}
                  onClick={() => loadReview(reviewOffset + REVIEW_LIMIT)}
                  className="px-3 py-1.5 bg-slate-800 border border-slate-700 rounded hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Job cards */}
      <div className="space-y-3">
        {jobs.length === 0 ? (
          <p className="text-sm text-slate-500 py-4">No transcription jobs yet.</p>
        ) : (
          jobs.map(job => (
            <JobCard key={job.id} job={job} logs={logs} onCancel={cancelJob} />
          ))
        )}
      </div>
    </div>
  )
}
