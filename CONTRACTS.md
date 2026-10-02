# barrito — module contracts

Every module codes against these signatures. Do not change a signature you don't own; if you need one changed, say so in your report.
Full product spec: `docs/plan.html`.

## Style (mandatory)

- Strict TypeScript (`tsconfig.json`: strict, noUncheckedIndexedAccess, erasableSyntaxOnly, verbatimModuleSyntax), Node >= 22.18 runs `.ts` directly; `tsc -p tsconfig.build.json` emits `dist/` for npm.
- Shared shapes live in `src/types.ts` — `import type { … } from './types.ts'`. Type every exported function's params and return. No `any`; use `unknown` + narrowing at boundaries (JSON.parse, fetch, TOML). Erasable syntax only: no `enum`, `namespace`, parameter properties. Relative imports use the `.ts` extension.
- Templates and package files are located via `root()` from `src/paths.ts` (package root), never `../templates` relative to `import.meta.url` (breaks in `dist/`).
- Minimal names: `snooze()` not `handleSnoozeAction()`.
- Guard clauses / early return. No nested `if`. No `else` unless unavoidable.
- Prefer `.reduce((memo, item) => …)` over `for` loops.
- DRY. Comments only when absolutely necessary.
- Package manager: yarn. Tests: `node:test` + `node:assert/strict`, files `test/<module>.test.ts`, run with `yarn verify` (typecheck + `node --test 'test/*.test.ts'`). Full `barrito ci` flow against fake upstreams: `yarn e2e` (`test/e2e/run.ts`).
- Router code (`src/router/**`) imports only `node:*` builtins, `src/types.ts` and its own siblings (`routes.ts`, `gateway.ts`).
- Runtime deps available: `@clack/prompts`, `picocolors`, `smol-toml`. No others without asking.
- Every function that touches the outside world (fs paths, `security`, `secret-tool`, `systemctl`/`launchctl`, `git`, `fetch`, `osascript`, clock) takes it via an options object, or reads it from `src/paths.ts`, so tests can inject fakes. Tests never touch the real HOME, the Keychain, or the network.

## `src/paths.ts` (owner: D)

```ts
export const home = (): string             // BARRITO_HOME || os.homedir() — FUNCTION (lazy), use `${home()}/x`
export const expand = (p: string): string // '~' and '~/' → home()
export const root = (): string            // absolute package root: walks up from this file to our package.json (cached); works from src/ and dist/src/
export const platform = (): 'darwin' | 'linux'  // BARRITO_PLATFORM override (validated); throws on any other platform
export const paths = {
  config,   // ~/.config/barrito/config.toml   (Linux: $XDG_CONFIG_HOME)   (BARRITO_CONFIG overrides)
  state,    // ~/.local/state/barrito/          (Linux: $XDG_STATE_HOME)   (BARRITO_STATE overrides)
  logs,     // ~/Library/Logs/barrito.log       (Linux: <state>/barrito.log) (BARRITO_LOG overrides)
  backup,   // <config dir>/backup/
  shims,    // ~/.local/shims/                  (BARRITO_SHIMS overrides)
}
```

Every member of `paths` is a lazy getter, so tests can set `BARRITO_*` after import and still see the override.

## `src/config.ts` (owner: D)

```ts
export const load = (file = paths.config) => Config & { warnings: string[] }  // parse TOML, merge defaults, validate, expand ~, collect unknown-key warnings
export const save = (config: ConfigInput, file = paths.config) => void       // write TOML atomically (tmp + rename); collapses ~ back
export const defaults = { port: 4141, default: 'personal', identities: {}, models: {}, graft: { roots: [], repos: [] }, harness: {}, transforms: { rtk: true, caveman: 'lite' } }
```

Resolved config shape (what `load` returns) — `keychain` slots accept any ref form (a plain keyring name, `env:VAR`, `file:/path`):

