import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: ['fm.cosumar.app', 'fm-api.cosumar.app'],
    proxy: {
      '/api': {
        target: 'http://backend:8000',
        autoRewrite: true,       // rewrite Location headers on redirects
        protocolRewrite: 'https', // force https in rewritten Location
      },
      '/ws': { target: 'ws://backend:8000', ws: true },
    },
  },
})
