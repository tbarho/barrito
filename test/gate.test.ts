import { test } from 'node:test'
import assert from 'node:assert/strict'
import { create } from '../src/router/gate.ts'
import { staleSocket } from '../src/router/gateway.ts'
import { jitter } from '../src/router/routes.ts'

const ctrl = () => new AbortController()

test('jitter never shortens the backoff and stays within 2×', () => {
  assert.equal(jitter(1000, () => 0), 1000)
  assert.equal(jitter(1000, () => 0.5), 1500)
  assert.equal(jitter(1000, () => 0.999), 1999)
})

test('only a dead keep-alive socket is an immediate retry', () => {
  assert.equal(staleSocket(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), true)
  assert.equal(staleSocket(Object.assign(new Error('closed'), { cause: { code: 'UND_ERR_SOCKET' } })), true)
  assert.equal(staleSocket(Object.assign(new Error('timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' })), false)
  assert.equal(staleSocket(Object.assign(new Error('h2'), { code: 'ERR_HTTP2_STREAM_ERROR' })), false)
  assert.equal(staleSocket(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })), false)
})

test('the gate caps in-flight work and sheds when the queue is full', async () => {
  const gate = create({ limit: 1, queue: 1, wait: 30 })
  const signal = ctrl().signal
  const first = await gate.acquire('personal', signal)
  assert.ok(first)
  const waiting = gate.acquire('personal', signal)
  const shed = await gate.acquire('personal', signal)
  assert.equal(shed, null)
  first()
  const second = await waiting
  assert.ok(second)
  second()
})

test('aborting a waiter does not hand it a slot', async () => {
  const gate = create({ limit: 1, queue: 2, wait: 5000 })
  const held = await gate.acquire('asf', ctrl().signal)
  assert.ok(held)
  const abort = ctrl()
  const waiting = gate.acquire('asf', abort.signal)
  abort.abort()
  assert.equal(await waiting, null)
  const next = await gate.acquire('asf', ctrl().signal)
  assert.equal(next, null) // the slot is still held
  held()
  const after = await gate.acquire('asf', ctrl().signal)
  assert.ok(after)
  after()
})

test('a waiter that sits past the deadline is shed, and the slot stays with the holder', async () => {
  const gate = create({ limit: 1, queue: 2, wait: 20 })
  const held = await gate.acquire('personal', ctrl().signal)
  assert.ok(held)
  const shed = await gate.acquire('personal', ctrl().signal)
  assert.equal(shed, null)
  held()
})
