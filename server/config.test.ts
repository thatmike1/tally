// the config loader: every key optional, nothing throws, nothing crashes the server.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { defaultConfig, defaultConfigPath, loadConfig } from './config'

/** writes `body` as the config file and gives back its path */
function configFile(body: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'tally-config-')), 'config.json')
  writeFileSync(path, body)
  return path
}

describe('loadConfig', () => {
  it('defaults every key when the file is not there', () => {
    expect(loadConfig(join(tmpdir(), 'tally-no-such-dir', 'config.json'))).toEqual(defaultConfig())
  })

  it('defaults every key the file leaves out', () => {
    expect(loadConfig(configFile('{}'))).toEqual(defaultConfig())
  })

  it('reads the whole schema', () => {
    const path = configFile(
      JSON.stringify({
        port: 1400,
        plan: { name: 'Max 20x', usdPerMonth: 200 },
        codexPlan: { name: 'ChatGPT Plus', usdPerMonth: 20 },
        agentsviewUrl: 'http://127.0.0.1:8080',
        takeaway: { command: 'agy', model: 'gemini-3.8-flash-low' },
        tray: {
          links: [{ name: 'bd-board', url: 'http://127.0.0.1:1338', unit: 'bd-board.service' }],
          toggles: [{ name: 'AgentsView', url: 'http://127.0.0.1:8080', unit: 'agentsview.service' }],
        },
      }),
    )
    expect(loadConfig(path)).toEqual({
      port: 1400,
      plan: { name: 'Max 20x', usdPerMonth: 200 },
      codexPlan: { name: 'ChatGPT Plus', usdPerMonth: 20 },
      agentsviewUrl: 'http://127.0.0.1:8080',
      takeaway: { command: 'agy', model: 'gemini-3.8-flash-low' },
      tray: {
        links: [{ name: 'bd-board', url: 'http://127.0.0.1:1338', unit: 'bd-board.service' }],
        toggles: [{ name: 'AgentsView', url: 'http://127.0.0.1:8080', unit: 'agentsview.service' }],
      },
    })
  })

  it('trims the trailing slash off the AgentsView url', () => {
    expect(loadConfig(configFile('{"agentsviewUrl":"http://127.0.0.1:8080/"}')).agentsviewUrl).toBe(
      'http://127.0.0.1:8080',
    )
  })

  it('says so once and keeps the defaults when the file is not json', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(loadConfig(configFile('{ port: 1337,'))).toEqual(defaultConfig())
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('keeps the default for a key of the wrong type', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const config = loadConfig(
      configFile(
        JSON.stringify({
          port: 'nine thousand',
          plan: { name: 42, usdPerMonth: -5 },
          agentsviewUrl: '',
          takeaway: { command: 'agy' },
          tray: { links: 'bd-board', toggles: [{ name: 'AgentsView' }] },
        }),
      ),
    )
    expect(config).toEqual(defaultConfig())
    warn.mockRestore()
  })

  it('takes a tray row with no unit; not everything is a service', () => {
    const config = loadConfig(configFile('{"tray":{"links":[{"name":"docs","url":"http://127.0.0.1:9000"}]}}'))
    expect(config.tray.links).toEqual([{ name: 'docs', url: 'http://127.0.0.1:9000', unit: null }])
  })
})

describe('defaultConfigPath', () => {
  it('sits under the home when XDG says nothing', () => {
    expect(defaultConfigPath({}, '/home/someone')).toBe('/home/someone/.config/tally/config.json')
  })

  it('follows XDG_CONFIG_HOME when it is set', () => {
    expect(defaultConfigPath({ XDG_CONFIG_HOME: '/tmp/xdg' }, '/home/someone')).toBe('/tmp/xdg/tally/config.json')
  })
})
