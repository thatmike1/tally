// `usage-sample.py --codex-sync` against a stub rsync: each CODEX_SOURCES
// machine is copied into its own directory with its own status, an unreachable
// one fails alone, and the older single-source variable still works
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SCRIPT = resolve(__dirname, 'usage-sample.py')

/** a home and a PATH whose rsync logs its arguments and fails like ssh for host `laptop` */
function fakeMachine() {
  const home = mkdtempSync(join(tmpdir(), 'tally-codex-sources-'))
  const bin = join(home, 'bin')
  mkdirSync(bin)
  const log = join(home, 'rsync.log')
  writeFileSync(join(bin, 'rsync'), `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
for arg; do case "$arg" in laptop:*) echo "ssh: connect to host laptop: No route to host" >&2; exit 255;; esac; done
for arg; do last="$arg"; done
case "$last" in */) mkdir -p "$last"; touch "$last/copied";; *) echo '{}' > "$last";; esac
`)
  chmodSync(join(bin, 'rsync'), 0o755)
  const run = (env: Record<string, string>) =>
    spawnSync('python3', [SCRIPT, '--codex-sync'], { env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, ...env }, encoding: 'utf8' })
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [])
  const status = (name: string) => JSON.parse(readFileSync(join(home, '.cache', 'tally', 'codex-sources', name, 'status.json'), 'utf8'))
  return { home, run, calls, status }
}

describe('codex sources', () => {
  it('copies each machine into its own directory and lets an offline one fail alone', () => {
    const machine = fakeMachine()
    const result = machine.run({ CODEX_SOURCES: 'laptop=laptop, vps=root@vps.example', USAGE_UPSTREAM: 'root@vps.example' })
    expect(result.status).toBe(0)
    const sources = join(machine.home, '.cache', 'tally', 'codex-sources')
    expect(existsSync(join(sources, 'vps', 'sessions', 'copied'))).toBe(true)
    expect(existsSync(join(sources, 'vps', 'codex-usage.jsonl'))).toBe(true)
    expect(existsSync(join(sources, 'laptop', 'sessions', 'copied'))).toBe(false)
    expect(machine.status('vps')).toMatchObject({ name: 'vps', ok: true, meter: true })
    expect(machine.status('laptop')).toMatchObject({ name: 'laptop', ok: false, error: 'unreachable', lastOkAt: null })
    // an unreachable machine is not asked for its meter log, and with CODEX_SOURCES the legacy mirror stays off
    expect(machine.calls().filter((call) => call.includes('laptop:'))).toHaveLength(1)
    expect(machine.calls().some((call) => call.includes('codex-upstream'))).toBe(false)
    // nothing is ever deleted on this side
    expect(machine.calls().some((call) => call.includes('--delete'))).toBe(false)
  })

  it('keeps the last good copy time through a failure and ignores names that could escape the cache', () => {
    const machine = fakeMachine()
    machine.run({ CODEX_SOURCES: 'laptop=root@vps.example' })
    const firstOk = machine.status('laptop').lastOkAt
    expect(typeof firstOk).toBe('number')
    machine.run({ CODEX_SOURCES: 'laptop=laptop ../evil=root@vps.example' })
    expect(machine.status('laptop')).toMatchObject({ ok: false, lastOkAt: firstOk })
    expect(existsSync(join(machine.home, '.cache', 'tally', 'evil'))).toBe(false)
  })

  it('still mirrors the single upstream into codex-upstream when CODEX_SOURCES is unset', () => {
    const machine = fakeMachine()
    machine.run({ USAGE_UPSTREAM: 'root@vps.example' })
    expect(existsSync(join(machine.home, '.cache', 'tally', 'codex-upstream', 'copied'))).toBe(true)
    expect(existsSync(join(machine.home, '.cache', 'tally', 'codex-sources'))).toBe(false)
  })
})
