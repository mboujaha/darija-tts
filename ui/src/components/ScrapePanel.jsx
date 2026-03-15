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
  if (line.startsWith('SKIP')) return 'text-yellow-400'
  if (line.startsWith('ERROR')) return 'text-red-400'
  return 'text-zinc-300'
}

// Parse "45/100 — 20 ok, 15 skip, 10 err" into parts
function parseJobMessage(msg) {
  if (!msg) return null
  const m = msg.match(/(\d+)\s+ok[,\s]+(\d+)\s+skip[,\s]+(\d+)\s+err/)
  if (m) return { prefix: msg.split('—')[0]?.trim(), ok: Number(m[1]), skip: Number(m[2]), err: Number(m[3]) }
  return null
}

function JobCard({ job, logs, onCancel }) {
  const logRef = useRef(null)
  const jobLogs = logs[job.id] || []

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [jobLogs.length])

  const canCancel = job.status === 'running' || job.status === 'queued'
  const parsed = parseJobMessage(job.message)

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
          <div className="flex items-center gap-1.5 flex-wrap">
            {parsed ? (
              <>
                {parsed.prefix && <span className="text-zinc-500 font-mono">{parsed.prefix} —</span>}
                <span className="px-1.5 py-0.5 bg-emerald-900/50 text-emerald-400 rounded font-mono">{parsed.ok} ok</span>
                <span className="px-1.5 py-0.5 bg-yellow-900/50 text-yellow-400 rounded font-mono">{parsed.skip} skip</span>
                <span className="px-1.5 py-0.5 bg-red-900/50 text-red-400 rounded font-mono">{parsed.err} err</span>
              </>
            ) : (
              <span>{job.message || '—'}</span>
            )}
          </div>
          <span className="ml-2 flex-shrink-0">{Math.round((job.progress || 0) * 100)}%</span>
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

