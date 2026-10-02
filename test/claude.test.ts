import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { account, configDirEnv, loginCommand } from '../src/claude.ts'
import { envFor, find } from '../src/harnesses.ts'
import { sharedAccount } from '../src/cli/doctor.ts'
import type { Config, Identity } from '../src/types.ts'

const write = (file: string, uuid: string, email: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: email } }))
}

// Claude Code: CLAUDE_CONFIG_DIR set (even to ~/.claude) is a separate login from unset
test('the default dir reads ~/.claude.json only — never the set-mode ~/.claude/.claude.json', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'barrito-claude-'))
  write(path.join(home, '.claude.json'), 'work-uuid', 'me@work.example')
  write(path.join(home, '.claude', '.claude.json'), 'home-uuid', 'me@home.example')
  assert.deepEqual(account(path.join(home, '.claude'), { home, env: {} }), { loggedIn: true, email: 'me@work.example', uuid: 'work-uuid' })
  fs.rmSync(path.join(home, '.claude.json'))
  assert.equal(account(path.join(home, '.claude'), { home, env: {} }).loggedIn, false)
})

test('a custom dir reads <dir>/.claude.json', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'barrito-claude-'))
  write(path.join(home, '.claude-personal', '.claude.json'), 'p', 'me@home.example')
  assert.equal(account(path.join(home, '.claude-personal'), { home, env: {} }).email, 'me@home.example')
})

test('the default dir unsets CLAUDE_CONFIG_DIR; any other dir sets it', () => {
  assert.equal(configDirEnv('/h/.claude', '/h'), '')
  assert.equal(configDirEnv('/h/.claude/', '/h'), '')
  assert.equal(configDirEnv('/h/.claude-personal', '/h'), '/h/.claude-personal')
  assert.equal(loginCommand('/h/.claude', (p) => p, '/h'), 'env -u CLAUDE_CONFIG_DIR claude')
  assert.equal(loginCommand('/h/.claude-personal', (p) => p.replace('/h', '~'), '/h'), 'CLAUDE_CONFIG_DIR=~/.claude-personal claude')
})

test('envFor never points the default identity at the hashed set-mode login', () => {
  const prev = process.env.BARRITO_HOME
  process.env.BARRITO_HOME = '/h'
  try {
    const id: Identity = { id: 'work', claude_config_dir: '/h/.claude', share_from: null, fallback: [], match: { remotes: [], paths: [] }, keychain: {} }
    const env = envFor(find('claude', null)!, id, { keychain: () => null })
    assert.equal(env.CLAUDE_CONFIG_DIR, '')
  } finally {
    if (prev === undefined) delete process.env.BARRITO_HOME
    else process.env.BARRITO_HOME = prev
  }
})

test('doctor fails when two identities resolve to one Claude account', () => {
  const ident = (id: string, dir: string): Identity => ({ id, claude_config_dir: dir, share_from: null, fallback: [], match: { remotes: [], paths: [] }, keychain: {} })
  const config = { identities: { work: ident('work', '/a'), personal: ident('personal', '/b') } } as unknown as Config
  const same = sharedAccount(config, () => ({ uuid: 'u', email: 'me@home.example' }))
  assert.equal(same?.level, 'fail')
  assert.match(same?.text ?? '', /work \+ personal share one Claude account \(me@home\.example\)/)
  assert.equal(sharedAccount(config, (dir) => ({ uuid: dir, email: null })), null)
})
