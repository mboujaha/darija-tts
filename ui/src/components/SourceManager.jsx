import React, { useEffect, useState } from 'react'
import api from '../api'

const DIALECTS = ['casablanca', 'marrakech', 'north', 'east', 'south']
const SOURCE_TYPES = ['channel', 'playlist', 'video']

const inputCls = "bg-slate-900 border border-slate-600 rounded px-2 py-1 text-sm text-slate-100 focus:outline-none focus:border-emerald-500"
const btnPrimary = "px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium rounded transition-colors disabled:opacity-50"
const btnSecondary = "px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-200 text-sm font-medium rounded transition-colors"
const btnDanger = "px-3 py-1.5 bg-red-700 hover:bg-red-600 text-white text-sm font-medium rounded transition-colors"

const typeBadge = (t) => {
  const map = { channel: 'bg-blue-900/60 text-blue-300', playlist: 'bg-purple-900/60 text-purple-300', video: 'bg-slate-700 text-slate-300' }
  return `text-xs px-2 py-0.5 rounded font-medium ${map[t] || map.video}`
}

function AddSourceForm({ dialect, onAdded }) {
  const [form, setForm] = useState({ url: '', source_type: 'channel', max_videos: 50, notes: '' })
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')

  const submit = async (e) => {
    e.preventDefault()
    setSaving(true)
    setErr('')
    try {
      await api.post('/sources', { ...form, dialect })
      setForm({ url: '', source_type: 'channel', max_videos: 50, notes: '' })
      onAdded()
    } catch (e) {
      setErr(e.response?.data?.detail || e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="bg-slate-800/60 border border-slate-700 rounded-lg p-4 space-y-3">
      <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Add Source</p>
      {err && <p className="text-xs text-red-400">{err}</p>}
      <div className="flex gap-3">
        <input
          className={`${inputCls} flex-1`}
          placeholder="https://youtube.com/@channel or playlist URL"
          value={form.url}
          onChange={e => setForm(p => ({ ...p, url: e.target.value }))}
          required
        />
        <select className={inputCls} value={form.source_type} onChange={e => setForm(p => ({ ...p, source_type: e.target.value }))}>
          {SOURCE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div className="flex items-center gap-4">
        <label className="text-xs text-slate-400 whitespace-nowrap">Max videos: {form.max_videos}</label>
        <input
          type="range" min="1" max="500" step="1"
          className="flex-1 accent-emerald-500"
          value={form.max_videos}
          onChange={e => setForm(p => ({ ...p, max_videos: parseInt(e.target.value) }))}
        />
        <input
          type="number" min="1" max="500"
          className={`${inputCls} w-20`}
          value={form.max_videos}
          onChange={e => setForm(p => ({ ...p, max_videos: parseInt(e.target.value) || 1 }))}
        />
      </div>
      <textarea
        className={`${inputCls} w-full h-16 resize-none`}
        placeholder="Notes (optional)"
        value={form.notes}
        onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
      />
      <button type="submit" className={btnPrimary} disabled={saving}>
        {saving ? 'Adding…' : 'Add Source'}
      </button>
    </form>
  )
}

function SourceRow({ source, onUpdated, onDeleted }) {
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [form, setForm] = useState({ url: source.url, source_type: source.source_type, max_videos: source.max_videos, notes: source.notes || '' })
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      await api.put(`/sources/${source.id}`, form)
      setEditing(false)
      onUpdated()
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    await api.delete(`/sources/${source.id}`)
    onDeleted()
  }

  if (editing) {
    return (
      <tr className="border-t border-slate-700 bg-slate-800/40">
        <td className="px-3 py-2">
          <input className={`${inputCls} w-full`} value={form.url} onChange={e => setForm(p => ({ ...p, url: e.target.value }))} />
        </td>
        <td className="px-3 py-2">
          <select className={inputCls} value={form.source_type} onChange={e => setForm(p => ({ ...p, source_type: e.target.value }))}>
            {SOURCE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </td>
        <td className="px-3 py-2">
          <input type="number" className={`${inputCls} w-20`} value={form.max_videos} onChange={e => setForm(p => ({ ...p, max_videos: parseInt(e.target.value) || 1 }))} />
        </td>
        <td className="px-3 py-2">
          <input className={`${inputCls} w-full`} value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} />
        </td>
        <td className="px-3 py-2">
          <div className="flex gap-2">
            <button className={btnPrimary} onClick={save} disabled={saving}>{saving ? '…' : 'Save'}</button>
            <button className={btnSecondary} onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </td>
      </tr>
    )
  }

  return (
    <tr className="border-t border-slate-700 hover:bg-slate-800/30 transition-colors">
      <td className="px-3 py-2 text-sm text-slate-200 max-w-xs">
        <span title={source.url} className="truncate block">{source.url}</span>
      </td>
      <td className="px-3 py-2">
        <span className={typeBadge(source.source_type)}>{source.source_type}</span>
      </td>
      <td className="px-3 py-2 text-sm text-slate-300">{source.max_videos}</td>
      <td className="px-3 py-2 text-sm text-slate-400 max-w-xs">
        <span className="truncate block">{source.notes || '—'}</span>
      </td>
      <td className="px-3 py-2">
        {confirmDelete ? (
          <div className="flex gap-2 items-center">
            <span className="text-xs text-slate-400">Confirm delete?</span>
            <button className={btnDanger} onClick={remove}>Delete</button>
            <button className={btnSecondary} onClick={() => setConfirmDelete(false)}>No</button>
          </div>
        ) : (
          <div className="flex gap-2">
            <button className={btnSecondary} onClick={() => setEditing(true)}>Edit</button>
            <button className="px-3 py-1.5 bg-slate-800 hover:bg-red-900/40 text-slate-400 hover:text-red-400 text-sm rounded transition-colors" onClick={() => setConfirmDelete(true)}>Delete</button>
          </div>
        )}
      </td>
    </tr>
  )
}

export default function SourceManager() {
  const [activeTab, setActiveTab] = useState('casablanca')
  const [sources, setSources] = useState({})
  const [scraping, setScraping] = useState(false)
  const [scrapeMsg, setScrapeMsg] = useState('')

  const load = async () => {
    try {
      const r = await api.get('/sources')
      setSources(r.data.sources)
    } catch (e) {
      console.error(e)
    }
  }

  useEffect(() => { load() }, [])

  const scrapeDialect = async (dialect) => {
    setScraping(true)
    setScrapeMsg('')
    try {
      const r = await api.post('/scrape/start', dialect ? { dialect } : {})
      setScrapeMsg(`Job started: ${r.data.job_id}`)
    } catch (e) {
      setScrapeMsg('Failed to start scrape')
    } finally {
      setScraping(false)
      setTimeout(() => setScrapeMsg(''), 5000)
    }
  }

  const dialectSources = sources[activeTab] || []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-slate-100">Sources</h2>
        <div className="flex gap-2 items-center">
          {scrapeMsg && <span className="text-xs text-emerald-400 bg-emerald-900/30 px-3 py-1 rounded">{scrapeMsg}</span>}
          <button className={btnPrimary} onClick={() => scrapeDialect(activeTab)} disabled={scraping}>
            Scrape {activeTab}
          </button>
          <button className={btnSecondary} onClick={() => scrapeDialect(null)} disabled={scraping}>
            Scrape All
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-slate-700">
        {DIALECTS.map(d => (
          <button
            key={d}
            onClick={() => setActiveTab(d)}
            className={`px-4 py-2 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
              activeTab === d
                ? 'text-emerald-400 border-emerald-500'
                : 'text-slate-400 border-transparent hover:text-slate-200'
            }`}
          >
            {d}
            {sources[d]?.length > 0 && (
              <span className="ml-1.5 text-xs bg-slate-700 text-slate-300 px-1.5 py-0.5 rounded-full">{sources[d].length}</span>
            )}
          </button>
        ))}
      </div>

      {/* Source table */}
      <div className="bg-slate-800 border border-slate-700 rounded-lg overflow-hidden">
        {dialectSources.length === 0 ? (
          <div className="py-10 text-center text-slate-500 text-sm">No sources for {activeTab}. Add one below.</div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="bg-slate-800/80 text-xs text-slate-400 uppercase tracking-wider">
                <th className="px-3 py-2 text-left">URL</th>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-3 py-2 text-left">Max Videos</th>
                <th className="px-3 py-2 text-left">Notes</th>
                <th className="px-3 py-2 text-left">Actions</th>
              </tr>
            </thead>
            <tbody>
              {dialectSources.map(s => (
                <SourceRow key={s.id} source={s} onUpdated={load} onDeleted={load} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <AddSourceForm dialect={activeTab} onAdded={load} />
    </div>
  )
}
