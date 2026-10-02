// black-box e2e for `barrito ci`: spawn the real CLI against fake upstreams,
// then talk to the router as Claude Code would. Runs on macOS and Linux, uses a
// temp HOME and random ports — never touches the real HOME, Keychain, shims,
// LaunchAgents or port 4141.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isAlive } from '../../src/cli/serve.ts'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const bin = path.join(repo, 'bin', 'barrito.ts')
const fake = path.join(repo, 'test', 'e2e', 'fake-upstreams.ts')

interface Entry {
  method: string
  path: string
  headers: Record<string, string>
  model: string | null
}

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

const freePort = (): Promise<number> =>
  new Promise((done) => {
    const probe = http.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address()
      probe.close(() => done(typeof addr === 'object' && addr ? addr.port : 0))
    })
  })

const that = (ok: boolean, what: string): void => {
  if (!ok) throw new Error(`assertion failed: ${what}`)
}

const run = async (args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string; err: string }> =>
  new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [bin, ...args], { env, cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (d: Buffer) => { out += d })
    p.stderr.on('data', (d: Buffer) => { err += d })
    p.on('error', reject)
    p.on('close', (code) => resolve({ code: code ?? -1, out, err }))
  })

const main = async (): Promise<void> => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'barrito-e2e-'))
  const home = path.join(tmp, 'home')
  const runner = path.join(tmp, 'runner') // RUNNER_TEMP
  mkdirSync(home, { recursive: true })
  mkdirSync(runner, { recursive: true })
  const ciDir = path.join(runner, 'barrito') // where `barrito ci` puts everything
  const files = {
    githubEnv: path.join(tmp, 'github-env'),
    githubPath: path.join(tmp, 'github-path'),
    summary: path.join(tmp, 'step-summary.md'),
    log: path.join(ciDir, 'barrito.log'), // router stdout AND request log
    pid: path.join(ciDir, 'state', 'barrito.pid'),
  }

  const upstreamPort = await freePort()
  const port = await freePort()
  const up = `http://127.0.0.1:${upstreamPort}`
  const router = `http://127.0.0.1:${port}`

  const fakeUpstream = spawn(process.execPath, [fake, String(upstreamPort)], { stdio: ['ignore', 'ignore', 'inherit'] })
  let routerPid: number | null = null

  // the env a real runner gives `barrito ci`: temp HOME, RUNNER_TEMP, the
  // GITHUB_* files and the upstream overrides. NO BARRITO_CONFIG/STATE/LOG/
  // SHIMS/IDENTITY preset — the router must pick up its ci dirs from RUNNER_TEMP
  // (startDetached spreads process.env, so BARRITO_DIRECT/BARRITO_GATEWAY reach it)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    RUNNER_TEMP: runner,
    GITHUB_ACTIONS: 'true',
    GITHUB_ENV: files.githubEnv,
    GITHUB_PATH: files.githubPath,
    GITHUB_STEP_SUMMARY: files.summary,
    AI_GATEWAY_API_KEY: 'fake',
    BARRITO_DIRECT: up,
    BARRITO_GATEWAY: up,
  }

  try {
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${up}/__log`).then((r) => r.ok, () => false)) break
      await sleep(50)
    }
    that(await fetch(`${up}/__log`).then((r) => r.ok, () => false), 'fake upstream never answered')

    // ── start: `barrito ci` writes config + shims, exports GHA env, starts the router ──
    const start = await run(['ci', '--identity', 'ci', '--gateway-key', 'env:AI_GATEWAY_API_KEY', '--fallback', 'zai/glm-5.3', '--port', String(port)], env)
    that(start.code === 0, `barrito ci exited ${start.code}\nstdout:\n${start.out}\nstderr:\n${start.err}`)
    that(start.out.includes(`barrito ci ready · identity ci · fallback zai/glm-5.3 · http://127.0.0.1:${port}`), `ci ready line:\n${start.out}`)

    const pidRaw = (JSON.parse(readFileSync(files.pid, 'utf8')) as { pid?: unknown }).pid
    routerPid = typeof pidRaw === 'number' ? pidRaw : null
    that(routerPid != null, `pidfile had no pid: ${readFileSync(files.pid, 'utf8')}`)

    const githubEnv = readFileSync(files.githubEnv, 'utf8')
    that(githubEnv.includes(`BARRITO_CONFIG=${path.join(ciDir, 'config.toml')}`), `GITHUB_ENV BARRITO_CONFIG:\n${githubEnv}`)
    that(githubEnv.includes('BARRITO_IDENTITY=ci'), `GITHUB_ENV BARRITO_IDENTITY:\n${githubEnv}`)
    that(readFileSync(files.githubPath, 'utf8').includes(path.join(ciDir, 'shims')), `GITHUB_PATH shims:\n${readFileSync(files.githubPath, 'utf8')}`)
    that(existsSync(path.join(ciDir, 'shims', 'claude')), 'claude shim written')

    const entries = async (): Promise<Entry[]> => {
      const res = await fetch(`${up}/__log`)
      that(res.ok, `GET /__log → ${res.status}`)
      return JSON.parse(await res.text()) as Entry[]
    }
    const setDirect = async (mode: '200' | '429'): Promise<void> => {
      const res = await fetch(`${up}/__mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ direct: mode }) })
      that(res.ok, `POST /__mode ${mode} → ${res.status}`)
    }
    const waitFile = async (file: string, needle: string): Promise<void> => {
      for (let i = 0; i < 100; i++) {
        if (existsSync(file) && readFileSync(file, 'utf8').includes(needle)) return
        await sleep(50)
      }
      throw new Error(`${file} never contained "${needle}" — got:\n${existsSync(file) ? readFileSync(file, 'utf8') : '(missing)'}`)
    }
    // exactly what Claude Code sends: Max OAuth on the authorization header,
    // barrito's own identity header, and a gateway key that must never leak upstream
    const ask = (): Promise<Response> =>
      fetch(`${router}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          authorization: 'Bearer fake-max-oauth',
          'x-barrito-identity': 'ci',
          'x-ai-gateway-api-key': 'Bearer client-key-must-be-stripped',
        },
        body: JSON.stringify({ model: 'claude-sonnet-4.5', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'e2e' }] }),
      })

    // ── (a) direct 200: Max OAuth flows to Anthropic unchanged, nothing barrito-ish leaks ──
    const a = await ask()
    that(a.status === 200, `(a) direct status ${a.status}`)
    that(a.headers.get('x-barrito-tier') === 'max', `(a) tier header "${a.headers.get('x-barrito-tier')}"`)
    that((a.headers.get('content-type') ?? '').includes('text/event-stream'), `(a) direct hop is SSE`)
    await a.text()

    const afterA = await entries()
    const directHit = afterA.filter((e) => e.path === '/v1/messages')
    that(directHit.length === 1, `(a) direct hit count ${directHit.length}`)
    const d = directHit[0]!
    that(d.headers.authorization === 'Bearer fake-max-oauth', `(a) authorization forwarded byte-identical: "${d.headers.authorization}"`)
    that(!Object.keys(d.headers).some((k) => k.startsWith('x-barrito-')), `(a) no x-barrito-* upstream: ${Object.keys(d.headers).join(' ')}`)
    that(!('x-ai-gateway-api-key' in d.headers), '(a) no x-ai-gateway-api-key upstream')
    that(d.model === 'claude-sonnet-4.5', `(a) direct model "${d.model}"`)
    that(afterA.every((e) => e.path !== '/claude-code/v1/messages'), '(a) no gateway hop')

    // ── (b) direct 429 → same request falls back to the gateway, client still gets 200 ──
    await setDirect('429')
    const b = await ask()
    that(b.status === 200, `(b) fallback status ${b.status}`)
    const tier = b.headers.get('x-barrito-tier') ?? ''
    that(/^fallback:zai\/glm-5\.3; reason=quota; reset=\S+/.test(tier), `(b) tier header "${tier}"`)
    const bBody = JSON.parse(await b.text()) as { model?: string }
    that(bBody.model === 'claude-code/zai/glm-5.3', `(b) gateway body model "${bBody.model}"`)

    const afterB = await entries()
    const hop = afterB.filter((e) => e.path === '/claude-code/v1/messages')
    that(hop.length === 1, `(b) gateway hop count ${hop.length}`)
    const g = hop[0]!
    that(!('authorization' in g.headers), '(b) gateway hop carries no authorization (no Max OAuth leakage)')
    that(g.headers['x-ai-gateway-api-key'] === 'Bearer fake', `(b) gateway key header "${g.headers['x-ai-gateway-api-key']}"`)
    that(g.model === 'claude-code/zai/glm-5.3', `(b) fallback model "${g.model}"`)

    await waitFile(files.log, '::warning title=barrito::')
    const logText = readFileSync(files.log, 'utf8')
    that(logText.includes('::warning title=barrito::'), 'router log has the ::warning annotation')
    that(logText.includes('Max spent'), `router log has the quota transition:\n${logText}`)

    // nothing preset BARRITO_*: state and the request log must still land under
    // $RUNNER_TEMP/barrito — that is the whole point of `barrito ci` on a runner
    await waitFile(path.join(ciDir, 'state', 'tiers.json'), 'fallback')
    const tiers = JSON.parse(readFileSync(path.join(ciDir, 'state', 'tiers.json'), 'utf8')) as Record<string, { tier?: string }>
    that(tiers['ci']?.tier === 'fallback', `tiers.json under RUNNER_TEMP for ci: ${JSON.stringify(tiers)}`)
    await waitFile(files.log, 'POST /v1/messages')
    that(readFileSync(files.log, 'utf8').includes('POST /v1/messages'), 'request log under RUNNER_TEMP')

    // ── (c) /gateway proxy: the handle barrito:ci is swapped for the real key ──
    const c = await fetch(`${router}/gateway/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer barrito:ci' },
      body: JSON.stringify({ model: 'zai/glm-5.3', messages: [{ role: 'user', content: 'proxy' }] }),
    })
    that(c.status === 200, `(c) proxy status ${c.status}`)
    const cBody = JSON.parse(await c.text()) as { id?: string }
    that(cBody.id === 'chatcmpl_fake', `(c) proxy body passes through: ${JSON.stringify(cBody)}`)
    const afterC = await entries()
    const proxied = afterC.filter((e) => e.path === '/v1/chat/completions')
    that(proxied.length === 1, `(c) proxy hit count ${proxied.length}`)
    that(proxied[0]!.headers.authorization === 'Bearer fake', `(c) upstream sees the key, not the handle: "${proxied[0]!.headers.authorization}"`)

    // ── stop: step summary + teardown, and the router must actually be gone ──
    // a real runner applies $GITHUB_ENV to later steps — `ci stop` gets its
    // BARRITO_* dirs the same way, not from anything this test preset
    const stopEnv: NodeJS.ProcessEnv = {
      ...env,
      ...readFileSync(files.githubEnv, 'utf8').split('\n').reduce<Record<string, string>>((memo, line) => {
        const at = line.indexOf('=')
        if (at > 0) memo[line.slice(0, at)] = line.slice(at + 1)
        return memo
      }, {}),
    }
    const stop = await run(['ci', 'stop'], stopEnv)
    that(stop.code === 0, `barrito ci stop exited ${stop.code}\nstdout:\n${stop.out}\nstderr:\n${stop.err}`)
    that(stop.out.includes('| Identity | Tier | Max 5h | Max 7d | Resets | API today |'), `stop printed the markdown table:\n${stop.out}`)

    const summary = readFileSync(files.summary, 'utf8')
    that(summary.includes('| Identity | Tier | Max 5h | Max 7d | Resets | API today |'), `summary table:\n${summary}`)
    that(summary.includes('| ci |'), `summary row for ci:\n${summary}`)
    that(summary.includes('fell back to glm-5.3'), `summary fallback line:\n${summary}`)
    that(summary.includes('quota'), `summary reason:\n${summary}`)

    that(!existsSync(files.pid), 'pidfile removed')
    that(!isAlive(routerPid!), 'router process is gone')
    let answers = true
    try { answers = (await fetch(`${router}/health`)).ok } catch { answers = false }
    that(!answers, 'router port is closed')

    console.log('e2e ok — direct, quota fallback, gateway proxy, ci stop summary')
  } finally {
    fakeUpstream.kill('SIGKILL')
    if (routerPid != null) {
      try { process.kill(routerPid, 'SIGKILL') } catch { /* already gone */ }
    }
    rmSync(tmp, { recursive: true, force: true })
  }
}

main().catch((err: unknown) => {
  console.error(`e2e FAILED: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
