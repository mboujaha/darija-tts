import React, { useEffect, useRef, useState } from 'react'
import api from '../api'

const DIALECTS = ['casablanca', 'marrakech', 'north', 'east', 'south']
import { WS_JOBS_URL } from '../config'
const WS_URL = WS_JOBS_URL
const MAX_LOG_LINES = 200

const statusColors = {
  running:    'bg-emerald-500',
  queued:     'bg-zinc-500',
  completed:  'bg-zinc-600',
  failed:     'bg-red-600',
  cancelling: 'bg-yellow-500',
  cancelled:  'bg-zinc-600',
}

const logLineCls = (line) => {
  if (line.startsWith('OK')) return 'text-emerald-400'
  if (line.startsWith('REJECT')) return 'text-yellow-400'
  if (line.startsWith('ERROR')) return 'text-red-400'
  return 'text-zinc-300'
}

const confBadgeCls = (conf) => {
  if (conf >= 0.8) return 'bg-emerald-900/50 text-emerald-300'
  if (conf >= 0.6) return 'bg-yellow-900/50 text-yellow-300'
  return 'bg-red-900/50 text-red-300'
}

const statusBadgeCls = (s) => {
  if (s === 'corrected') return 'bg-blue-900/50 text-blue-300'
  if (s === 'rejected')  return 'bg-red-900/50 text-red-300'
  if (s === 'approved')  return 'bg-emerald-900/50 text-emerald-300'
  return 'bg-zinc-700 text-zinc-300'
}

