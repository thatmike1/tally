// tests for finding a command on linux and on windows, from either.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { codexBinaryPath } from './codex-usage'
import { executableNames, findExecutable, pathDirs, spawnTarget } from './which'

/** a filesystem that has exactly these files */
function disk(...files: string[]): (path: string) => boolean {
  const set = new Set(files)
  return (path) => set.has(path)
}

describe('findExecutable', () => {
  it('looks up the bare name on a colon PATH on linux', () => {
    const exists = disk('/usr/local/bin/agy')
    expect(findExecutable('agy', { platform: 'linux', env: { PATH: '/usr/bin:/usr/local/bin' }, exists })).toBe('/usr/local/bin/agy')
    expect(findExecutable('agy', { platform: 'linux', env: { PATH: '/usr/bin' }, exists })).toBeNull()
  })

  it('takes a linux command with a directory as written', () => {
    expect(findExecutable('./agy', { platform: 'linux', exists: disk('./agy') })).toBe('./agy')
  })

  it('tries the extensions on a semicolon Path on windows, whatever the variable is called', () => {
    const exists = disk('C:\\Users\\me\\.bun\\bin\\agy.exe')
    const env = { Path: 'C:\\Windows;C:\\Users\\me\\.bun\\bin' }
    expect(pathDirs(env, 'win32')).toEqual(['C:\\Windows', 'C:\\Users\\me\\.bun\\bin'])
    expect(findExecutable('agy', { platform: 'win32', env, exists })).toBe('C:\\Users\\me\\.bun\\bin\\agy.exe')
    // the bare name is not something windows runs
    expect(findExecutable('agy', { platform: 'win32', env, exists: disk('C:\\Windows\\agy') })).toBeNull()
  })

  it('finds a .cmd shim only for a caller that asks for one', () => {
    const exists = disk('C:\\npm\\codex.cmd')
    const env = { PATH: 'C:\\npm' }
    expect(findExecutable('codex', { platform: 'win32', env, exists })).toBeNull()
    expect(findExecutable('codex', { platform: 'win32', env, exists, extensions: ['.exe', '.cmd'] })).toBe('C:\\npm\\codex.cmd')
  })

  it('takes a windows path with or without its extension', () => {
    const exists = disk('D:\\tools\\agy.exe')
    expect(findExecutable('D:\\tools\\agy', { platform: 'win32', exists })).toBe('D:\\tools\\agy.exe')
    expect(findExecutable('D:\\tools\\agy.exe', { platform: 'win32', exists })).toBe('D:\\tools\\agy.exe')
    expect(executableNames('agy.EXE', 'win32')).toEqual(['agy.EXE'])
  })
})

describe('spawnTarget', () => {
  it('starts an exe directly and a shim through a quoted shell command', () => {
    expect(spawnTarget('C:\\bin\\codex.exe')).toEqual({ command: 'C:\\bin\\codex.exe', shell: false })
    expect(spawnTarget('C:\\Program Files\\npm\\codex.cmd')).toEqual({ command: '"C:\\Program Files\\npm\\codex.cmd"', shell: true })
    expect(spawnTarget('/usr/bin/codex')).toEqual({ command: '/usr/bin/codex', shell: false })
  })
})

describe('codexBinaryPath', () => {
  it('finds the codex bun installs under the home, as this platform names it', () => {
    const home = mkdtempSync(join(tmpdir(), 'tally-codex-home-'))
    expect(codexBinaryPath(home, { PATH: '' })).toBeNull()
    mkdirSync(join(home, '.bun', 'bin'), { recursive: true })
    const binary = join(home, '.bun', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex')
    writeFileSync(binary, '')
    expect(codexBinaryPath(home, { PATH: '' })).toBe(binary)
  })
})
