// tests for the entry point's helpers; importing main.ts starts nothing.
import { describe, expect, it } from 'vitest'
import { openCommand } from './main'

describe('openCommand', () => {
  it('opens the page with xdg-open on linux and the url handler on windows', () => {
    const url = 'http://127.0.0.1:1337/'
    expect(openCommand(url, 'linux')).toEqual({ command: 'xdg-open', args: [url] })
    expect(openCommand(url, 'win32')).toEqual({ command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] })
  })
})
