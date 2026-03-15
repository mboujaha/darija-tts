// API base URL for axios (HTTP/HTTPS)
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api'

// WebSocket URL for live job updates
export const WS_JOBS_URL = import.meta.env.VITE_WS_JOBS_URL ||
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/jobs`
