// bundles `codex-meter.ts` and the server code it imports into one file that
// runs on a bare node 22, so the VPS needs no checkout and no node_modules
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const root = fileURLToPath(new URL('..', import.meta.url))

export default defineConfig({
  root,
  logLevel: 'warn',
  ssr: { noExternal: true, target: 'node' },
  build: {
    ssr: 'sampler/codex-meter.ts',
    outDir: 'dist',
    emptyOutDir: false,
    target: 'node22',
    minify: false,
    rollupOptions: { output: { entryFileNames: 'codex-meter.mjs', format: 'es' } },
  },
})
