import React, { useEffect, useRef, useState } from 'react'
import api from '../api'

import { WS_JOBS_URL } from '../config'
const WS_URL = WS_JOBS_URL
const MAX_LOG_LINES = 200

const DEFAULT_SENTENCES = [
  'كيف داير خويا؟',
  'لاباس الحمد لله',
  'واش يمكن تعاونني من فضلك؟',
  'بغيت نشري شي حاجة من هنا',
  'شكرا بزاف على مساعدتك',
].join('\n')

const statusColors = {
  running:    'bg-emerald-500',
  queued:     'bg-zinc-500',
  completed:  'bg-zinc-600',
  failed:     'bg-red-600',
  cancelling: 'bg-yellow-500',
  cancelled:  'bg-zinc-600',
}

const logLineCls = (line) => {
  if (line.startsWith('OK') || line.startsWith('DONE') || line.startsWith('INFO')) return 'text-emerald-400'
  if (line.startsWith('ERR') || line.startsWith('Error')) return 'text-red-400'
  return 'text-zinc-300'
}

// Metric badge — color by goodness direction
function MetricBadge({ value, label, lowerBetter = false, good, warn }) {
  if (value == null) return <span className="text-zinc-600 text-xs">—</span>
  const n = Number(value)
  let cls = 'text-zinc-300'
  if (lowerBetter) {
    if (n <= good) cls = 'text-emerald-400'
    else if (n <= warn) cls = 'text-yellow-400'
    else cls = 'text-red-400'
  } else {
    if (n >= good) cls = 'text-emerald-400'
    else if (n >= warn) cls = 'text-yellow-400'
    else cls = 'text-red-400'
  }
  return (
    <span className={`font-mono text-xs ${cls}`}>
      {n.toFixed(label === 'RTF' ? 3 : 2)}
    </span>
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

function SpeakerSummaryTable({ summaries }) {
  if (!summaries || summaries.length === 0) return null
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-700">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-zinc-400 bg-zinc-800 border-b border-zinc-700">
            <th className="px-3 py-2">Speaker</th>
            <th className="px-3 py-2 text-center">Samples</th>
            <th className="px-3 py-2 text-center">MCD ↓</th>
            <th className="px-3 py-2 text-center">Sim ↑</th>
            <th className="px-3 py-2 text-center">SNR ↑</th>
            <th className="px-3 py-2 text-center">RTF ↓</th>
            <th className="px-3 py-2 text-center">Dur</th>
          </tr>
        </thead>
        <tbody className="bg-zinc-900/40 divide-y divide-zinc-700">
          {summaries.map(s => (
            <tr key={s.speaker_id} className="hover:bg-zinc-800/50">
              <td className="px-3 py-2">
                <div>
                  <p className="text-sm text-zinc-200">{s.speaker_name}</p>
                  <p className="text-xs text-zinc-500 font-mono">{s.speaker_id}</p>
                </div>
              </td>
              <td className="px-3 py-2 text-center text-xs text-zinc-400">
                {s.n_ok}/{s.n_samples}
              </td>
              <td className="px-3 py-2 text-center">
                <MetricBadge value={s.avg_mcd} label="MCD" lowerBetter good={5} warn={10} />
              </td>
              <td className="px-3 py-2 text-center">
                <MetricBadge value={s.avg_speaker_sim} label="Sim" good={0.85} warn={0.7} />
              </td>
              <td className="px-3 py-2 text-center">
                <MetricBadge value={s.avg_snr} label="SNR" good={25} warn={15} />
              </td>
              <td className="px-3 py-2 text-center">
                <MetricBadge value={s.avg_rtf} label="RTF" lowerBetter good={0.3} warn={1.0} />
              </td>
              <td className="px-3 py-2 text-center text-xs text-zinc-400 font-mono">
                {s.avg_duration != null ? s.avg_duration.toFixed(1) + 's' : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ResultsTable({ results }) {
  const [filter, setFilter] = useState('')
  const filtered = filter
    ? results.filter(r => r.speaker_id === filter || r.sentence.includes(filter))
    : results

  const speakers = [...new Set(results.map(r => r.speaker_id))]

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <select
          value={filter}
          onChange={e => setFilter(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-emerald-500"
        >
          <option value="">All speakers</option>
          {speakers.map(sid => <option key={sid} value={sid}>{sid}</option>)}
        </select>
        <span className="text-xs text-zinc-500">{filtered.length} rows</span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-zinc-700 max-h-96 overflow-y-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10">
            <tr className="text-left text-zinc-400 bg-zinc-800 border-b border-zinc-700">
              <th className="px-3 py-2">Speaker</th>
              <th className="px-3 py-2">Audio</th>
              <th className="px-3 py-2 text-right">Sentence</th>
              <th className="px-3 py-2 text-center">MCD ↓</th>
              <th className="px-3 py-2 text-center">Sim ↑</th>
              <th className="px-3 py-2 text-center">SNR ↑</th>
              <th className="px-3 py-2 text-center">RTF ↓</th>
            </tr>
          </thead>
          <tbody className="bg-zinc-900/40 divide-y divide-zinc-700">
            {filtered.map((r, i) => (
              <tr key={i} className={`hover:bg-zinc-800/50 ${r.error ? 'opacity-50' : ''}`}>
                <td className="px-3 py-2 text-zinc-400 font-mono whitespace-nowrap">
                  {r.speaker_id}
                </td>
                <td className="px-3 py-2">
                  {r.gen_url && !r.error ? (
                    <audio controls src={r.gen_url} className="h-7 w-36" preload="none" />
                  ) : (
                    <span className="text-red-400 text-xs">{r.error || '—'}</span>
                  )}
                </td>
                <td className="px-3 py-2 max-w-xs text-right">
                  <span
                    dir="rtl"
                    className="text-zinc-300 block text-right"
                    style={{ fontFamily: "'Noto Sans Arabic', Arial, sans-serif" }}
                  >
                    {r.sentence}
                  </span>
                </td>
                <td className="px-3 py-2 text-center">
                  <MetricBadge value={r.mcd} label="MCD" lowerBetter good={5} warn={10} />
                </td>
                <td className="px-3 py-2 text-center">
                  <MetricBadge value={r.speaker_sim} label="Sim" good={0.85} warn={0.7} />
                </td>
                <td className="px-3 py-2 text-center">
                  <MetricBadge value={r.snr} label="SNR" good={25} warn={15} />
                </td>
                <td className="px-3 py-2 text-center">
                  <MetricBadge value={r.rtf} label="RTF" lowerBetter good={0.3} warn={1.0} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function EvaluatePanel() {
  const [sentences, setSentences] = useState(DEFAULT_SENTENCES)
  const [voices, setVoices] = useState([])
  const [selectedVoices, setSelectedVoices] = useState([])   // [] = all
  const [checkpoints, setCheckpoints] = useState([])
  const [checkpointDir, setCheckpointDir] = useState('')
  const [language, setLanguage] = useState('ar')
  const [temperature, setTemperature] = useState(0.65)

  const [jobs, setJobs] = useState([])
  const [logs, setLogs] = useState({})
  const [starting, setStarting] = useState(false)

  // Results viewer
  const [selectedJobId, setSelectedJobId] = useState('')
  const [results, setResults] = useState(null)
  const [summaries, setSummaries] = useState(null)
  const [loadingResults, setLoadingResults] = useState(false)

  const wsRef = useRef(null)

  const loadJobs = async () => {
    try {
      const r = await api.get('/evaluate/jobs')
      setJobs(r.data.jobs)
    } catch (e) {}
  }

  const loadVoices = async () => {
    try {
      const r = await api.get('/synthesize/voices')
      setVoices(r.data.voices || [])
    } catch (e) {}
  }

  const loadCheckpoints = async () => {
    try {
      const r = await api.get('/synthesize/checkpoints')
      setCheckpoints(r.data.checkpoints || [])
    } catch (e) {}
  }

  const loadResults = async (jobId) => {
    setLoadingResults(true)
    try {
      const r = await api.get(`/evaluate/results/${jobId}`)
      setResults(r.data.results || [])
      setSummaries(r.data.by_speaker || [])
    } catch (e) {
      setResults(null)
      setSummaries(null)
    } finally {
      setLoadingResults(false)
    }
  }

  useEffect(() => {
    loadJobs()
    loadVoices()
    loadCheckpoints()

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
          if (msg.status === 'completed' && msg.job_id === selectedJobId) {
            loadResults(msg.job_id)
          }
        } else if (msg.type === 'eval_log') {
          setLogs(prev => {
            const existing = prev[msg.job_id] || []
            const next = [...existing, msg.line].slice(-MAX_LOG_LINES)
            return { ...prev, [msg.job_id]: next }
          })
        }
      } catch (e) {}
    }

    return () => ws.close()
  }, [selectedJobId])

  const toggleVoice = (id) => {
    setSelectedVoices(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    )
  }

  const startEval = async () => {
    const sentenceList = sentences.split('\n').map(s => s.trim()).filter(Boolean)
    if (!sentenceList.length) return
    setStarting(true)
    try {
      const body = {
        sentences: sentenceList,
        speaker_ids: selectedVoices,
        language,
        temperature,
      }
      if (checkpointDir) body.checkpoint_dir = checkpointDir
      const r = await api.post('/evaluate/run', body)
      const newJob = { id: r.data.job_id, status: 'queued', progress: 0, message: 'Queued' }
      setJobs(prev => [newJob, ...prev])
      setSelectedJobId(r.data.job_id)
    } catch (e) {
      console.error(e)
    } finally {
      setStarting(false)
    }
  }

  const cancelJob = async (job_id) => {
    try {
      await api.post(`/evaluate/cancel/${job_id}`)
      setJobs(prev => prev.map(j => j.id === job_id ? { ...j, status: 'cancelling' } : j))
    } catch (e) {}
  }

  const handleViewResults = (job_id) => {
    setSelectedJobId(job_id)
    loadResults(job_id)
  }

  const sentenceCount = sentences.split('\n').filter(s => s.trim()).length
  const voiceCount = selectedVoices.length || voices.length
  const totalPairs = sentenceCount * voiceCount

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-zinc-100">Evaluate</h2>
      </div>

      <div className="grid grid-cols-5 gap-4">
        {/* ── Left: sentences + run ── */}
        <div className="col-span-3 space-y-4">
          <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 space-y-3">
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">
                Test sentences <span className="text-zinc-600">(one per line)</span>
              </label>
              <textarea
                dir="rtl"
                value={sentences}
                onChange={e => setSentences(e.target.value)}
                rows={8}
                className="w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-100 text-right placeholder-zinc-600 focus:outline-none focus:border-emerald-500 resize-none font-mono"
                style={{ fontFamily: "'Noto Sans Arabic', Arial, sans-serif" }}
              />
              <p className="text-xs text-zinc-600 text-right mt-0.5">{sentenceCount} sentences</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-zinc-400 mb-1">Language</label>
                <select
                  value={language}
                  onChange={e => setLanguage(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500"
                >
                  <option value="ar">Arabic</option>
                  <option value="fr">French</option>
                  <option value="en">English</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-zinc-400 mb-1">
                  Temperature: <span className="text-zinc-200">{temperature}</span>
                </label>
                <input
                  type="range" min={0.1} max={1.0} step={0.05} value={temperature}
                  onChange={e => setTemperature(Number(e.target.value))}
                  className="w-full mt-1 accent-emerald-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs text-zinc-400 mb-1">
                Checkpoint{' '}
                <span className="text-zinc-600">(empty = base XTTS v2)</span>
              </label>
              <select
                value={checkpointDir}
                onChange={e => setCheckpointDir(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1.5 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500"
              >
                <option value="">Base XTTS v2</option>
                {checkpoints.map(ck => (
                  <option key={ck.path} value={ck.path}>
                    {ck.run_id} ({ck.size_mb} MB)
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center justify-between pt-1">
              <p className="text-xs text-zinc-500">
                {totalPairs} audio sample{totalPairs !== 1 ? 's' : ''} to generate
              </p>
              <button
                onClick={startEval}
                disabled={starting || sentenceCount === 0}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
              >
                {starting ? 'Starting…' : 'Run Evaluation'}
              </button>
            </div>
          </div>
        </div>

        {/* ── Right: voice selector ── */}
        <div className="col-span-2">
          <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 space-y-2 h-full">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Voices</p>
              <button
                onClick={() => setSelectedVoices([])}
                className="text-xs text-zinc-500 hover:text-zinc-300"
              >
                All
              </button>
            </div>
            {voices.length === 0 ? (
              <p className="text-xs text-zinc-500 py-2">
                No voices found. Build a dataset first.
              </p>
            ) : (
              <div className="space-y-1 max-h-72 overflow-y-auto">
                {voices.map(v => {
                  const active = selectedVoices.length === 0 || selectedVoices.includes(v.id)
                  const selected = selectedVoices.includes(v.id)
                  return (
                    <label
                      key={v.id}
                      className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                        selected ? 'bg-emerald-900/30 border border-emerald-700/40' : 'hover:bg-zinc-700/40'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleVoice(v.id)}
                        className="accent-emerald-500"
                      />
                      <span className="text-xs text-zinc-300 truncate">{v.name}</span>
                      <span className="text-xs text-zinc-600 capitalize ml-auto">{v.source}</span>
                    </label>
                  )
                })}
              </div>
            )}
            <p className="text-xs text-zinc-600 pt-1">
              {selectedVoices.length === 0
                ? `${voices.length} voices (all)`
                : `${selectedVoices.length} selected`}
            </p>
          </div>
        </div>
      </div>

      {/* ── Jobs ── */}
      <div className="space-y-3">
        {jobs.length === 0 ? (
          <p className="text-sm text-zinc-500 py-2">No evaluation jobs yet.</p>
        ) : (
          jobs.map(job => (
            <div key={job.id}>
              <JobCard job={job} logs={logs} onCancel={cancelJob} />
              {job.status === 'completed' && (
                <button
                  onClick={() => handleViewResults(job.id)}
                  className={`mt-1 text-xs px-3 py-1 rounded transition-colors ${
                    selectedJobId === job.id
                      ? 'bg-emerald-800/50 text-emerald-300'
                      : 'bg-zinc-800 border border-zinc-700 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {selectedJobId === job.id ? 'Viewing results' : 'View results'}
                </button>
              )}
            </div>
          ))
        )}
      </div>

      {/* ── Results ── */}
      {loadingResults && (
        <p className="text-sm text-zinc-500">Loading results…</p>
      )}

      {summaries && summaries.length > 0 && (
        <div className="space-y-4">
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
            Summary — {selectedJobId}
          </p>
          <SpeakerSummaryTable summaries={summaries} />
        </div>
      )}

      {results && results.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
            Sample Results
          </p>
          <ResultsTable results={results} />
        </div>
      )}
    </div>
  )
}
