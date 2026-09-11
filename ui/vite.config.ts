import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const here = fileURLToPath(new URL('.', import.meta.url))

// root is ui/, /api goes to the tally server on 4190
export default defineConfig({
  root: here,
  plugins: [react()],
  server: {
    port: 5174,
    strictPort: false,
    proxy: { '/api': { target: 'http://127.0.0.1:4190', changeOrigin: false } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
})
