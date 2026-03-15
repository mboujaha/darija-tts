import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: ['fm.cosumar.app', 'fm-api.cosumar.app'],
    proxy: {
      '/api': process.env.VITE_API_URL || 'http://backend:8000',
      '/ws': {
        target: process.env.VITE_WS_URL || 'ws://backend:8000',
        ws: true,
      },
    },
  },
})
