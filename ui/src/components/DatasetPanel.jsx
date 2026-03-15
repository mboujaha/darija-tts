import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
  if (line.startsWith('SPEAKER') || line.startsWith('COPY') || line.startsWith('DONE')) return 'text-emerald-400'
  if (line.startsWith('SKIP')) return 'text-yellow-400'
  if (line.startsWith('ERROR')) return 'text-red-400'
  return 'text-zinc-300'
}

const parseBuildResult = (message) => {
  if (!message) return null
  const m = message.match(/Done:\s*(\d+)\s*clips?,\s*(\d+)\s*speakers?,\s*(\d+)\s*train\s*\/\s*(\d+)\s*eval/)
  if (!m) return null
  return { total: +m[1], speakers: +m[2], train: +m[3], eval: +m[4] }
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

export default function DatasetPanel() {
  const navigate = useNavigate()
  const [dialect, setDialect] = useState('')
  const [minDuration, setMinDuration] = useState(3.0)
  const [maxDuration, setMaxDuration] = useState(11.0)
  const [minSpeakerClips, setMinSpeakerClips] = useState(20)
  const [includeApproved, setIncludeApproved] = useState(true)
  const [includeCorrected, setIncludeCorrected] = useState(true)
  const [includeTranscribed, setIncludeTranscribed] = useState(false)
  const [minConfidence, setMinConfidence] = useState(0.0)
  const [jobs, setJobs] = useState([])
  const [logs, setLogs] = useState({})
  const [stats, setStats] = useState(null)
  const [preview, setPreview] = useState([])
  const [starting, setStarting] = useState(false)
  const [buildResults, setBuildResults] = useState({})
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
          if (['completed', 'failed'].includes(msg.status)) loadStats()
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

  useEffect(() => {
    jobs.forEach(job => {
      if (job.status === 'completed' && job.message && !buildResults[job.id]) {
        const parsed = parseBuildResult(job.message)
        if (parsed) setBuildResults(prev => ({ ...prev, [job.id]: parsed }))
      }
    })
  }, [jobs])

  const selectedStatuses = [
    includeApproved    && 'approved',
    includeCorrected   && 'corrected',
    includeTranscribed && 'transcribed',
  ].filter(Boolean)

  const startBuild = async () => {
    setStarting(true)
    try {
      const body = {
        min_duration: minDuration,
        max_duration: maxDuration,
        min_speaker_clips: minSpeakerClips,
        statuses: selectedStatuses,
        min_confidence: minConfidence,
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

  const eligibilityPreview = (() => {
    if (!stats) return null
    const speakers = stats.by_speaker || []
    const filtered = dialect ? speakers.filter(s => s.dialect === dialect) : speakers
    const qualifying = filtered.filter(s => s.clips >= minSpeakerClips)
    const excluded = filtered.filter(s => s.clips < minSpeakerClips)
    return {
      qualifyingClips: qualifying.reduce((s, x) => s + x.clips, 0),
      excludedClips: excluded.reduce((s, x) => s + x.clips, 0),
      qualifyingSpeakers: qualifying.length,
      excludedSpeakers: excluded.length,
      totalSpeakers: filtered.length,
      willBeEmpty: qualifying.length === 0,
    }
  })()

  const speakerWarning = (() => {
    if (!stats || !eligibilityPreview) return null
    const speakers = stats.by_speaker || []
    const filtered = dialect ? speakers.filter(s => s.dialect === dialect) : speakers
    if (eligibilityPreview.willBeEmpty && filtered.length > 0) {
      return { recommendedMin: Math.min(...filtered.map(s => s.clips)) }
    }
    return null
  })()

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-zinc-100">Dataset Builder</h2>
      </div>

      {/* Explainer banner */}
      <div className="bg-zinc-900 border border-zinc-700 rounded-lg px-4 py-3 flex gap-3 items-start">
        <span className="text-xs font-semibold text-emerald-400 bg-emerald-900/30 px-2 py-0.5 rounded mt-0.5 flex-shrink-0">
          Step 4 / 6
        </span>
        <div>
          <p className="text-sm font-medium text-zinc-200 mb-0.5">Build your training dataset</p>
          <p className="text-xs text-zinc-400 leading-relaxed">
            Filters your transcribed clips by duration, groups them by speaker, and writes a
            Coqui-formatted dataset to <code className="text-zinc-300 bg-zinc-800 px-1 rounded">data/dataset/</code> —
            with <code className="text-zinc-300 bg-zinc-800 px-1 rounded">metadata_train.csv</code> and{' '}
            <code className="text-zinc-300 bg-zinc-800 px-1 rounded">metadata_eval.csv</code> — ready for the Train step.
          </p>
        </div>
      </div>

      {/* Config panel */}
      <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 space-y-4">
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

        {/* Min duration */}
        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1">
            Min Duration: <span className="text-zinc-200">{minDuration}s</span>
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
              className="w-16 bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-sm text-zinc-100 text-center"
            />
          </div>
        </div>

        {/* Max duration */}
        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1">
            Max Duration: <span className="text-zinc-200">{maxDuration}s</span>
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
              className="w-16 bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-sm text-zinc-100 text-center"
            />
          </div>
        </div>

        {/* Min clips per speaker */}
        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-1">Min Clips per Speaker</label>
          <input
            type="number" min={1} max={500} step={1} value={minSpeakerClips}
            onChange={e => setMinSpeakerClips(Number(e.target.value))}
            className="w-24 bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-sm text-zinc-100 text-center focus:outline-none focus:border-emerald-500"
          />
        </div>

        {/* Source clips */}
        <div>
          <label className="block text-xs font-medium text-zinc-400 mb-2">Source Clips</label>
          <div className="flex flex-col gap-2 mb-3">
            {[
              ['approved',    'Approved',             includeApproved,    setIncludeApproved],
              ['corrected',   'Corrected',            includeCorrected,   setIncludeCorrected],
              ['transcribed', 'Transcribed (unreviewed)', includeTranscribed, setIncludeTranscribed],
            ].map(([id, label, checked, setter]) => (
              <label key={id} className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={e => setter(e.target.checked)}
                  className="accent-emerald-500 w-3.5 h-3.5"
                />
                <span className="text-sm text-zinc-300">{label}</span>
              </label>
            ))}
          </div>
          {selectedStatuses.length === 0 && (
            <p className="text-xs text-red-400 mb-2">Select at least one status</p>
          )}
          <label className="block text-xs font-medium text-zinc-400 mb-1">
            Min Confidence: <span className="text-zinc-200">{Math.round(minConfidence * 100)}%</span>
          </label>
          <input
            type="range" min={0} max={1} step={0.05} value={minConfidence}
            onChange={e => setMinConfidence(Number(e.target.value))}
            className="w-full accent-emerald-500"
          />
        </div>

        {/* Speaker threshold warning */}
        {speakerWarning && (
          <div className="flex items-start gap-3 bg-yellow-900/20 border border-yellow-700/50 rounded-lg px-3 py-2.5">
            <span className="text-yellow-400 flex-shrink-0 mt-0.5">⚠</span>
            <p className="text-xs text-yellow-200/80 leading-relaxed flex-1">
              All eligible clips belong to speaker groups below the current minimum of{' '}
              <span className="font-mono text-yellow-300">{minSpeakerClips}</span>.
              The build will produce an empty dataset.
            </p>
            <button
              onClick={() => setMinSpeakerClips(speakerWarning.recommendedMin)}
              className="text-xs px-2 py-1 bg-yellow-700/40 hover:bg-yellow-700/60 text-yellow-300 rounded transition-colors flex-shrink-0"
            >
              Use {speakerWarning.recommendedMin}
            </button>
          </div>
        )}

        <button
          onClick={startBuild}
          disabled={starting || selectedStatuses.length === 0}
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
        >
          {starting ? 'Starting…' : 'Build Dataset'}
        </button>
      </div>

      {/* Eligibility preview */}
      {eligibilityPreview && (
        <div>
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Build Preview</p>
          <div className={`border rounded-lg p-3 grid grid-cols-3 gap-3 ${
            eligibilityPreview.willBeEmpty ? 'bg-red-900/10 border-red-800/50' : 'bg-zinc-800 border-zinc-700'
          }`}>
            <div className="text-center">
              <p className="text-xs text-zinc-400 mb-1">Clips to write</p>
              <p className={`text-xl font-bold ${eligibilityPreview.willBeEmpty ? 'text-red-400' : 'text-zinc-100'}`}>
                {eligibilityPreview.qualifyingClips.toLocaleString()}
              </p>
              {eligibilityPreview.excludedClips > 0 && (
                <p className="text-xs text-zinc-500">{eligibilityPreview.excludedClips.toLocaleString()} excluded</p>
              )}
            </div>
            <div className="text-center">
              <p className="text-xs text-zinc-400 mb-1">Speakers</p>
              <p className={`text-xl font-bold ${eligibilityPreview.willBeEmpty ? 'text-red-400' : 'text-zinc-100'}`}>
                {eligibilityPreview.qualifyingSpeakers}
              </p>
              {eligibilityPreview.excludedSpeakers > 0 && (
                <p className="text-xs text-zinc-500">{eligibilityPreview.excludedSpeakers} below threshold</p>
              )}
            </div>
            <div className="text-center">
              <p className="text-xs text-zinc-400 mb-1">Min clips filter</p>
              <p className={`text-xl font-bold ${eligibilityPreview.willBeEmpty ? 'text-red-400' : 'text-zinc-100'}`}>
                {minSpeakerClips}
              </p>
              <p className="text-xs text-zinc-500">per speaker</p>
            </div>
          </div>
          {eligibilityPreview.willBeEmpty && (
            <p className="text-xs text-red-400 mt-1.5">Lower the min clips value — all speaker groups are below the threshold.</p>
          )}
        </div>
      )}

      {/* Stats grid */}
      {stats && (
        <div>
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Eligible for Dataset</p>
          <div className="grid grid-cols-2 gap-3 mb-3">
            <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-3 text-center">
              <p className="text-xs text-zinc-400 mb-1">Total Clips</p>
              <p className="text-2xl font-bold text-zinc-100">{stats.total_clips}</p>
            </div>
            <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-3 text-center">
              <p className="text-xs text-zinc-400 mb-1">Total Hours</p>
              <p className="text-2xl font-bold text-zinc-100">{stats.total_hours}h</p>
            </div>
          </div>
          {Object.keys(stats.by_dialect || {}).length > 0 && (
            <div className="grid grid-cols-5 gap-2">
              {DIALECTS.map(d => {
                const s = (stats.by_dialect || {})[d] || { clips: 0, hours: 0 }
                return (
                  <div key={d} className="bg-zinc-800 border border-zinc-700 rounded-lg p-3 text-center">
                    <p className="text-xs text-zinc-400 capitalize mb-1">{d}</p>
                    <p className="text-lg font-bold text-zinc-100">{s.clips}</p>
                    <p className="text-xs text-zinc-500">{s.hours}h</p>
                  </div>
                )
              })}
            </div>
          )}
          {(stats.by_speaker || []).length > 0 && (
            <p className="text-xs text-zinc-500 mt-2">
              {stats.by_speaker.length} speaker{stats.by_speaker.length !== 1 ? 's' : ''} total
            </p>
          )}
        </div>
      )}

      {/* Sample preview */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Sample Preview</p>
          <button
            onClick={loadPreview}
            className="text-xs px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            Refresh Sample
          </button>
        </div>

        {preview.length === 0 ? (
          <p className="text-sm text-zinc-500 py-4">No transcribed clips available for preview.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-zinc-700">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-400 bg-zinc-800 border-b border-zinc-700">
                  <th className="px-3 py-2">Dialect</th>
                  <th className="px-3 py-2">Audio</th>
                  <th className="px-3 py-2 text-right">Text</th>
                  <th className="px-3 py-2">Duration</th>
                  <th className="px-3 py-2">SNR</th>
                </tr>
              </thead>
              <tbody className="bg-zinc-900/40">
                {preview.map(item => (
                  <tr key={item.id} className="border-b border-zinc-700 hover:bg-zinc-800/50">
                    <td className="px-3 py-2">
                      <span className="text-xs px-2 py-0.5 rounded bg-zinc-700 text-zinc-300 capitalize">
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
                        className="text-sm text-zinc-200 block text-right"
                        style={{ fontFamily: "'Noto Sans Arabic', Arial, sans-serif" }}
                      >
                        {item.text || '—'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-400 font-mono">
                      {item.duration != null ? item.duration.toFixed(1) + 's' : '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-400 font-mono">
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
          <p className="text-sm text-zinc-500 py-4">No dataset jobs yet.</p>
        ) : (
          jobs.map(job => (
            <JobCard key={job.id} job={job} logs={logs} onCancel={cancelJob} />
          ))
        )}
      </div>

      {/* Build result cards */}
      {Object.keys(buildResults).length > 0 && (
        <div>
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">Last Build Results</p>
          {jobs.filter(j => j.status === 'completed' && buildResults[j.id]).map(job => {
            const r = buildResults[job.id]
            return (
              <div key={job.id} className="bg-zinc-800 border border-emerald-800/50 rounded-lg px-4 py-3">
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-medium text-emerald-400">Build complete</span>
                  <span className="text-xs font-mono text-zinc-500 truncate max-w-xs">{job.id}</span>
                </div>
                <div className="grid grid-cols-4 gap-3 mb-2">
                  {[['Total', r.total, 'text-zinc-100'], ['Train', r.train, 'text-emerald-400'],
                    ['Eval', r.eval, 'text-blue-400'], ['Speakers', r.speakers, 'text-zinc-100']].map(([label, val, cls]) => (
                    <div key={label} className="text-center">
                      <p className="text-xs text-zinc-400 mb-0.5">{label}</p>
                      <p className={`text-lg font-bold ${cls}`}>{val.toLocaleString()}</p>
                    </div>
                  ))}
                </div>
                <p className="text-xs font-mono text-zinc-500">
                  Output: <span className="text-zinc-400">data/dataset/</span>
                  <span className="ml-2 text-zinc-600">metadata_train.csv · metadata_eval.csv · wavs/</span>
                </p>
              </div>
            )
          })}
        </div>
      )}

      {/* Go to Train banner */}
      {jobs.some(j => j.status === 'completed') && (
        <div className="bg-emerald-900/20 border border-emerald-800/50 rounded-lg px-4 py-3 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-emerald-300">Dataset ready for training</p>
            <p className="text-xs text-zinc-400 mt-0.5">Head to the Train step to start fine-tuning XTTS v2.</p>
          </div>
          <button
            onClick={() => navigate('/train')}
            className="ml-4 flex-shrink-0 px-4 py-2 bg-emerald-700 hover:bg-emerald-600 text-white text-sm font-medium rounded transition-colors"
          >
            Go to Train →
          </button>
        </div>
      )}
    </div>
  )
}
