import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import api from '../api'

const STAGES = [
  { key: 'sources',      label: 'Sources',     link: '/sources',    unit: 'sources' },
  { key: 'videos',       label: 'Videos',      link: '/scrape',     unit: 'videos' },
  { key: 'clips',        label: 'Clips',       link: '/process',    unit: 'clips' },
  { key: 'transcribed',  label: 'Transcribed', link: '/transcribe', unit: 'clips' },
  { key: 'dataset_train',label: 'Dataset',     link: '/dataset',    unit: 'train' },
  { key: 'trained_runs', label: 'Trained',     link: '/train',      unit: 'runs' },
  { key: 'generated',    label: 'Generated',   link: '/synthesize', unit: 'files' },
]

function fmtNum(n) {
  if (n == null) return '—'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

function conversionCls(rate) {
  if (rate == null) return 'text-zinc-500'
  if (rate >= 0.8) return 'text-emerald-400'
  if (rate >= 0.5) return 'text-yellow-400'
  return 'text-red-400'
}

function PipelineFunnel({ pipeline }) {
  if (!pipeline) {
    return (
      <div className="flex items-center gap-1 overflow-x-auto py-2">
        {STAGES.map(s => (
          <div key={s.key} className="flex items-center gap-1 flex-shrink-0">
            <div className="bg-zinc-800 border border-zinc-700 rounded-lg p-3 w-28 text-center animate-pulse">
              <div className="h-3 bg-zinc-700 rounded mb-2" />
              <div className="h-6 bg-zinc-700 rounded" />
            </div>
            {s.key !== 'generated' && <span className="text-zinc-600 text-lg">›</span>}
          </div>
        ))}
      </div>
    )
  }

  const vals = STAGES.map(s => pipeline[s.key] ?? 0)

  return (
    <div className="flex items-stretch gap-1 overflow-x-auto py-2">
      {STAGES.map((stage, i) => {
        const val = vals[i]
        const prev = i > 0 ? vals[i - 1] : null
        const rate = prev != null && prev > 0 ? val / prev : null

        return (
          <div key={stage.key} className="flex items-center gap-1 flex-shrink-0">
            <Link to={stage.link} className="group block">
              <div className="bg-zinc-800 border border-zinc-700 group-hover:border-emerald-700/60 rounded-lg p-3 w-28 text-center transition-colors">
                <p className="text-xs text-zinc-500 mb-1 truncate">{stage.label}</p>
                <p className={`text-xl font-bold ${val > 0 ? 'text-zinc-100' : 'text-zinc-600'}`}>
                  {fmtNum(val)}
                </p>
                <p className="text-xs text-zinc-600 mt-0.5">{stage.unit}</p>
                {rate != null && (
                  <p className={`text-xs mt-1 font-mono ${conversionCls(rate)}`}>
                    {(rate * 100).toFixed(0)}%
                  </p>
                )}
              </div>
            </Link>
            {i < STAGES.length - 1 && (
              <span className="text-zinc-600 text-base flex-shrink-0">›</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

function StatCard({ title, value, sub, color = 'text-white' }) {
  return (
    <div className="bg-zinc-800 rounded-lg p-4 border border-zinc-700">
      <p className="text-xs text-zinc-500 uppercase tracking-wider mb-1">{title}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-zinc-500 mt-1">{sub}</p>}
    </div>
  )
}

export default function Dashboard() {
  const [gpu, setGpu] = useState(null)
  const [disk, setDisk] = useState(null)
  const [jobs, setJobs] = useState([])
  const [pipeline, setPipeline] = useState(null)

  useEffect(() => {
    const fetchAll = async () => {
      try {
        const [gRes, dRes, jRes, pRes] = await Promise.all([
          api.get('/monitor/gpu'),
          api.get('/monitor/disk'),
          api.get('/monitor/jobs'),
          api.get('/monitor/pipeline'),
        ])
        setGpu(gRes.data)
        setDisk(dRes.data)
        setJobs(jRes.data.jobs || [])
        setPipeline(pRes.data)
      } catch {}
    }
    fetchAll()
    const iv = setInterval(fetchAll, 10000)
    return () => clearInterval(iv)
  }, [])

  return (
    <div className="space-y-6 max-w-5xl">
      <h2 className="text-xl font-semibold text-zinc-100">Dashboard</h2>

      {/* Pipeline funnel */}
      <section>
        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
          Pipeline
        </h3>
        <PipelineFunnel pipeline={pipeline} />
        {pipeline && (
          <p className="text-xs text-zinc-600 mt-2">
            Conversion rate shown as % of previous stage · click any stage to go there
          </p>
        )}
      </section>

      {/* GPU */}
      <section>
        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">GPU</h3>
        {gpu?.available ? (
          <div className="grid grid-cols-4 gap-3">
            <StatCard title="Utilization" value={`${gpu.utilization}%`} color="text-emerald-400" />
            <StatCard
              title="VRAM"
              value={`${(gpu.memory_used_mb / 1024).toFixed(1)} GB`}
              sub={`of ${(gpu.memory_total_mb / 1024).toFixed(1)} GB`}
            />
            <StatCard
              title="Temperature"
              value={`${gpu.temperature}°C`}
              color={gpu.temperature > 80 ? 'text-red-400' : 'text-white'}
            />
            <StatCard title="GPU" value={gpu.name?.split(' ').slice(-2).join(' ')} />
          </div>
        ) : (
          <p className="text-zinc-500 text-sm">No GPU detected</p>
        )}
      </section>

      {/* Disk */}
      <section>
        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
          Disk Usage
        </h3>
        <div className="grid grid-cols-4 gap-3">
          {disk && Object.entries(disk)
            .filter(([k]) => !k.startsWith('_'))
            .map(([key, val]) => (
              <StatCard key={key} title={key} value={`${val.gb} GB`} />
            ))}
        </div>
        {disk && (
          <p className="text-xs text-zinc-500 mt-2">
            Free: {disk._total_free_gb} GB &nbsp;·&nbsp; Used: {disk._total_used_gb} GB
          </p>
        )}
      </section>

      {/* Recent jobs */}
      <section>
        <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
          Recent Jobs
        </h3>
        {jobs.length === 0 ? (
          <p className="text-zinc-500 text-sm">No jobs yet</p>
        ) : (
          <div className="space-y-2">
            {jobs.map(job => (
              <div
                key={job.id}
                className="bg-zinc-800 rounded-lg p-3 border border-zinc-700 flex items-center gap-4"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-zinc-300 capitalize">
                      {job.job_type.replace('_', ' ')}
                    </span>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      job.status === 'running'   ? 'bg-emerald-900/50 text-emerald-400' :
                      job.status === 'completed' ? 'bg-zinc-700 text-zinc-400' :
                      job.status === 'failed'    ? 'bg-red-900/50 text-red-400' :
                      'bg-zinc-700 text-zinc-400'
                    }`}>
                      {job.status}
                    </span>
                  </div>
                  {job.message && (
                    <p className="text-xs text-zinc-500 mt-0.5 truncate">{job.message}</p>
                  )}
                </div>
                <div className="w-24 flex-shrink-0">
                  <div className="h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-emerald-500 transition-all"
                      style={{ width: `${(job.progress || 0) * 100}%` }}
                    />
                  </div>
                  <p className="text-xs text-zinc-500 text-right mt-0.5">
                    {Math.round((job.progress || 0) * 100)}%
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
