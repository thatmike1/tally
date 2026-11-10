import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// the tests price against a frozen models.json, never this machine's checkout or the network
export default defineConfig({
  test: {
    env: {
      TALLY_MODELS: resolve(import.meta.dirname, 'test/fixtures/models.json'),
      TALLY_MODELS_URL: '',
      TALLY_MODELS_CACHE: join(tmpdir(), `tally-test-models-${process.pid}.json`),
    },
  },
})
