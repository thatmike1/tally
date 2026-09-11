#!/usr/bin/env node
// launcher: runs the typescript server through tsx, so a symlink into
// ~/.local/bin works from any directory.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(join(root, 'package.json'))
// resolve tsx out of this repo, not out of whatever directory the user is in
const loader = pathToFileURL(require.resolve('tsx')).href
const entry = join(root, 'server', 'main.ts')

const child = spawn(process.execPath, ['--import', loader, entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
})

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