```ts
{
  port: 4141,
  default: 'personal',
  identities: {
    work: {
      id: 'work',
      claude_config_dir: '/Users/x/.claude',
      share_from: null | '/Users/x/.claude',
      fallback: [],                        // missing = "stop and tell me"; init writes the user's choice, never a paid chain
      match: { remotes: ['github.com/acme/*'], paths: ['/Users/x/Code/acme/**'] },
      keychain: { gateway: 'barrito: gateway work', cursor: 'barrito: cursor work' },  // barrito-owned items; any plain name, 'env:VAR' and 'file:/path' allowed
      transforms: { rtk: true, caveman: 'lite' },   // optional per-identity token-saver overrides (partial; see src/router/transforms.ts)
    },
  },
  transforms: { rtk: true, caveman: 'lite' },  // [transforms] — merged from defaults when the table is absent
  models: {
    include: [], exclude: [], require: ['tool-use'], max_input_price: null, pin: [], labels: {},
    suffix: {},                            // optional per-model '[1m]' override
    agents: { astra: 'openai/gpt-6-astra', glm: 'zai/glm-5.3[1m]', deepseek: 'deepseek/deepseek-v4.1-flash[1m]' },
  },
  graft: { roots: ['/Users/x/Code'], repos: [{ path: '/Users/x/Code/acme/api', summaries: false }] },
  harness: { mybot: { bin: 'mybot', env: { OPENAI_BASE_URL: '{gateway}/v1' } } },
  warnings: ['unknown key "x" ignored …'],
}
```

## `src/keychain/index.ts` (owner: D)

```ts
export const kind = (ref: string): 'env' | 'file' | 'keyring'
export const ownName = (slot: string, identity: string): string              // "barrito: <slot> <identity>"
export const owned = (ref: string): boolean                                  // ref.startsWith('barrito: ')
export const get = (service: string, opts: GetOpts = {}) => string | null    // trims; empty → null; miss → null
export const has = (service: string, opts: GetOpts = {}) => boolean         // existence WITHOUT reading the secret
export const set = (service: string, value: string, opts: SetOpts = {}) => void   // backs up any value it overwrites (below)
export const del = (service: string, opts: GetOpts = {}) => boolean          // keyring only; barrito-owned items only
export const backups = (opts: GetOpts & { files?: string[] } = {}) => BackupItem[]   // newest first; names only
export const recover = (service, backup, opts: SetOpts = {}) => boolean      // backup's value → service (verified set), then delete backup; false = backup gone
export const restore = (service, opts: SetOpts & { from?: string } = {}) => BackupItem | null  // newest, or the one at `from`
export const RETAIN = 3
// GetOpts = { exec?, env?, fs? }        SetOpts = GetOpts & { account?: string; backup?: Recorder; now?: () => Date }
// Recorder = { ts, secret(entry: SecretEntry) } — the backup handle from src/backup.ts
// SecretEntry = { kind: 'keychain', service, account, backup }   BackupItem = { service, ts, backup }
```

**Backup before overwrite (in `set`, so no caller can skip it).** `set` reads the current value via `get`; if one exists and differs, it first writes it to `barrito backup: <service> <ts>` (account `barrito`, same verified write path, in the keyring — never on disk), or for `file:` a `0600` sibling `<file>.barrito-bak-<ts>`; then writes the new value; then prunes that service's backups to the newest `RETAIN`. `ts` is the backup handle's (`opts.backup.ts`) or the clock to the second. One backup per (service, ts): a second overwrite in the same run keeps the first. An unreadable current value refuses the write. With a handle, the backup is recorded in the manifest's `keychain` array by name only. New items and unchanged values: no backup.

Dispatch by `kind`: `env:VAR` reads the environment (read-only — `set` throws); `file:/path` reads/writes a file (see guards); a plain name goes to the platform adapter picked by `platform()`, throwing a clear error on unsupported platforms.

barrito owns its own Keychain items — `ownName` names, account `barrito`, created with `-T /usr/bin/security` so creation never asks and reads never prompt. Foreign items (made by other tools) are **copied** into owned items (`keychain-own` migrate action in `init`, and `barrito keychain own`) — one value read each, originals never modified or deleted; `has` probes existence via attributes only, so detection never prompts. `del` is for `uninstall --restore` removing the copies.

`file:` guards — `set` refuses a symlinked destination before reading the old value, writes only at 0600 (`O_EXCL` random temp name, fsync, atomic rename) and refuses a symlink destination or a group/world-writable parent dir without the sticky bit; `get` refuses to read through a symlink whose target isn't owned by the current uid or isn't private (group/world bits set).

