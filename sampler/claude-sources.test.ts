// named Claude mirrors retain their last good files when a machine sleeps
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('copies only JSONL, retains an offline mirror and throttles each source independently', () => {
  const home = mkdtempSync(join(tmpdir(), 'tally-claude-'))
  try {
    const bin = join(home, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'rsync'), `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/calls"
[ -e "$HOME/offline" ] && exit 255
for arg; do last="$arg"; done
mkdir -p "$last"
echo data > "$last/kept.jsonl"
`)
    chmodSync(join(bin, 'rsync'), 0o755)
    const run = (force = true) => spawnSync('python3', ['-c', `import runpy; m=runpy.run_path(${JSON.stringify(resolve('sampler/usage-sample.py'))}); m['sync_claude'](${force ? 'True' : 'False'})`], {
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, CLAUDE_SOURCES: 'laptop=laptop ../escape=bad' }, encoding: 'utf8',
    })
    expect(run().status).toBe(0)
    const root = join(home, '.cache/tally/claude-sources/laptop')
    const first = JSON.parse(readFileSync(join(root, 'status.json'), 'utf8'))
    expect(first.ok).toBe(true)
    writeFileSync(join(home, 'offline'), '')
    expect(run(false).status).toBe(0)
    expect(readFileSync(join(home, 'calls'), 'utf8').trim().split('\n')).toHaveLength(1)
    expect(run().status).toBe(0)
    expect(JSON.parse(readFileSync(join(root, 'status.json'), 'utf8'))).toMatchObject({ ok: false, lastOkAt: first.lastOkAt })
    expect(readFileSync(join(root, 'projects/kept.jsonl'), 'utf8')).toBe('data\n')
    const calls = readFileSync(join(home, 'calls'), 'utf8')
    expect(calls).toContain('--include=*.jsonl')
    expect(calls).toContain('laptop:.claude/projects/')
    expect(calls).not.toContain('--delete')
    expect(calls).not.toContain('--append-verify')
    expect(calls).not.toContain('codex')
    expect(existsSync(join(home, '.cache/tally/escape'))).toBe(false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
