import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

const api = `http://localhost:${process.env.PORT ?? 3000}`

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist/client' },
  server: {
    port: 5173,
    // Keep the browser's Host header so the API's same-origin (CSRF) check sees the
    // origin the page was loaded from, whatever port Vite ended up on.
    proxy: {
      '/api': { target: api, changeOrigin: false },
      '/auth': { target: api, changeOrigin: false },
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
