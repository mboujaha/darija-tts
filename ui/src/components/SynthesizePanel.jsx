import React, { useEffect, useRef, useState } from 'react'
import api from '../api'

const LANGUAGES = [
  { value: 'ar', label: 'Arabic (Darija)' },
  { value: 'fr', label: 'French' },
  { value: 'en', label: 'English' },
]

// ── Streaming audio queue player ────────────────────────────────
function StreamPlayer({ chunks }) {
  const audioRef = useRef(null)
  const queueRef = useRef([])
  const playingRef = useRef(false)

  useEffect(() => {
    queueRef.current = chunks.filter(c => c.url && !c.error)
    if (!playingRef.current) tryPlayNext()
  }, [chunks])

  const tryPlayNext = () => {
    const el = audioRef.current
    if (!el || queueRef.current.length === 0) { playingRef.current = false; return }
    playingRef.current = true
    const next = queueRef.current.shift()
    el.src = next.url
    el.play().catch(() => tryPlayNext())
  }

  if (chunks.length === 0) return null

  const done = chunks.filter(c => c.url || c.error).length
  const total = chunks.length
  const errCount = chunks.filter(c => c.error).length

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <div className="flex-1 bg-zinc-900 rounded-full h-1.5">
          <div
            className="h-1.5 rounded-full bg-emerald-500 transition-all"
            style={{ width: total > 0 ? `${(done / total) * 100}%` : '0%' }}
          />
        </div>
        <span className="text-xs text-zinc-400 flex-shrink-0">{done}/{total} chunks</span>
        {errCount > 0 && <span className="text-xs text-red-400">{errCount} errors</span>}
      </div>
      <audio
        ref={audioRef}
        controls
        className="w-full h-10"
        onEnded={tryPlayNext}
      />
      <div className="space-y-1 max-h-32 overflow-y-auto">
        {chunks.map((c, i) => (
          <div key={i} className={`text-xs flex items-center gap-2 ${c.error ? 'text-red-400' : c.url ? 'text-emerald-400' : 'text-zinc-500'}`}>
            <span className="w-4 text-right flex-shrink-0">{i + 1}.</span>
            <span
              dir="rtl"
              className="flex-1 truncate text-right"
              style={{ fontFamily: "'Noto Sans Arabic', Arial, sans-serif" }}
            >
              {c.sentence}
            </span>
            {c.url && !c.error && (
              <span className="flex-shrink-0 font-mono">{c.duration?.toFixed(1)}s</span>
            )}
            {c.error && <span className="flex-shrink-0 truncate max-w-24" title={c.error}>err</span>}
            {!c.url && !c.error && (
              <span className="flex-shrink-0 animate-pulse">…</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

export default function SynthesizePanel() {
  const [text, setText] = useState('')
  const [voices, setVoices] = useState([])
  const [checkpoints, setCheckpoints] = useState([])
  const [speakerId, setSpeakerId] = useState('')
  const [checkpointDir, setCheckpointDir] = useState('')
  const [language, setLanguage] = useState('ar')
  const [temperature, setTemperature] = useState(0.65)
  const [speed, setSpeed] = useState(1.0)
  const [gptCondLen, setGptCondLen] = useState(6)
  const [streamMode, setStreamMode] = useState(false)

  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)     // latest generation result (non-stream)
  const [streamChunks, setStreamChunks] = useState([])  // streaming chunks
  const [history, setHistory] = useState([])
  const audioRef = useRef(null)

  const loadVoices = async () => {
    try {
      const r = await api.get('/synthesize/voices')
      const v = r.data.voices || []
      setVoices(v)
      if (v.length > 0 && !speakerId) setSpeakerId(v[0].id)
    } catch (e) {}
  }

  const loadCheckpoints = async () => {
    try {
      const r = await api.get('/synthesize/checkpoints')
      setCheckpoints(r.data.checkpoints || [])
    } catch (e) {}
  }

  const loadHistory = async () => {
    try {
      const r = await api.get('/synthesize/generated')
      setHistory(r.data.items || [])
    } catch (e) {}
  }

  useEffect(() => {
    loadVoices()
    loadCheckpoints()
    loadHistory()
  }, [])

  const generate = async () => {
    if (!text.trim()) { setError('Enter some text first.'); return }
    if (!speakerId) { setError('Select a speaker voice.'); return }
    setError('')

    if (streamMode) {
      await generateStream()
    } else {
      await generateSingle()
    }
  }

  const generateSingle = async () => {
    setGenerating(true)
    try {
      const body = {
        text: text.trim(),
        speaker_id: speakerId,
        language,
        temperature,
        speed,
        gpt_cond_len: gptCondLen,
      }
      if (checkpointDir) body.checkpoint_dir = checkpointDir
      const r = await api.post('/synthesize/generate', body)
      setResult(r.data)
      setStreamChunks([])
      setHistory(prev => [{
        filename: r.data.filename,
        url: r.data.url,
        duration: r.data.duration,
        created_at: Date.now() / 1000,
      }, ...prev].slice(0, 30))
      setTimeout(() => audioRef.current?.play(), 100)
    } catch (e) {
      const detail = e.response?.data?.detail || e.message || 'Generation failed'
      setError(detail)
    } finally {
      setGenerating(false)
    }
  }

  const generateStream = async () => {
    setGenerating(true)
    setResult(null)
    setStreamChunks([])
    try {
      const body = {
        text: text.trim(),
        speaker_id: speakerId,
        language,
        temperature,
        speed,
        gpt_cond_len: gptCondLen,
      }
      if (checkpointDir) body.checkpoint_dir = checkpointDir

      const response = await fetch('/api/synthesize/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!response.ok) {
        const err = await response.json().catch(() => ({}))
        setError(err.detail || 'Stream failed')
        return
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()   // keep incomplete last line

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const data = JSON.parse(line.slice(6))
            if (data.done) break
            setStreamChunks(prev => {
              const next = [...prev]
              next[data.index] = data
              return next
            })
            // Add completed chunks to history
            if (data.url && !data.error) {
              setHistory(h => [{
                filename: data.url.split('/').pop(),
                url: data.url,
                duration: data.duration,
                created_at: Date.now() / 1000,
              }, ...h].slice(0, 30))
            }
          } catch {}
        }
      }
    } catch (e) {
      setError(e.message || 'Stream failed')
    } finally {
      setGenerating(false)
    }
  }

  const deleteGenerated = async (filename) => {
    try {
      await api.delete(`/synthesize/generated/${filename}`)
      setHistory(prev => prev.filter(h => h.filename !== filename))
      if (result?.filename === filename) setResult(null)
    } catch (e) {}
  }

  const unloadModel = async () => {
    try {
      await api.post('/synthesize/unload-model')
    } catch (e) {}
  }

  const fmtDur = (s) => s != null ? `${s.toFixed(1)}s` : '—'
  const fmtTime = (ts) => {
    if (!ts) return ''
    const d = new Date(ts * 1000)
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-zinc-100">Synthesize</h2>
        <button
          onClick={unloadModel}
          title="Free model from GPU/CPU memory"
          className="text-xs px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          Unload Model
        </button>
      </div>

      <div className="grid grid-cols-5 gap-4">
        {/* ── Left: config + text input ── */}
        <div className="col-span-3 space-y-4">
          {/* Text input */}
          <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 space-y-3">
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">Text to synthesize</label>
              <textarea
                dir="rtl"
                value={text}
                onChange={e => setText(e.target.value)}
                rows={5}
                placeholder="اكتب النص هنا…"
                className="w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-100 text-right placeholder-zinc-600 focus:outline-none focus:border-emerald-500 resize-none"
                style={{ fontFamily: "'Noto Sans Arabic', Arial, sans-serif", fontSize: '1.05rem', lineHeight: '1.8' }}
              />
              <p className="text-xs text-zinc-600 text-right mt-1">{text.length} chars</p>
            </div>

            {/* Language */}
            <div>
              <label className="block text-xs font-medium text-zinc-400 mb-1">Language</label>
              <select
                value={language}
                onChange={e => setLanguage(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-emerald-500"
              >
                {LANGUAGES.map(l => (
                  <option key={l.value} value={l.value}>{l.label}</option>
                ))}
              </select>
            </div>

            {/* Stream mode toggle */}
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={streamMode}
                onChange={e => setStreamMode(e.target.checked)}
                className="accent-emerald-500 w-4 h-4"
              />
              <span className="text-sm text-zinc-300">Stream mode</span>
              <span className="text-xs text-zinc-500">
                (splits into sentences, plays each as it's ready)
              </span>
            </label>

            {error && (
              <p className="text-xs text-red-400 bg-red-950/40 border border-red-900/40 rounded px-3 py-2">
                {error}
              </p>
            )}

            <button
              onClick={generate}
              disabled={generating}
              className="w-full px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded transition-colors disabled:opacity-50 disabled:cursor-wait"
            >
              {generating ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  {streamMode ? 'Streaming…' : 'Generating…'}
                </span>
              ) : streamMode ? 'Stream Speech' : 'Generate Speech'}
            </button>
          </div>

          {/* Stream player */}
          {streamMode && streamChunks.length > 0 && (
            <div className="bg-zinc-800 border border-emerald-800/50 rounded-lg p-4 space-y-3">
              <p className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">
                Streaming Output
              </p>
              <StreamPlayer chunks={streamChunks} />
            </div>
          )}

          {/* Single result player */}
          {!streamMode && result && (
            <div className="bg-zinc-800 border border-emerald-800/50 rounded-lg p-4 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">Output</p>
                <span className="text-xs text-zinc-500 font-mono">{fmtDur(result.duration)}</span>
              </div>
              <audio
                ref={audioRef}
                key={result.url}
                controls
                src={result.url}
                className="w-full h-10"
              />
              <p
                dir="rtl"
                className="text-sm text-zinc-300 text-right border-t border-zinc-700 pt-2"
                style={{ fontFamily: "'Noto Sans Arabic', Arial, sans-serif" }}
              >
                {result.text}
              </p>
              <div className="flex gap-3 text-xs text-zinc-500">
                <span>Speaker: {result.speaker_id}</span>
                {result.checkpoint_used && result.checkpoint_used !== 'base' && (
                  <span className="truncate">Checkpoint: {result.checkpoint_used}</span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── Right: voice + model settings ── */}
        <div className="col-span-2 space-y-4">
          {/* Voice selector */}
          <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 space-y-3">
            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Voice</p>
            {voices.length === 0 ? (
              <p className="text-xs text-zinc-500">
                No voices found. Build a dataset first to populate speaker_wavs.
              </p>
            ) : (
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {voices.map(v => (
                  <button
                    key={v.id}
                    onClick={() => setSpeakerId(v.id)}
                    className={`w-full text-left px-3 py-2 rounded text-sm transition-colors ${
                      speakerId === v.id
                        ? 'bg-emerald-900/50 text-emerald-300 border border-emerald-700/50'
                        : 'bg-zinc-900/50 text-zinc-300 hover:bg-zinc-700/50'
                    }`}
                  >
                    <span className="block font-medium truncate">{v.name}</span>
                    <span className="text-xs text-zinc-500 capitalize">{v.source}</span>
                  </button>
                ))}
              </div>
            )}
            <button
              onClick={loadVoices}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              Refresh voices
            </button>
          </div>

          {/* Checkpoint */}
          <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 space-y-2">
            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Model</p>
            <div>
              <label className="block text-xs text-zinc-500 mb-1">
                Fine-tuned checkpoint{' '}
                <span className="text-zinc-600">(leave empty for base XTTS v2)</span>
              </label>
              <select
                value={checkpointDir}
                onChange={e => setCheckpointDir(e.target.value)}
                className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-emerald-500"
              >
                <option value="">Base XTTS v2 (auto-download)</option>
                {checkpoints.map(ck => (
                  <option key={ck.path} value={ck.path}>
                    {ck.run_id} ({ck.size_mb} MB)
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Generation params */}
          <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-4 space-y-3">
            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Parameters</p>

            <div>
              <label className="block text-xs text-zinc-400 mb-1">
                Temperature: <span className="text-zinc-200">{temperature}</span>
              </label>
              <input
                type="range" min={0.1} max={1.0} step={0.05} value={temperature}
                onChange={e => setTemperature(Number(e.target.value))}
                className="w-full accent-emerald-500"
              />
              <div className="flex justify-between text-xs text-zinc-600 mt-0.5">
                <span>stable</span><span>creative</span>
              </div>
            </div>

            <div>
              <label className="block text-xs text-zinc-400 mb-1">
                Speed: <span className="text-zinc-200">{speed.toFixed(2)}×</span>
              </label>
              <input
                type="range" min={0.5} max={2.0} step={0.05} value={speed}
                onChange={e => setSpeed(Number(e.target.value))}
                className="w-full accent-emerald-500"
              />
              <div className="flex justify-between text-xs text-zinc-600 mt-0.5">
                <span>slow</span><span>fast</span>
              </div>
            </div>

            <div>
              <label className="block text-xs text-zinc-400 mb-1">
                Reference length: <span className="text-zinc-200">{gptCondLen}s</span>
              </label>
              <input
                type="range" min={3} max={12} step={1} value={gptCondLen}
                onChange={e => setGptCondLen(Number(e.target.value))}
                className="w-full accent-emerald-500"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Generation history */}
      {history.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">History</p>
          <div className="bg-zinc-800 border border-zinc-700 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-zinc-400 bg-zinc-800 border-b border-zinc-700">
                  <th className="px-3 py-2">Time</th>
                  <th className="px-3 py-2">Audio</th>
                  <th className="px-3 py-2">Duration</th>
                  <th className="px-3 py-2 w-8" />
                </tr>
              </thead>
              <tbody className="bg-zinc-900/40 divide-y divide-zinc-700">
                {history.map(item => (
                  <tr key={item.filename} className="hover:bg-zinc-800/50">
                    <td className="px-3 py-2 text-xs text-zinc-500 font-mono whitespace-nowrap">
                      {fmtTime(item.created_at)}
                    </td>
                    <td className="px-3 py-2">
                      <audio controls src={item.url} className="h-7 w-48" preload="none" />
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-400 font-mono">
                      {fmtDur(item.duration)}
                    </td>
                    <td className="px-3 py-2">
                      <button
                        onClick={() => deleteGenerated(item.filename)}
                        className="text-xs text-zinc-600 hover:text-red-400 transition-colors"
                        title="Delete"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
