import React, { useEffect, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import api from '../api'

const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard', icon: '⬡' },
  { to: '/sources', label: 'Sources', icon: '📡' },
  { to: '/scrape', label: 'Scrape', icon: '⬇' },
  { to: '/process', label: 'Process', icon: '⚙' },
  { to: '/transcribe', label: 'Transcribe', icon: '✍' },
  { to: '/dataset', label: 'Dataset', icon: '📦' },
  { to: '/train', label: 'Train', icon: '🧠' },
  { to: '/synthesize', label: 'Synthesize', icon: '🔊' },
  { to: '/evaluate', label: 'Evaluate', icon: '📊' },
  { to: '/export', label: 'Export', icon: '⬆' },
  { to: '/settings', label: 'Settings', icon: '⚙' },
]

function GPUBadge({ gpu }) {
  if (!gpu?.available) return (
    <span className="text-xs text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded">No GPU</span>
  )
  const pct = gpu.utilization
  const memPct = Math.round((gpu.memory_used_mb / gpu.memory_total_mb) * 100)
  return (
    <div className="flex items-center gap-2 text-xs text-zinc-300">
      <span className="text-emerald-400">{gpu.name?.split(' ').slice(-1)[0]}</span>
      <span>{pct}%</span>
      <span className="text-zinc-500">|</span>
      <span>{(gpu.memory_used_mb / 1024).toFixed(1)}/{(gpu.memory_total_mb / 1024).toFixed(1)}GB</span>
      <span className="text-zinc-500">|</span>
      <span className={gpu.temperature > 80 ? 'text-red-400' : 'text-zinc-300'}>{gpu.temperature}°C</span>
    </div>
  )
}

export default function Layout() {
  const [gpu, setGpu] = useState(null)

  useEffect(() => {
    const fetchGpu = () => api.get('/monitor/gpu').then(r => setGpu(r.data)).catch(() => {})
    fetchGpu()
    const iv = setInterval(fetchGpu, 5000)
    return () => clearInterval(iv)
  }, [])

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-950">
      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 bg-zinc-900 border-r border-zinc-800 flex flex-col">
        <div className="px-4 py-4 border-b border-zinc-800">
          <h1 className="text-lg font-bold text-emerald-400 tracking-tight">Darija TTS</h1>
          <p className="text-xs text-zinc-500 mt-0.5">Arabic Dialect Pipeline</p>
        </div>
        <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
          {NAV_ITEMS.map(({ to, label, icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors ${
                  isActive
                    ? 'bg-emerald-900/40 text-emerald-400 font-medium'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                }`
              }
            >
              <span className="text-base w-4 text-center">{icon}</span>
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="h-12 bg-zinc-900 border-b border-zinc-800 flex items-center justify-between px-4 flex-shrink-0">
          <div />
          <GPUBadge gpu={gpu} />
        </header>

        {/* Content */}
        <main className="flex-1 overflow-y-auto p-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