export default function ScrapePanel() {
  const [dialect, setDialect] = useState('')
  const [jobs, setJobs] = useState([])
  const [logs, setLogs] = useState({})
  const [stats, setStats] = useState({})
  const [starting, setStarting] = useState(false)
  const [cookiesStatus, setCookiesStatus] = useState(null)
  const [cookiesUploading, setCookiesUploading] = useState(false)
  const [videos, setVideos] = useState([])
  const [videoTab, setVideoTab] = useState('all')
  const [clearingFailed, setClearingFailed] = useState(false)
  const wsRef = useRef(null)
  const cookiesInputRef = useRef(null)

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

  const loadCookiesStatus = async () => {
    try {
      const r = await api.get('/scrape/cookies-status')
      setCookiesStatus(r.data)
    } catch (e) {}
  }

  const loadVideos = async () => {
    try {
      const r = await api.get('/scrape/videos?limit=200')
      setVideos(r.data.videos || [])
    } catch (e) {}
  }

  useEffect(() => {
    loadJobs()
    loadStats()
    loadCookiesStatus()
    loadVideos()
    const iv = setInterval(loadStats, 10000)

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
            if (msg.status === 'completed' || msg.status === 'failed') loadVideos()
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

  const uploadCookies = async (file) => {
    if (!file) return
    setCookiesUploading(true)
    try {
      const form = new FormData()
      form.append('file', file)
      await api.post('/scrape/upload-cookies', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      })
      await loadCookiesStatus()
    } catch (e) {
      console.error(e)
    } finally {
      setCookiesUploading(false)
      if (cookiesInputRef.current) cookiesInputRef.current.value = ''
    }
  }

  const clearFailed = async () => {
    setClearingFailed(true)
    try {
      const params = dialect ? `?dialect=${dialect}` : ''
      await api.post(`/scrape/clear-failed${params}`)
      await loadVideos()
    } catch (e) {
      console.error(e)
    } finally {
      setClearingFailed(false)
    }
  }

  const retryFailed = async () => {
    await clearFailed()
    await startScrape()
  }

  const okCount = videos.filter(v => v.status === 'ok').length
  const failedCount = videos.filter(v => v.status !== 'ok').length
  const totalSeconds = videos.filter(v => v.status === 'ok').reduce((s, v) => s + (v.duration_seconds || 0), 0)
  const hoursDisplay = (totalSeconds / 3600).toFixed(1)

  const filteredVideos = videoTab === 'ok'
    ? videos.filter(v => v.status === 'ok')
    : videoTab === 'failed'
    ? videos.filter(v => v.status !== 'ok')
    : videos

  // Auth banner styles
  const authBannerCls = !cookiesStatus
    ? 'bg-zinc-800 border-zinc-700'
    : !cookiesStatus.present
    ? 'bg-red-950/30 border-red-700/50'
    : !cookiesStatus.valid
    ? 'bg-yellow-950/30 border-yellow-700/50'
    : 'bg-emerald-950/30 border-emerald-700/50'

  const authBadge = !cookiesStatus ? null
    : !cookiesStatus.present
    ? <span className="px-2 py-0.5 rounded-full bg-red-900/60 text-red-300 text-xs font-medium">No cookies</span>
    : !cookiesStatus.valid
    ? <span className="px-2 py-0.5 rounded-full bg-yellow-900/60 text-yellow-300 text-xs font-medium">Cookies present but invalid</span>
    : <span className="px-2 py-0.5 rounded-full bg-emerald-900/60 text-emerald-300 text-xs font-medium">Authenticated</span>

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-zinc-100">Scrape</h2>
      </div>

      {/* Section A — YouTube Auth */}
      <div className={`border rounded-lg p-4 ${authBannerCls}`}>
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-zinc-200">YouTube Authentication</span>
          {authBadge}
        </div>
        {cookiesStatus?.valid ? (
          <p className="text-xs text-zinc-400">
            Cookies are valid. Age-restricted and member-only videos can be downloaded.
          </p>
        ) : (
          <>
            <p className="text-xs text-zinc-400 mb-3">
              YouTube requires authentication for many videos. Export cookies while logged in using the
              <span className="text-zinc-200"> "Get cookies.txt LOCALLY" </span>
              Chrome extension, then upload here.
            </p>
            <div className="flex gap-2 items-center">
              <input
                ref={cookiesInputRef}
                type="file"
                accept=".txt"
                className="hidden"
                onChange={e => uploadCookies(e.target.files?.[0])}
              />
              <button
                onClick={() => cookiesInputRef.current?.click()}
                disabled={cookiesUploading}
                className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-zinc-200 text-xs font-medium rounded transition-colors disabled:opacity-50"
              >
                {cookiesUploading ? 'Uploading…' : 'Upload cookies.txt'}
              </button>
            </div>
          </>
        )}
      </div>

      {/* Section B — Controls */}
      <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 space-y-3">
        <div className="flex gap-3 items-end flex-wrap">
          <div className="flex-1 min-w-32">
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
          <button
            onClick={startScrape}
            disabled={starting}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
          >
            {starting ? 'Starting…' : 'Start Scrape'}
          </button>
          <button
            onClick={clearFailed}
            disabled={clearingFailed || failedCount === 0}
            className="px-3 py-2 bg-zinc-700 hover:bg-red-900/40 text-zinc-300 hover:text-red-400 text-sm rounded transition-colors disabled:opacity-40"
          >
            {clearingFailed ? 'Clearing…' : 'Clear failed'}
          </button>
        </div>
        {videos.length > 0 && (
          <p className="text-xs text-zinc-500">
            <span className="text-emerald-400 font-medium">{okCount}</span> downloaded
            {' · '}
            <span className={failedCount > 0 ? 'text-red-400 font-medium' : ''}>{failedCount}</span> failed
            {' · '}
            <span className="text-zinc-400">{hoursDisplay}h</span> audio
          </p>
        )}
      </div>

      {/* Stats grid */}
      {Object.keys(stats).length > 0 && (
        <div>
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Download Stats</p>
          <div className="grid grid-cols-5 gap-2">
            {DIALECTS.map(d => {
              const s = stats[d] || { count: 0, hours: 0 }
              return (
                <div key={d} className="bg-zinc-800 border border-zinc-700 rounded-lg p-3 text-center">
                  <p className="text-xs text-zinc-400 capitalize mb-1">{d}</p>
                  <p className="text-lg font-bold text-zinc-100">{s.count}</p>
                  <p className="text-xs text-zinc-500">{s.hours}h</p>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Section C — Job cards */}
      <div className="space-y-3">
        {jobs.length === 0 ? (
          <p className="text-sm text-zinc-500 py-4">No scrape jobs yet.</p>
        ) : (
          jobs.map(job => (
            <JobCard key={job.id} job={job} logs={logs} onCancel={cancelJob} />
          ))
        )}
      </div>

      {/* Section D — Downloaded Videos Table */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Downloaded Videos</p>
            <span className="text-xs text-zinc-500">
              {filteredVideos.length} rows{videoTab !== 'failed' && ` · ${hoursDisplay}h`}
            </span>
          </div>
          <div className="flex gap-1">
            {[['all', 'All'], ['ok', 'Downloaded'], ['failed', 'Failed']].map(([tab, label]) => (
              <button
                key={tab}
                onClick={() => setVideoTab(tab)}
                className={`text-xs px-3 py-1.5 rounded transition-colors ${
                  videoTab === tab
                    ? 'bg-zinc-700 text-zinc-100'
                    : 'bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700'
                }`}
              >
                {label}
                {tab === 'failed' && failedCount > 0 && (
                  <span className="ml-1.5 px-1 bg-red-900/60 text-red-300 rounded">{failedCount}</span>
                )}
              </button>
            ))}
          </div>
        </div>

        {videoTab === 'failed' && failedCount > 0 && (
          <div className="mb-3">
            <button
              onClick={retryFailed}
              disabled={starting || clearingFailed}
              className="px-3 py-1.5 bg-red-950/40 border border-red-700/40 text-red-300 hover:text-red-200 hover:bg-red-950/60 text-xs rounded transition-colors disabled:opacity-50"
            >
              Retry failed — clear {failedCount} record{failedCount !== 1 ? 's' : ''} and re-scrape
            </button>
          </div>
        )}

        {filteredVideos.length === 0 ? (
          <p className="text-sm text-zinc-500 py-4">
            {videoTab === 'failed' ? 'No failed downloads.' : 'No videos downloaded yet.'}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-700">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-400 bg-zinc-800 border-b border-zinc-700">
                  <th className="px-3 py-2">Video ID</th>
                  <th className="px-3 py-2">Dialect</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Duration</th>
                  <th className="px-3 py-2">Error</th>
                  <th className="px-3 py-2">Date</th>
                </tr>
              </thead>
              <tbody className="bg-zinc-900/40">
                {filteredVideos.map(v => (
                  <tr key={`${v.video_id}-${v.dialect}`} className="border-b border-zinc-700 hover:bg-zinc-800/50">
                    <td className="px-3 py-2">
                      <a
                        href={`https://youtu.be/${v.video_id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs font-mono text-emerald-400 hover:text-emerald-300 underline"
                      >
                        {v.video_id}
                      </a>
                    </td>
                    <td className="px-3 py-2">
                      <span className="text-xs px-2 py-0.5 rounded bg-zinc-700 text-zinc-300 capitalize">
                        {v.dialect}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                        v.status === 'ok'
                          ? 'bg-emerald-950/60 text-emerald-300'
                          : 'bg-red-950/60 text-red-300'
                      }`}>
                        {v.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-400 font-mono">
                      {v.duration_seconds != null ? `${(v.duration_seconds / 60).toFixed(1)}m` : '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-red-400 max-w-xs truncate" title={v.error_message || ''}>
                      {v.error_message || '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-500 font-mono whitespace-nowrap">
                      {v.downloaded_at ? v.downloaded_at.slice(0, 10) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
