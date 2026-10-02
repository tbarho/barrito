import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import * as catalog from '../src/catalog.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/catalog.json', import.meta.url), 'utf8')).data

const memfs = (files = new Map<string, string>()) => {
  const write = (file: string, body: string) => files.set(file, body)
  return {
    mkdir: async (): Promise<void> => {},
    writeFile: async (file: string, body: string): Promise<void> => { write(file, body) },
    rename: async (from: string, to: string): Promise<void> => { write(to, files.get(from) as string) },
    existsSync: (file: string): boolean => files.has(file),
    readFileSync: (file: string): string => files.get(file) as string,
    files,
  }
}

const seen: { url?: unknown; headers?: Record<string, string> } = {}
const okFetch = (bodies: unknown[] = []) =>
  async (url: string, { headers }: { headers?: Record<string, string> } = {}) => {
    seen.url = url
    seen.headers = headers
    return { ok: true, json: async () => ({ data: bodies.shift() ?? fixture }) }
  }

test('refresh fetches the gateway catalog and caches it atomically', async () => {
  const fs = memfs()
  const models = await catalog.refresh({ fetch: okFetch(), fs, statePath: '/state' })
  assert.equal(models, fixture)
  assert.equal(seen.url, 'https://ai-gateway.vercel.sh/v1/models')
  assert.deepEqual(seen.headers, {})
  const cache = JSON.parse(fs.files.get('/state/catalog.json')!)
  assert.equal(cache.fetchedAt > 0, true)
  assert.equal(cache.data.length, fixture.length)
})

test('refresh sends the bearer key when given and tolerates no key', async () => {
  const fs = memfs()
  await catalog.refresh({ fetch: okFetch(), fs, key: 'secret', statePath: '/state' })
  assert.equal(seen.headers?.authorization, 'Bearer secret')
  await catalog.refresh({ fetch: okFetch(), fs, statePath: '/state' })
  assert.equal(seen.headers?.authorization, undefined)
})

test('refresh rejects non-ok responses and bad payloads', async () => {
  const bad = async () => ({ ok: false, status: 500, json: async () => ({}) })
  await assert.rejects(catalog.refresh({ fetch: bad, fs: memfs(), statePath: '/state' }), /500/)
  const weird = async () => ({ ok: true, json: async () => ({ data: { no: 1 } }) })
  await assert.rejects(catalog.refresh({ fetch: weird, fs: memfs(), statePath: '/state' }), /unexpected payload/)
})

test('cached returns null when missing, stale, or corrupt', () => {
  assert.equal(catalog.cached({ statePath: '/state' }), null)
  const fs = memfs()
  fs.files.set('/state/catalog.json', JSON.stringify({ fetchedAt: Date.now() - 86400e3 - 1, data: fixture }))
  assert.equal(catalog.cached({ statePath: '/state', fs }), null)
  fs.files.set('/state/catalog.json', '{nope')
  assert.equal(catalog.cached({ statePath: '/state', fs }), null)
})

test('cached returns models within maxAge', () => {
  const fs = memfs()
  const fetchedAt = Date.now() - 3600e3
  fs.files.set('/state/catalog.json', JSON.stringify({ fetchedAt, data: fixture }))
  assert.deepEqual(catalog.cached({ statePath: '/state', fs }), fixture)
  assert.equal(catalog.cached({ statePath: '/state', fs, maxAge: 60e3 }), null)
  assert.deepEqual(catalog.cached({ statePath: '/state', fs, now: fetchedAt + 10 }), fixture)
})

test('cached keeps only rows with string id/name/type', () => {
  const fs = memfs()
  const good = { id: 'zai/glm-5.3', name: 'GLM 5.3', type: 'language' }
  const rows = [good, { id: 1, name: 'x', type: 'language' }, { id: 'a/b', type: 'language' }, 'junk', null]
  fs.files.set('/state/catalog.json', JSON.stringify({ fetchedAt: Date.now(), data: rows }))
  assert.deepEqual(catalog.cached({ statePath: '/state', fs }), [good])
  assert.deepEqual(catalog.last({ statePath: '/state', fs })?.data, [good])
})

test('price strips claude-code/ and [1m], returns per-token numbers', () => {
  assert.deepEqual(catalog.price(fixture, 'claude-code/zai/glm-5.3[1m]'), {
    input: 0.0000014,
    output: 0.0000044,
    input_cache_read: 0.00000014,
  })
  assert.equal(catalog.price(fixture, 'deepseek/deepseek-v4.1-flash')?.input, 0.0000003)
  assert.equal(catalog.price(fixture, 'nope/never'), null)
  assert.equal(catalog.price(fixture, 'meta/muse-image-1.0'), null)
})

test('bare strips prefixes and suffixes', () => {
  assert.equal(catalog.bare('claude-code/zai/glm-5.3[1m]'), 'zai/glm-5.3')
  assert.equal(catalog.bare('zai/glm-5.3'), 'zai/glm-5.3')
})

test('refresh uses the injected clock and can skip writing the cache', async () => {
  const kept = memfs()
  const models = await catalog.refresh({ fetch: okFetch(), fs: kept, statePath: '/state', now: () => 123 })
  assert.equal(models, fixture)
  assert.equal(kept.files.has('/state/catalog.json'), true)
  assert.equal(JSON.parse(kept.files.get('/state/catalog.json')!).fetchedAt, 123)

  const memory = memfs()
  const fresh = await catalog.refresh({ fetch: okFetch(), fs: memory, statePath: '/state', write: false, now: () => 456 })
  assert.equal(fresh, fixture)
  assert.equal(memory.files.has('/state/catalog.json'), false)
})

test('cached stale: true returns old data; last returns the cache itself', () => {
  const fs = memfs()
  const cache = { fetchedAt: Date.now() - 30 * 86400e3, data: fixture }
  fs.files.set('/state/catalog.json', JSON.stringify(cache))
  assert.equal(catalog.cached({ statePath: '/state', fs }), null)
  assert.deepEqual(catalog.cached({ statePath: '/state', fs, stale: true }), fixture)
  assert.deepEqual(catalog.last({ statePath: '/state', fs }), cache)
  assert.equal(catalog.last({ statePath: '/nowhere', fs }), null)
})