- `macos.ts`: `/usr/bin/security` (get: `find-generic-password -s <name> -w`, exit 44 = miss; `has`: `find-generic-password -s <name>` — attributes only, no `-w`, so it never triggers an access prompt; set: `add-generic-password -U -T /usr/bin/security` with the secret on **stdin**, never argv — the stable `security` binary goes on the item's trusted-app list; del: `delete-generic-password -s <name>`, no prompt for items we created).
- `macos.ts` also: `list`: `dump-keychain` (no `-d` — attribute names only, never a secret, never a prompt), parsed for `svce`.
- `linux.ts`: `secret-tool` (get: exit 1 = miss; no binary / no D-Bus secrets service → actionable error naming `env:`/`file:`; set also via stdin; backup items carry the extra attribute `barrito-backup 1`). `available({ exec })` probes whether a keyring answers — `init` and `doctor` use it to pick ref forms. `del`: `clear service <name>`; `list`: `search --all barrito-backup 1`, keeping only `attribute.service` lines. No `has` — it falls back to `get`. Uninstall's owned-copy removal stays darwin-only.

## `src/backup.ts` (owner: D)

```ts
export const create = (o: { ts?, dir?, fs?, now? } = {}) => Backup   // Backup = { root, ts, manifest, save, record, secret, write }
export const restore = (manifestPath, o: { exec?, fs?, keyring?: SetOpts, report?: (line) => void } = {}) => BackupManifest
export const read = (manifestPath, fs?) => BackupManifest
export const latest = (dir = paths.backup, fs?) => string | null
// BackupManifest = { version: 1, created, files, launchd, removed, keychain: SecretEntry[] }   (keychain optional on read)
```

`restore` puts files/symlinks back, re-bootstraps launchd, then for each `keychain` entry calls `keychain.recover` — reporting `✓ restored keychain "<service>"` or `! skipped keychain "<service>" (<reason>)` and continuing. `keyring` carries the keychain exec separately: a `security -i` write needs stdin.

## `src/service/index.ts` (owner: D)

```ts
export const label = 'dev.barrito.router'
export const legacy = 'com.tybarho.claude-router'
export const install = async (o: InstallOpts = {}) => Promise<string>  // ASYNC — await it. returns the rendered unit/plist xml
export const uninstall = (o: { exec?; dir? } = {}) => void
export const removeLegacy = (o: { exec?; dir? } = {}) => void           // darwin-only (old claude-router plist); no-op on linux
export const status = (o: { exec? } = {}) => { running: boolean, pid: number | null }
export const restart = (o: { exec? } = {}) => void                      // launchd kickstart -k / systemctl --user restart
// InstallOpts = { bin?, port?, exec?, dir?, node?, pathEnv?, sleep?, user? }
```

`install` dispatches by `platform()`:

- `launchd.ts` — renders `templates/router.plist` into `~/Library/LaunchAgents/<label>.plist` (atomic), bootout (result ignored — it races bootstrap), settle ~1s, bootstrap.
- `systemd.ts` — renders `templates/barrito.service` into `~/.config/systemd/user/barrito.service`, `daemon-reload`, `enable --now`. Refuses values systemd can't quote (`"`, `\`, newline; the log path additionally whitespace). No user session bus → error pointing at `barrito serve --detach`. Prints a `loginctl enable-linger <user>` note when linger is off.

Both set `BARRITO_PORT` in the unit env; `serve` reads `process.env.BARRITO_PORT ?? config.port`. The service runs `barrito serve`.

## `src/settings.ts` (owner: D)

```ts
export const read = (configDir) => ClaudeSettings                  // <configDir>/settings.json, {} if missing
export const merge = (configDir, fragment) => ClaudeSettings       // deep merge (arrays replaced), atomic write, returns merged
export const remove = (configDir, keyPaths) => ClaudeSettings      // e.g. ['statusLine', 'env.ANTHROPIC_BASE_URL']
```

## `src/identity.ts` (owner: C)

```ts
export const resolve = (cwd, { config, env = process.env, git, cache } = {}) =>
  ({ id, rule: 'env' | 'remote' | 'path' | 'default', detail })   // detail: remote URL, matched glob, etc.
export const normalizeRemote = (url) => 'host/owner/repo'         // ssh, https, .git suffix, ports, ssh host aliases, enterprise hosts
export const glob = (pattern, s) => boolean                       // '*' within one segment, '**' any depth (incl. zero)
export const git = (args, { cwd } = {}) => string | null
export const peek = (cwd, opts = {}) => IdentityCacheEntry | null  // warm-cache entry without a git spawn; null when cold
```

Order: `BARRITO_IDENTITY` → fresh cache entry → git remote owner glob → path glob → `config.default`. `GITHUB_REPOSITORY` (`github.com/<owner>/<repo>`) stands in for the remote when a repo has no origin. Path globs are realpath-adjusted before matching (macOS `/var` vs `/private/var`).

Cache `<state>/which.json`:

```ts
{ repos: Record<gitToplevel, IdentityCacheEntry>, dirs: Record<dir, gitToplevel> }  // each side capped at 100; legacy flat format migrated on read
// IdentityCacheEntry = { top, commonDir, configFile, mtimeMs, url, result: Resolution, fp }
```

An entry is fresh while `fp` (sha over default, GITHUB_REPOSITORY and per-identity match config) matches and the git config file's mtime is unchanged; `dirs` maps subdirectories of a cached repo to its toplevel so warm lookups spawn zero git processes.

## `src/harnesses.ts` (owner: C)

```ts
export const MARKER = 'generated by barrito'
export const builtins = { claude, codex, opencode, 'cursor-agent' }   // cursor-agent: aliases ['agent']; see plan "Harnesses"
export const configFragments = { opencode }  // merged into opencode.json — provider.vercel with baseURL {gateway}/v1/ai and apiKey {env:BARRITO_HANDLE}
export const find = (name, config) => Harness | null                 // config.harness overrides/extends builtins; resolves aliases
export const envFor = (harness, identity, { config, keychain, env }) => ({ VAR: 'value' })
export const realBin = (bin, { path = process.env.PATH, shims = paths.shims, self }) => string | null
```

Template vars: `{gateway}` = `http://127.0.0.1:<port>/gateway`, `{handle}` = `barrito:<id>`, `{identity}`, `{keychain:<slot>}` (Env level only — `envFor` throws otherwise). Claude (level `full`) env: `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`, `CLAUDE_CONFIG_DIR=<identity.claude_config_dir>`, `ANTHROPIC_CUSTOM_HEADERS=x-barrito-identity: <id>`, `BARRITO_IDENTITY=<id>`; every level gets `BARRITO_IDENTITY`. Env-level vars already set in the environment are never stomped. Never put a Vercel key in env.

`realBin`: first executable on PATH outside the shims dir — never a barrito shim (marker check) and never ourselves (`--self`).

## `src/router/tiers.ts` (owner: B)

```ts
export const create = ({ config, statePath, notify, now = Date.now }) => Tiers
export const label = (config, id) => string   // config.models.labels wins; else bare id, '[…]' stripped, '-' → ' ', upper-cased

tiers.route(identityId, model)
  // → { to: 'direct' } | { to: 'gateway', model: 'zai/glm-5.3', reason: 'quota' | 'throttle' | 'outage' | 'pinned' }
tiers.observe(identityId, { to, model, status, headers, error })
  // → { retry: Retry | null }    Retry = { to: 'direct'; delay: number } | { to: 'gateway'; model; reason }
tiers.pin(identityId, value)      // 'max' | gateway model id (must contain '/') | null — anything else throws
tiers.snapshot()                 // → { [id]: { tier: 'max'|'fallback'|'pinned', reason, model, since, resetAt, util5h, util7d, pin } }
```

`observe` on a **direct** hop:

- 2xx → landed: refresh util5h/util7d and the reset; a `limited` status refreshes the quota window without a tier change; otherwise a fallback tier returns to `max` and notifies `<id> — Max is back.` A `throttle` fallback clears on any 2xx (it was transient).
- 429 **confirmed** by the unified headers (`unified-status: rejected`, a 5h/7d status `limited`/`rejected`, or a representative claim with utilization ≥ 1) → quota fallback: chain head, reset from the headers, notify `barrito · <id> — Max spent. Now <Label> on API credits until <HH:MM>.` (once per transition, not per repeat).
- 429 the headers do **not** blame on quota (no unified headers, or status still `allowed`) → transient throttle: one free direct retry `{ to: 'direct', delay }` (delay from `retry-after` when ≤ 5s), no state change. A second such 429 enters `fallback(throttle)`: chain head, `resetAt = now + clamp(retry-after, 60s, 5m)`, notify once `barrito · <id> — Anthropic throttling. <Label> on API credits for a few minutes.`; the next request after `resetAt` probes direct.
- 529/5xx/connect error → first failure earns one free direct retry; a repeat within 60s opens the outage breaker (notify `barrito · <id> — Anthropic unreachable. Now <Label> on API credits.`), half-open after 60s, backoff ×2 up to 15m.

`observe` on a **gateway** hop (429/5xx/connect): walks to the next chain entry (bare-id match, `[1m]` ignored) — unless a pin is set or the tier isn't `fallback`, in which case the failure surfaces. Chain exhausted → `{ retry: null }` and the next request starts from the head.

Pins override everything: `max` → always direct (quota errors surface), a model → always that model. Rate-limit headers (confirmed): `anthropic-ratelimit-unified-5h-utilization` / `-7d-utilization` (0..1), `-5h-reset` / `-7d-reset` (epoch seconds), `-5h-status` / `-7d-status` (`allowed`|`limited`|`rejected`), `anthropic-ratelimit-unified-status`, `anthropic-ratelimit-unified-reset`, `anthropic-ratelimit-unified-representative-claim`. Reset picking: claim window → blocked (limited/rejected) window (7d wins) → unified-reset → `retry-after` → 5h from now. A header-less 429 is never treated as a spent quota — it takes the throttle path above.

State persists to `<statePath>/tiers.json` (tmp + rename); garbage entries drop, unknown keys are kept out. Header keys are lowercase.

`src/router/notify.ts` (owner: B): `export const notify = (title, message, { probe, exec, env, platform, group, out, err } = {}) => void` — never throws, never blocks (probes synchronously once per binary, then fires detached). `GITHUB_ACTIONS` → `::warning::` (or `::notice::` for "is back") workflow command — data escapes `%`, CR, LF; property values also `:` and `,`. Linux with `DISPLAY`/`WAYLAND_DISPLAY` → `notify-send -a barrito -i <templates/icon.png>`. darwin → `terminal-notifier -contentImage <templates/icon.png> -group barrito-<group>` if on PATH, else `osascript display notification` (no image; escapes `\`, `"`, `\n`, `\r`). Otherwise stderr. The icon ships as `templates/icon.png`, resolved via `root()`.

`src/router/spend.ts` (owner: B): `export const create = ({ prices, statePath, now }) => Spend` with `spend.record(identityId, model, usage) → usd` and `spend.today() → { [id]: usd }` (per-day buckets in `<statePath>/spend.json`; a corrupt file is set aside). `prices(modelId) → { input, output, input_cache_read } | null` per-token USD numbers.

## `src/router/transforms.ts` (owner: A)

```ts
export type Caveman = 'off' | 'lite' | 'full' | 'ultra'
export interface TransformState { rtk: boolean; caveman: Caveman }
export interface Applied { rtk: number; caveman: Caveman; saved: number }  // rtk = tool_results compressed, saved = bytes
export type TransformExec = (args: string[], input: string, timeoutMs: number) => string | null

export const create = (o: { defaults: (identityId: string) => TransformState, statePath: string, exec?: TransformExec, rtkPath?: string | null, now?: () => number }): Transforms
// Transforms = {
//   state(id): TransformState                                             // override ?? defaults(id)
//   set(id, patch: Partial<TransformState> | null): TransformState        // null = reset to config defaults; throws on a bad caveman/rtk
//   anthropic(id, body: Record<string, unknown>): { body, applied }       // structuredClone — the caller's body is never mutated
//   openai(id, body: Record<string, unknown>): { body, applied }
//   available(): boolean                                                  // `rtk` binary on PATH (injected exec/rtkPath short-circuits the probe)
//   stats(): Record<id, { saved: number; compressed: number }>             // today's bucket only
// }
```

Optional, toggleable token savers applied to request bodies. Config: `[transforms]` (defaults `rtk = true`, `caveman = "lite"`, both keys optional) plus per-identity `[identities.<id>.transforms]` partial overrides. `serve` resolves them per identity via `transformDefaults(config)` and wires `transforms.create({ defaults, statePath })` into `start()` as `StartOpts.transforms` (absent → transforms off, `/transforms` 404s).

- **rtk** compresses noisy `tool_result` content through the user's `rtk` binary. Each assistant `tool_use` with a string `input.command` is mapped by `rtk rewrite <command>` to one of rtk 0.49's fixed `rtk pipe --filter` names (cargo-test, pytest, go-test, tsc, git-diff, git-log, grep, rg, find, …); the paired tool_result then goes through `rtk pipe --filter <name>`. Content is left raw when it is under a 1.5 KB floor, has no known command, already carries rtk's own filter markers (`[+N lines omitted]`, `N matches in M files:`, git-diff summary tails, …), or the pipe times out (300 ms), errors, or doesn't shrink it. `rtk rewrite` exits 3 on success, so stdout is the truth, not the exit code. Both `rewrite` answers and piped outputs sit in insertion-ordered LRU Maps (2000 entries; the pipe cache keys sha256 of `filter\0content`), so identical bytes are never re-compressed. Anthropic shape: string tool_results, or content arrays with exactly one text part (multi-text arrays are left alone); OpenAI shape: `tool_calls[].function.arguments` (JSON-parsed) paired with `role:"tool"` messages.
- **caveman** appends `templates/caveman/<level>.md` (read once per level and cached; a missing template is a no-op) as a system suffix — Anthropic: appended to `body.system` (string concat; pushed as a `{type:'text'}` block onto an array so existing `cache_control` blocks stay put; set when absent); OpenAI: appended to the first `system`/`developer` message's content, unshifted when there is none.
- Persistence `<statePath>/transforms.json` (tmp + rename): `{ overrides: { [id]: TransformState }, days: { [yyyy-mm-dd]: { [id]: { saved, compressed } } } }` — a corrupt file is set aside as `transforms.json.bad-<ts>`; the day bucket rolls over at local midnight, keeping only today's.

## `src/router/server.ts` + `routes.ts` + `gateway.ts` (owner: A)

```ts
export const start = (opts: StartOpts): http.Server
// StartOpts = { config: RouterConfig, port, tiers: RouterTiers, spend, keychain, log, upstreams, transforms?, maxBody? }
// RouterTiers = Tiers whose snapshot may return partial entries (full Tiers is assignable)
```

Routes: `GET /health` → `{ ok: true }` · `GET /status` → `{ pid, uptime, identities: tiers.snapshot(), spend: spend.today(), transforms: { [id]: { state, saved, compressed } }, rtk: boolean }` · `POST /pin` `{ identity, value }` → `tiers.pin` · `POST /transforms` `{ identity, rtk?, caveman?, reset? }` → `transforms.set` → `{ ok, state }` (unknown identity 400; no `transforms` wired 404; a bad caveman/rtk 400 with `set`'s message) · `/gateway/*` with `Authorization: Bearer barrito:<id>` → reverse proxy to `<gateway>/*` with the identity key (handle swapped; unknown handle → 401 Anthropic-shaped) · everything else is the Claude path, identity from the `x-barrito-identity` header. Unknown/missing identity → 400 `barrito: no identity for this request — run barrito doctor`.

Claude Code gateway hops go to `<gateway>/claude-code` with body model `claude-code/<model>`. Direct hops strip `x-barrito-*` and `x-ai-gateway-api-key`; gateway hops strip `authorization` and set `x-ai-gateway-api-key: Bearer <key>`. Retry the same buffered body on `{ retry }` from `tiers.observe` (only possible before any response bytes were written). Gateway keys per identity via `keychain.get(identity.keychain.gateway)`, cached in memory, busted and re-read once on an upstream 401. Set response header `x-barrito-tier: max` | `fallback:<model>; reason=<r>; reset=<iso>` | `pinned:<model>`. Tee SSE/JSON to extract `usage` (OpenAI names mapped) and call `spend.record`. Log one line per request to `log(line)`: `<iso> <id> <method> <path> <model> → <to> (<reason>) <status> <ms>ms` — never headers or bodies; every non-final hop is logged too, as `<iso> <id> <method> <path> <model> → <to> <status> (retry)`.

Transforms (`StartOpts.transforms`) are applied once per request via `routes.transform()` (`transform(tx, 'anthropic'|'openai', id, raw)` — junk/empty bodies pass through untouched): the Claude path applies the anthropic shape to the buffered body before the hop loop, `/gateway/*` applies the openai shape to `*/chat/completions` and the anthropic shape to `*/messages` (JSON bodies only). Because `transforms.anthropic/openai` work on a `structuredClone`, retries reuse the same rewritten bytes and the caller's body is never mutated. Responses carry `x-barrito-transforms: rtk=<n>; caveman=<level>` and the log line gains a ` t=rtk:<n>,cave:<level>` suffix. `GET /status` lists every configured identity plus any with saved-today stats.

## `src/catalog.ts` (owner: E)

```ts
export const refresh = async ({ fetch, key, statePath, fs, now, write = true }) => CatalogModel[]
   // GET <gateway>/v1/models (BARRITO_GATEWAY overrides the host), cache to <statePath>/catalog.json
export const cached = ({ statePath, maxAge = 86400e3, now, fs, stale = false }) => CatalogModel[] | null  // sync read
export const last = ({ statePath, fs }) => CatalogCache | null   // the cache at any age: { fetchedAt, data } | null
export const price = (models, id) => { input, output, input_cache_read } | null  // per-token numbers; strips claude-code/ and [1m]
export const bare = (id) => string             // strip 'claude-code/' prefix and '[1m]' suffix
```

Catalog entries: `{ id, name, type, tags, context_window, pricing: { input, output, input_cache_read, input_tiers: [{ cost, min?, max? }] } }` (prices are per-token strings).

## `src/models.ts` (owner: E)

```ts
export const select = (catalog, rules: SelectRules = {}) => Selected[]   // require(tags) → include/exclude/max_input_price → + pin
   // Selected = { id, name, price, tiers: { threshold, factor } | null }; '[1m]' suffix for ≥1M context without input tiers (rules.suffix overrides)
export const skipped = (catalog, rules) => Skipped[]                      // pins that exist but fail language/require — { id, why }
export const render = (selected, config, { catalog, fs, dir }) => { modelPicker: { options: PickerRow[] }, agents: Record<string, string> }
export const check = (config, catalog) => string[]                        // fallback-chain/agent/pin ids missing from the catalog
export const sync = async ({ config, catalog, dryRun, all, settings, fs }) => SyncResult
export const per1m = (n) => string                                         // '$0.55' style per-1M
```

`SyncResult = { added: string[], removed: Removed[], unchanged: string[], updated: string[], dirs: SyncDir[], missing: string[], protected: string[], skipped: Skipped[] }` — per-dir detail in `dirs: SyncDir[]` (`{ dir, ok, error?, added, removed, unchanged, updated }`); `Removed = { id, reason: 'retired' | 'rules' }`; `protected` lists hand-written agent files never touched; `missing` repeats `check` per catalog. Agent file templates come from `templates/agents/*.md`, model line from `config.models.agents`; a template whose model isn't in the catalog is skipped.

## `src/graft.ts` (owner: F)

```ts
export const scan = ({ roots, git, fs, state, now }) => ScanEntry[]       // { path, remote, loc, partial? } sorted loc desc; cached per HEAD sha in <state>/graft-scan.json
export const wired = (repoPath, { fs }) => boolean
export const wire = (repoPath, { exec, fs, env }) => void                 // graft init --yes --no-global --no-statusline --no-agents --no-build
export const build = (repoPath, { exec, detached, env, fs, state, now }) => BuildResult
   // BuildResult = { started: boolean, pid?: number, reason?: 'locked' | 'recent' }
export const ensure = (cwd, { config, exec, fs, git, state, now }) => void // worktree of a grafted repo with no graft/ → detached build; never blocks
export const summaries = (repoPath, { config, resolve }) => SummaryEnv | null  // GRAFT_* pointing at {gateway}/v1 with the repo's identity handle
export const run = (cmd, opts?) => string | Child   // sync stdout, or the spawned child when opts.detached — overload signature in types.ts
export const runGit = (args, opts?) => string
```

A detached build stamps `<state>/graft-build/<sha1(repoPath)>.json` (`{ pid, startedAt }`): a live pid means `locked`, a stamp younger than 10 minutes means `recent` — the backoff that keeps a broken build from respawning on every shim launch.

## CLI

`bin/barrito.ts` is the dispatcher: the command list is the keys of `src/usage.ts`; `<command> --help` prints that entry **before** the config load or the command import; `--version` reads `package.json` via `root()`.

Commands other than `init` are `src/cli/<name>.ts` exporting `default async (argv, ctx: CommandCtx) => Promise<void>`, where `CommandCtx = { config: Config, print, exit: (code) => void }` — bin loads the config before dispatch. `init` gets the loose `Ctx = { config: Config | null, print, exit: (code) => never }` because it may be creating the config. Parse args with `node:util` `parseArgs`. Owners:

- C: `which`, `env`, `exec`, `shim`
- E: `models`
- F: `graft`
- G: `status`, `doctor`, `pin`, `unpin`, `set`, `logs`, `serve`, `stop`, `ci`, `statusline`, `uninstall`, slash command `templates/barrito-command.md`
- H: `init`

Exports the tests script against:

- `serve`: `startDetached(o: DetachOpts) → { pid, port, existing }`, `stopDetached(o: StopOpts) → boolean`. Pidfile `<statePath>/barrito.pid` (JSON `{ pid, port, startedAt, token }`); only a pid proven via `GET /status` answering with that pid is ever signalled (SIGTERM ≤3s, SIGKILL, drop the pidfile); stale or foreign pidfiles are cleaned, never signalled. `DetachOpts.env` merges extra env into the child (how `ci` points the router at RUNNER_TEMP).
- `shim`: `writeShims({ config, harnesses, dir, force, bin, node, print }) → { written: string[], refused: string[] }` — refuses files not generated by barrito unless `force`; aliases become symlinks; 0o755. `ShimCtx = CommandCtx & { bin?, node? }`.
- `status`: `port`, `base`, `fetchJson`, `postJson` (abort-raced), `parse`, `table`, `markdown` (GFM cells escape pipes and backticks, newlines collapse to spaces; appends a `!` line per fallback identity), `nudges`. `parse` also reads `/status`'s `transforms` + `rtk`; the tables gain a TRANSFORMS column (`cellTransforms`: `rtk · cave:<level> · <bytes> saved`, `—` when nothing is on). The fallback tier marker is `!` (`src/glyphs.ts`), never a non-ASCII glyph.
- `set`: `barrito set <identity> [rtk on|off] [caveman off|lite|full|ultra] [--reset]` — identity required (exit 2 on a unknown one); posts `{ identity, rtk?, caveman?, reset? }` to `/transforms` and renders the answered state (`<id> → rtk on|off · caveman <level>`). `--reset` drops the override (config defaults apply again).
- `doctor`: `diagnose(config, opts) → DoctorCheck[]` — a `GITHUB_ACTIONS` branch (PATH/shims, `BARRITO_PORT`, `BARRITO_IDENTITY`, `/health`, env:/file: readability), linux bits (linger, rc PATH line, keyring availability), host staleness (emdash/conductor started before the shims install), and a warn when rtk is enabled (identity override ?? `[transforms]` ?? defaults) but the binary is missing from PATH.
- `statusline`: ASCII only (tmux-safe), parts ` | `-separated — `src/glyphs.ts` is the single glyph map. Reads Claude Code's stdin JSON (`model.id`, `model.display_name`, `rate_limits`); the session's selected model is always first, then what actually answers: `work | Opus 5.5 | Max 3%` (max, % from `rate_limits.five_hour` else the snapshot util), `work | Opus 5.5 > GLM 5.3 (API) | Max resets 14:05` (rerouted bare model), `work | Opus 5.5 > GLM 5.3 (API) | throttled, retry 14:05` (throttle), `personal | GPT-6 Astra (API)` (explicit gateway pick, no arrow), `work | pin GLM 5.3 (API)` / `work | Opus 5.5 | Max 3% | pin max` (pins), `work | Opus 5.5` when the router is unreachable, and the token-saver tail (` | rtk | cave:<level>`, off parts omitted). Model label: `display_name`, else a pretty form of the id (strip `claude-code/` + provider prefix + `[1m]`; digit-digit hyphens become dots). `/status` fetch keeps the 50ms timeout; never throws.
- `ci`: `flags(argv)` (identity/gateway-key/fallback/port/config/stop), `build(flags) → ConfigInput` (gateway keys must be `env:`/`file:` — CI has no keyring), `envLines`. Writes `$GITHUB_PATH`/`$GITHUB_ENV` with newline guards (nothing is written before every check passes), starts the router detached under `$RUNNER_TEMP`, waits for `/health`, prints a `::notice` when `CLAUDE_CODE_OAUTH_TOKEN` is absent. `ci stop` writes `status --markdown` to `$GITHUB_STEP_SUMMARY` and tears down — warnings only, never a failed job.
- `init`: `Prompts` (injectable), `Io` (the outside world), `viaNpx(script, env)`. `--yes` takes every default; `--dry-run` writes nothing (cold catalog fetch goes through a no-write fs). Identities loop on "Add another identity?"; no keyring → `env:` refs; PATH block written via `src/detect.ts` `rcOf` (zsh/bash/fish), wrapped in `# >>> barrito >>>` markers that `uninstall` removes whole. The token-savers step (rtk + caveman prompts, defaults `rtk` on / `caveman` lite) runs only when the config file has no `[transforms]` table — existing values win; `plan()` (src/migrate.ts) diffs `transforms` in its canon (global table and per-identity, via `identities`), so a missing table plans its own config write — `load()` injects the defaults, so init hands `existing` to `plan()` as the file holds it.

`templates/shim.sh` (owner: C) — `__BARRITO__` bakes absolute node + barrito paths at generation time, `__HARNESS__` the harness name:

```bash
#!/usr/bin/env bash
# generated by barrito — do not edit; run `barrito shim` to regenerate
eval "$(__BARRITO__ env --shell --harness __HARNESS__ --self "$0")" || exit $?
[ -n "${BARRITO_REAL_BIN:-}" ] || exit 127
exec "$BARRITO_REAL_BIN" "$@"
```