function JobCard({ job, logs, onCancel }) {
  const logRef = useRef(null)
  const jobLogs = logs[job.id] || []

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [jobLogs.length])

  const canCancel = job.status === 'running' || job.status === 'queued'

  return (
    <div className="bg-zinc-800 border border-zinc-700 rounded-lg overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-700">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusColors[job.status] || 'bg-zinc-500'}`} />
        <span className="text-sm font-mono text-zinc-300 flex-1 truncate">{job.id}</span>
        <span className="text-xs text-zinc-500 capitalize">{job.status}</span>
        {canCancel && (
          <button
            onClick={() => onCancel(job.id)}
            className="text-xs px-2 py-1 bg-zinc-700 hover:bg-red-900/40 text-zinc-400 hover:text-red-400 rounded transition-colors"
          >
            Cancel
          </button>
        )}
      </div>

      <div className="px-4 py-2">
        <div className="flex justify-between text-xs text-zinc-400 mb-1">
          <span>{job.message || '—'}</span>
          <span>{Math.round((job.progress || 0) * 100)}%</span>
        </div>
        <div className="w-full bg-zinc-900 rounded-full h-1.5">
          <div
            className={`h-1.5 rounded-full transition-all ${statusColors[job.status] || 'bg-zinc-500'}`}
            style={{ width: `${Math.round((job.progress || 0) * 100)}%` }}
          />
        </div>
      </div>

      {jobLogs.length > 0 && (
        <div
          ref={logRef}
          className="px-4 py-2 max-h-40 overflow-y-auto bg-zinc-900/60 font-mono text-xs space-y-0.5"
        >
          {jobLogs.map((line, i) => (
            <div key={i} className={logLineCls(line)}>{line}</div>
          ))}
        </div>
      )}
    </div>
  )
}

function ReviewRow({ item, onApprove, onReject, onCorrect, onRetry,
                     isRetrying, retryFlash, focused, onFocus, registerAudio }) {
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(item.text || '')
  const [pending, setPending] = useState(null)
  const [flash, setFlash] = useState(null)
  const [looping, setLooping] = useState(false)
  const [showRetryPopover, setShowRetryPopover] = useState(false)
  const [retryModel, setRetryModel] = useState('large-v3')
  const [retryError, setRetryError] = useState(null)
  const [retryPending, setRetryPending] = useState(false)
  const audioRef = useRef(null)

  const triggerFlash = (type) => {
    setFlash(type)
    setTimeout(() => setFlash(null), 1200)
  }

  useEffect(() => {
    if (retryFlash === 'success') triggerFlash('approved')
    else if (retryFlash === 'failed') triggerFlash('rejected')
  }, [retryFlash])

  const saveEditIfNeeded = async () => {
    if (editing && editText.trim() && editText.trim() !== item.text) {
      await onCorrect(item.id, editText.trim())
    }
    setEditing(false)
  }

  const handleApproveClick = async () => {
    await saveEditIfNeeded()
    setPending('approving')
    await onApprove(item.id)
    triggerFlash('approved')
    setPending(null)
  }

  const handleRejectClick = async () => {
    setEditing(false)
    setPending('rejecting')
    await onReject(item.id)
    triggerFlash('rejected')
    setPending(null)
  }

  const handleSave = async () => {
    if (editText.trim() && editText.trim() !== item.text) {
      setPending('correcting')
      await onCorrect(item.id, editText.trim())
      triggerFlash('corrected')
      setPending(null)
    }
    setEditing(false)
  }

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

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') handleSave()
    if (e.key === 'Escape') {
      if (showRetryPopover) { setShowRetryPopover(false); return }
      setEditing(false); setEditText(item.text || '')
    }
  }

  const audioUrl = `/api/audio/processed/${item.dialect}/${item.id}.wav`

  const flashCls = flash === 'approved' ? 'bg-emerald-900/40'
    : flash === 'corrected' ? 'bg-blue-900/40'
    : flash === 'rejected' ? 'bg-red-900/40'
    : ''

  return (
    <tr
      onClick={onFocus}
      className={`border-b border-zinc-700 transition-colors duration-300 cursor-pointer ${
        flashCls ? flashCls
        : focused ? 'border-l-2 border-l-emerald-500 bg-zinc-800/80'
        : isRetrying ? 'bg-zinc-800/30'
        : 'hover:bg-zinc-800/50'
      }`}
    >
      <td className="px-3 py-2">
        <span className="text-xs px-2 py-0.5 rounded bg-zinc-700 text-zinc-300 capitalize">
          {item.dialect}
        </span>
      </td>
      <td className="px-3 py-2">
        <div className="flex items-center gap-1.5">
          <audio
            ref={el => { audioRef.current = el; registerAudio?.(el) }}
            controls src={audioUrl} className="h-7 w-36" preload="none" loop={looping}
          />
          <button
            title={looping ? 'Loop on' : 'Loop off'}
            onClick={e => { e.stopPropagation(); setLooping(l => !l) }}
            className={`flex-shrink-0 w-6 h-6 rounded flex items-center justify-center text-xs transition-colors ${
              looping ? 'bg-emerald-700 text-white' : 'bg-zinc-700 text-zinc-400 hover:bg-zinc-600'
            }`}
          >
            ↻
          </button>
        </div>
      </td>
      <td className={`px-3 py-2 max-w-xs ${isRetrying ? 'opacity-50 animate-pulse' : ''}`}>
        {editing ? (
          <input
            dir="rtl"
            value={editText}
            onChange={e => setEditText(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
            className="w-full bg-zinc-900 border border-emerald-500 rounded px-2 py-1 text-sm text-zinc-100 text-right focus:outline-none"
            style={{ fontFamily: "'Noto Sans Arabic', Arial, sans-serif" }}
          />
        ) : (
          <span
            dir="rtl"
            className="text-sm text-zinc-200 block text-right cursor-text"
            title="Click edit to modify"
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
        {flash ? (
          <span className={`text-xs px-2 py-0.5 rounded capitalize font-medium ${
            flash === 'approved' ? 'bg-emerald-900/60 text-emerald-300'
            : flash === 'corrected' ? 'bg-blue-900/60 text-blue-300'
            : 'bg-red-900/60 text-red-300'
          }`}>
            {flash} ✓
          </span>
        ) : (
          <span className={`text-xs px-2 py-0.5 rounded capitalize ${statusBadgeCls(item.status)}`}>
            {item.status}
          </span>
        )}
      </td>
      <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
        {isRetrying ? (
          <div className="flex items-center gap-1 text-zinc-400 text-xs">
            <svg className="animate-spin h-4 w-4 flex-shrink-0" fill="none" viewBox="0 0 24 24">
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
              disabled={!!pending} title="Retry transcription"
              className={`text-xs px-2 py-1 rounded transition-colors disabled:opacity-50 ${
                showRetryPopover ? 'bg-amber-700/50 text-amber-300' : 'bg-zinc-700 hover:bg-zinc-600 text-zinc-300'
              }`}>
              ↺
            </button>
            <button onClick={handleRejectClick} disabled={!!pending} title="Reject"
              className="text-xs px-2 py-1 bg-red-900/40 hover:bg-red-700/50 text-red-400 rounded transition-colors disabled:opacity-50 min-w-[28px]">
              {pending === 'rejecting' ? '…' : '✗'}
            </button>

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
                {retryError && <p className="text-xs text-red-400 mb-2">{retryError}</p>}
                <div className="flex gap-1">
                  <button onClick={handleRetrySubmit} disabled={retryPending}
                    className="flex-1 text-xs px-2 py-1 bg-amber-700/50 hover:bg-amber-600/60 text-amber-200 rounded transition-colors disabled:opacity-50">
                    {retryPending ? '…' : 'Retry'}
                  </button>
                  <button onClick={() => setShowRetryPopover(false)}
                    className="text-xs px-2 py-1 bg-zinc-700 hover:bg-zinc-600 text-zinc-400 rounded transition-colors">
                    ✕
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
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
  const [savedCount, setSavedCount] = useState(0)
  const REVIEW_LIMIT = 50

  // Retry state
  const retryingClipsRef = useRef(new Map()) // Map<clip_id, {jobId, timeoutId}>
  const [retryingSet, setRetryingSet] = useState(new Set())
  const [retryFlashes, setRetryFlashes] = useState({})
  const unhandledRetryEventsRef = useRef([])

  // Keyboard focus
  const [focusedClipId, setFocusedClipId] = useState(null)
  const audioRefsMap = useRef({})

  // Shortcuts hint
  const [shortcutsHidden, setShortcutsHidden] = useState(
    () => localStorage.getItem('darija-tts:transcribe_shortcuts_dismissed') === '1'
  )

  const wsRef = useRef(null)

  const triggerRetryFlash = (clipId, type) => {
    setRetryFlashes(prev => ({ ...prev, [clipId]: type }))
    setTimeout(() => setRetryFlashes(prev => { const n = { ...prev }; delete n[clipId]; return n }), 1200)
  }

  const handleClipDoneEvent = (msg) => {
    const clipId = [...retryingClipsRef.current.entries()].find(([, v]) => v.jobId === msg.job_id)?.[0]
    if (!clipId) return
    removeRetrying(clipId)
    if (!msg.failed) {
      triggerRetryFlash(clipId, 'success')
      setReviewItems(prev => prev.map(i =>
        i.id === clipId ? { ...i, text: msg.text, confidence: msg.confidence, status: msg.status } : i
      ))
    } else {
      triggerRetryFlash(clipId, 'failed')
    }
  }

  const addRetrying = (clipId, jobId) => {
    const timeoutId = setTimeout(() => removeRetrying(clipId, true), 5 * 60 * 1000)
    retryingClipsRef.current.set(clipId, { jobId, timeoutId })
    setRetryingSet(prev => new Set([...prev, clipId]))
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

  const loadJobs = async () => {
    try {
      const r = await api.get('/transcribe/jobs')
      setJobs(r.data.jobs)
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
        } else if (msg.type === 'transcribe_clip_done') {
          const isKnown = [...retryingClipsRef.current.values()].some(v => v.jobId === msg.job_id)
          if (isKnown) {
            handleClipDoneEvent(msg)
          } else {
            unhandledRetryEventsRef.current.push(msg)
          }
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

  const removeRowAfterDelay = (clip_id) => {
    setTimeout(() => {
      setReviewItems(prev => prev.filter(i => i.id !== clip_id))
      setReviewTotal(prev => Math.max(0, prev - 1))
      setSavedCount(prev => prev + 1)
    }, 1000)
  }

  const handleApprove = async (clip_id) => {
    await api.post(`/transcribe/bulk-approve`, { clip_ids: [clip_id] })
    removeRowAfterDelay(clip_id)
  }

  const handleReject = async (clip_id) => {
    await api.post(`/transcribe/reject/${clip_id}`)
    setReviewItems(prev => prev.map(i => i.id === clip_id ? { ...i, status: 'rejected' } : i))
    setSavedCount(prev => prev + 1)
  }

  const handleCorrect = async (clip_id, text) => {
    await api.put(`/transcribe/correct/${clip_id}`, { text })
    setReviewItems(prev => prev.map(i => i.id === clip_id ? { ...i, text, status: 'corrected', is_corrected: true } : i))
    setSavedCount(prev => prev + 1)
  }

  const handleRetry = async (clipId, model) => {
    try {
      const r = await api.post('/transcribe/retry-clip', { clip_id: clipId, model })
      addRetrying(clipId, r.data.job_id)
      setJobs(prev => [{ id: r.data.job_id, status: 'queued', progress: 0, message: 'Queued (retry)' }, ...prev])
      return { ok: true }
    } catch (e) {
      if (e.response?.status === 409) return { error: 'Already retrying' }
      return { error: 'Server error' }
    }
  }

  const STATUS_TABS = ['all', 'needs_review', 'corrected', 'approved', 'rejected']

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
      } else if (e.key === 'a' && focusedClipId && !retryingSet.has(focusedClipId)) {
        handleApprove(focusedClipId)
      } else if (e.key === 'r' && focusedClipId && !retryingSet.has(focusedClipId)) {
        handleReject(focusedClipId)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [reviewItems, focusedClipId, retryingSet])

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-zinc-100">Transcribe</h2>
      </div>

      {/* Config panel */}
      <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          {/* Dialect */}
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1">Dialect (optional)</label>
            <select
              className="w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500"
              value={dialect}
              onChange={e => setDialect(e.target.value)}
            >
              <option value="">All dialects</option>
              {DIALECTS.map(d => <option key={d} value={d} className="capitalize">{d}</option>)}
            </select>
          </div>

          {/* Model */}
          <div>
            <label className="block text-xs font-medium text-zinc-400 mb-1">Whisper Model</label>
            <select
              className="w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500"
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
          <label className="block text-xs font-medium text-zinc-400 mb-1">
            Min Confidence: <span className="text-zinc-200">{(minConf * 100).toFixed(0)}%</span>
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
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Transcription Stats</p>
          <div className="grid grid-cols-5 gap-2">
            {DIALECTS.map(d => {
              const s = stats[d] || { transcribed: 0, avg_confidence: 0 }
              return (
                <div key={d} className="bg-zinc-800 border border-zinc-700 rounded-lg p-3 text-center">
                  <p className="text-xs text-zinc-400 capitalize mb-1">{d}</p>
                  <p className="text-lg font-bold text-zinc-100">{s.transcribed || 0}</p>
                  <p className="text-xs text-zinc-500">{s.avg_confidence ? (s.avg_confidence * 100).toFixed(0) + '% avg' : '—'}</p>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Review table */}
      <div>
        <div className="flex items-center gap-3 mb-2">
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Review</p>
          <span className="text-xs text-zinc-500">{reviewTotal} total</span>
          {savedCount > 0 && (
            <span className="text-xs px-2 py-0.5 rounded bg-emerald-900/40 text-emerald-400">
              {savedCount} saved this session
            </span>
          )}
        </div>

        {/* Filter bar */}
        <div className="flex flex-wrap gap-3 mb-3 items-center">
          <select
            className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500"
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
                    : 'bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {tab.replace('_', ' ')}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 text-xs text-zinc-400">
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
          <p className="text-sm text-zinc-500 py-4">No transcriptions to review.</p>
        ) : (
          <>
            <div className="overflow-x-auto rounded-lg border border-zinc-700">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-zinc-400 bg-zinc-800 border-b border-zinc-700">
                    <th className="px-3 py-2">Dialect</th>
                    <th className="px-3 py-2">Audio</th>
                    <th className="px-3 py-2 text-right">Text</th>
                    <th className="px-3 py-2">Conf</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Actions</th>
                  </tr>
                </thead>
                <tbody className="bg-zinc-900/40">
                  {reviewItems.map(item => (
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
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="flex items-center justify-between mt-3 text-xs text-zinc-400">
              <span>
                {reviewOffset + 1}–{Math.min(reviewOffset + REVIEW_LIMIT, reviewTotal)} of {reviewTotal}
              </span>
              <div className="flex gap-2">
                <button
                  disabled={reviewOffset === 0}
                  onClick={() => loadReview(Math.max(0, reviewOffset - REVIEW_LIMIT))}
                  className="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Previous
                </button>
                <button
                  disabled={reviewOffset + REVIEW_LIMIT >= reviewTotal}
                  onClick={() => loadReview(reviewOffset + REVIEW_LIMIT)}
                  className="px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Next
                </button>
              </div>
            </div>

            {!shortcutsHidden && (
              <div className="mt-2 flex items-center justify-between px-3 py-1.5 bg-zinc-800/60 border border-zinc-700 rounded text-xs text-zinc-500">
                <span>j/k navigate · Space play · a approve · r reject</span>
                <button
                  onClick={() => { setShortcutsHidden(true); localStorage.setItem('darija-tts:transcribe_shortcuts_dismissed', '1') }}
                  className="ml-3 text-zinc-600 hover:text-zinc-400 transition-colors"
                >✕</button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Job cards */}
      <div className="space-y-3">
        {jobs.length === 0 ? (
          <p className="text-sm text-zinc-500 py-4">No transcription jobs yet.</p>
        ) : (
          jobs.map(job => (
            <JobCard key={job.id} job={job} logs={logs} onCancel={cancelJob} />
          ))
        )}
      </div>
    </div>
  )
}
