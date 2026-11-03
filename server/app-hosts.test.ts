import { serve } from '@hono/node-server'
import { request } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createApp } from './app'

const homes: string[] = []
afterEach(() => homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true })))

it('does not serve local session details through an attacker-controlled Host header', async () => {
  const home = mkdtempSync(join(tmpdir(), 'tally-host-review-'))
  homes.push(home)
  const project = join(home, '.claude', 'projects', '-synthetic')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, 'lead.jsonl'), JSON.stringify({
    type: 'assistant', timestamp: '2026-11-03T10:00:00Z',
    message: { id: 'synthetic-message', model: 'claude-opus-5-5', usage: { input_tokens: 100 } },
  }))
  const app = createApp({ home, recordLook: false })
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 })
  try {
    if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing TCP address')
    const get = (host: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: address.port, path: '/api/session/lead', headers: { Host: host } }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', reject)
      req.end()
    })
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect((await get(`${host}:${address.port}`)).status).toBe(200)
    }
    const untrusted = await get(`attacker.example:${address.port}`)
    expect(untrusted.status).toBe(403)
    expect(untrusted.body).not.toContain('synthetic-message')
    expect(untrusted.body).not.toContain('sessionId')
    for (const host of ['localhost.attacker.example', '127.0.0.1.attacker.example']) {
      expect((await get(`${host}:${address.port}`)).status).toBe(403)
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
