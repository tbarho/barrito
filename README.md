<p align="center"><img src="assets/logo-256.png" width="128" height="128" alt="barrito"></p>

# barrito

One local router, every identity.

barrito resolves which identity a directory belongs to, then routes every coding agent there through that identity: Claude Code uses its Max login straight to Anthropic, and when Max runs out it drops to cheap models on that identity's Vercel AI Gateway key. Every other harness — Codex, OpenCode, custom scripts, AI SDK apps — gets that identity's gateway key through the same local proxy, so per-identity billing and repo-aware routing work everywhere.

## Install

**Prerequisites:** Node.js ≥ 22.18 is required. Use `nvm` to install the required version:

```bash
nvm install 22    # installs latest 22.x (22.23.3 as of Oct 2026)
nvm use 22
```

Or with a `.nvmrc` file in your project (included in this repo):

```bash
nvm install       # reads .nvmrc
nvm use
```

For containers, use Node 22.18+ base images: `node:22-slim`, `node:22-alpine`, etc.

**Installation:**

```
npx barrito init
brew install tbarho/tap/barrito && barrito init
yarn global add barrito && barrito init
```

`npx` runs the wizard and then offers to install globally. Take it: the service (launchd on macOS, systemd on Linux) needs a stable path to a real binary, which `npx`'s temp dir is not.

**Configuration:** See [`config.toml.example`](config.toml.example) for an annotated configuration file and [`.env.example`](.env.example) for environment variable overrides (all optional).

## Quick start

```
barrito init      # detect, migrate, log in each identity, write config + shims + service
barrito doctor    # PATH order, service health, logins, keychain items
```

`init` takes any number of identities — it starts from your config (or the two built-in defaults on a fresh machine) and keeps asking "Add another identity?" until you say stop. It adds a marked PATH block to your shell rc (`~/.zshrc`, `~/.bash_profile`/`~/.bashrc`, or `~/.config/fish/conf.d/barrito.fish`); `barrito uninstall` removes that block and nothing else you wrote by hand.

Then restart emdash and Conductor once. They cached `PATH` before the shims existed; `doctor` tells you if you forget. Plain terminals and new tmux sessions pick it up immediately.

## How it works

```
agent            claude · codex · opencode · cursor-agent · your own
  │
  ├─ shim        ~/.local/shims/claude  →  barrito env  →  identity for this cwd
  │
  ▼
router           127.0.0.1:4141
  ├─ Claude model, tier = max        →  api.anthropic.com              (direct, Max OAuth)
  ├─ Claude model, spent or pinned   →  ai-gateway.vercel.sh/claude-code (identity key)
  └─ /gateway/*                      →  ai-gateway.vercel.sh            (identity key)
```

Identity is resolved at exec time in the shim, so it works the same in emdash, Conductor, tmux and a plain terminal:

1. `BARRITO_IDENTITY` in the environment — the escape hatch.
2. Git remote owner — `origin` normalized to `host/owner/repo`, matched against `match.remotes` globs. Worktrees in arbitrary directories just work. In GitHub Actions, `GITHUB_REPOSITORY` stands in when a repo has no origin.
3. Path glob against `match.paths`, for repos without a remote.
4. `default` from config.

Results are cached per git toplevel + remote URL in the state dir's `which.json`. `barrito which` prints the rule that matched.

## Harness support

| Level | Harnesses | Mechanism |
| --- | --- | --- |
| Full | Claude Code | `ANTHROPIC_BASE_URL=http://127.0.0.1:4141`, `CLAUDE_CONFIG_DIR` per identity (switches the Max login), `ANTHROPIC_CUSTOM_HEADERS=x-barrito-identity: <id>`. The router runs the tier state machine. |
| Gateway | Codex, OpenCode, custom scripts, AI SDK apps | Base URL → `http://127.0.0.1:4141/gateway`, API key = handle `barrito:<id>`. The router swaps the handle for the identity's Vercel key and reverse-proxies the request. No format translation. |
| Env | cursor-agent | Cursor's backend can't be proxied. The shim injects `CURSOR_API_KEY` from the secret store plus `AGENT_CLI_CREDENTIAL_STORE=file`. |

Built-ins ship in the package and are overridable in config. A custom harness:

```toml
[harness.mybot]
bin = "mybot"
env = { OPENAI_BASE_URL = "{gateway}/v1", OPENAI_API_KEY = "{handle}" }
```

```
barrito shim mybot
```

Template vars: `{gateway}`, `{handle}` (`barrito:<id>`), `{identity}`, `{keychain:<slot>}` (Env level only). Shims are bash with a true `exec`, so TTY and signals stay native. `barrito shim` refuses to overwrite a file it didn't write unless you pass `--force`.

## When Max runs out

Cheap first, loudly. A per-identity state machine (persisted to the state dir's `tiers.json`) keeps a spent quota spent across restarts.

- **Quota:** a direct 429 moves the identity to `fallback(quota)` until the reset timestamp from Anthropic's rate-limit headers — but only when those headers confirm it (`unified-status: rejected`, a window status `limited`/`rejected`, or a representative claim at 100%+). The next request after the reset probes direct again.
- **Burst 429s pass through:** a 429 the headers don't confirm as quota (header-less, or status still `allowed` — typical when several sessions/subagents burst at once) is never a reason to spend API credits. barrito forwards Anthropic's 429 to Claude Code verbatim (status, `retry-after`, body), no tier change, no notification; Claude Code backs off and retries on its own. Each one is logged (`→ direct 429 (passthrough) [rate_limit_error: …]`) and counted per identity — `barrito status` notes `work: 12 throttled 429s passed to Claude Code today`.
- **Outage:** a direct 529/5xx/connect error earns one free direct retry; a second within 60s opens the breaker, which half-opens after 60s and backs off ×2 up to 15m.
- The triggering error arrives before any stream bytes, so the same request is retried on the fallback chain immediately. You see an answer, not an error. If every chain entry fails, you get an Anthropic-shaped error listing each hop.

Loud on every transition, silent otherwise:

```
statusline     work | Max 62%
               work | Opus 5.5 | Max 3%            (session model first)
               personal | Opus 5.5 > GLM 5.3 (API) | Max resets 14:05
notification   barrito · personal — Max spent. Now GLM 5.3 on API credits until 14:05.
               barrito · personal — Max is back.
header         x-barrito-tier: fallback:glm-5.3; reason=quota; reset=2026-10-01T14:05:00-05:00
```

The statusline is ASCII only (tmux-safe): parts are ` | `-separated, a reroute shows as `Opus 5.5 > GLM 5.3`, no emoji or box glyphs. Every upstream hop is logged — a 429 can't disappear silently.

| Want | How | Scope |
| --- | --- | --- |
| Switch model now | `/model` → any gateway row | This session |
| Max, cheap fallback when spent | Built-in rows (Opus, Sonnet, Fable) | This session |
| Keep every session cheap | `barrito pin personal glm-5.3` or `/barrito pin glm-5.3` | Every session of that identity |
| Never fall back; show the quota error | `barrito pin work max` | Every session of that identity |

When Max runs out mid-session the `/model` label still says Opus — barrito can't change Claude Code's selection — so the statusline is the source of truth. Pins apply on the next API call, including inside a running turn.

## Token savers

Two transforms run inside the router, so every harness gets them — Claude Code, Codex, OpenCode, custom — with zero per-tool setup. Both are one command from off.

- **RTK** compresses noisy tool output (git diffs, listings, grep, test and build logs) through your installed `rtk` before it reaches the model. Each output is compressed once and cached, so prompt caching stays intact. Requires `rtk` on PATH — `doctor` warns when it's on but missing. Default on.
- **Caveman** trims reply prose — `off · lite · full · ultra`. Code, commands and errors stay verbatim. Default `lite`.

```toml
[transforms]
rtk = true
caveman = "lite"

[identities.personal.transforms]
caveman = "ultra"
```

Set them per identity — `barrito set work caveman ultra`, `barrito set personal rtk off`, `barrito set work --reset` (back to the config defaults) — or from inside Claude Code: `/barrito rtk on`, `/barrito caveman ultra`, which target the session's identity (`$BARRITO_IDENTITY`). The statusline shows what's active (`work | Max 62% | rtk | cave:lite`) and `barrito status` shows tokens saved today.

RTK is its authors' tool — barrito just pipes through it.

## Models

Claude Code can't discover gateway models under Max OAuth, so the picker has to be written. `barrito models sync` pulls the gateway catalog, applies your rules, and renders `modelPicker` rows plus generated subagent files into every identity's Claude config dir. Rerunnable and idempotent. Other harnesses need nothing: OpenCode reads the catalog itself, Codex takes any ID via `-m`, Cursor uses its own models.

```toml
[models]
include = ["zai/*", "deepseek/*", "openai/gpt-6*", "google/gemini-3.8*", "anthropic/*"]
exclude = ["*-preview", "*-0731"]
require = ["tool-use"]          # Claude Code needs tool calling
max_input_price = 5.00          # $/1M input
pin = ["meta/muse-spark-1.3-contributor"]
labels = { "openai/gpt-6-astra" = "GPT-6 Astra · heavy / 2nd opinion" }
```

Filter order: `require` → `include` → `exclude` → `max_input_price`, then `pin` entries added back.

```
$ barrito models sync --dry-run
  + zai/glm-5.4                    $0.55 / $2.10   new
  + deepseek/deepseek-v4.2-flash   $0.14 / $0.28   new
  - stepfun/step-3.7-flash         retired from gateway
  = 11 unchanged
  → ~/.claude, ~/.claude-personal
```

`sync` never runs on its own; `doctor` and `status` nudge when new models match your rules, and flag retired models still referenced by a fallback chain or subagent.

## Graft (optional, per repo)

```
barrito graft                                    # scan, ranked by tracked LOC, pick repos
barrito graft add ~/Code/acme/web --summaries
barrito graft build [path]
```

Wiring runs `graft init --yes --no-global --no-statusline --no-agents --no-build`, then `graft build`, and offers to install `@nanonets/graft` if missing. `graft init` writes tracked files (`.claude/`, `.mcp.json`, `AGENTS.md`) — committing them is your call. When a shim launches in a worktree of a grafted repo with no `graft/`, barrito starts a detached background build and returns immediately. Summaries are off by default; when on, Graft talks to `{gateway}/v1` with the repo's identity handle, so each repo bills its own identity's gateway.

## Project histories

Claude Code keeps session history and per-project memory under `<claude_config_dir>/projects/<encoded cwd>/` (the launch cwd with every non-alphanumeric turned into `-`). Each identity has its own config dir, so a project whose sessions sit in another identity's dir is invisible to `/resume`.

```
barrito history sync                 # dry run: from → to per project, sessions, memory, how it resolved
barrito history sync --apply         # copy (never move) into the identity each project resolves to
```

Each project's original cwd comes from its newest session file's `cwd` (first matching line only), else the dir name walked back against the filesystem. The identity is resolved exactly like the router: git remote, then path glob, then the default. A cwd that no longer exists (a deleted emdash or Conductor worktree) is traced by session metadata — its worktree container name (`~/emdash/worktrees/<repo>-<hash>/…`, `<repo>/.emdash/…`, `~/conductor/workspaces/<repo>/…`) against `~/emdash/repositories/*`, `~/conductor/repos/*`, grafted repos and exact repo names in config remotes, or a feature `gitBranch` that still exists in exactly one identity's repos — and anything still ambiguous is `unknown`, listed and never guessed (`--include-unknown <identity>` copies those too). `--apply` copies file by file: a destination with identical size + mtime (or identical bytes) is skipped, a differing one is never overwritten (reported as a conflict), mtimes are preserved and `memory/` comes along. Re-runs copy nothing. `init` plans the same copy (`+ copy N project histories to <identity> (resolved by remote/path)`) and `doctor` warns while misplaced histories remain.

## Command reference

Every command answers `--help` before doing anything. The CLI also answers `--version`.

| Command | Does |
| --- | --- |
| `barrito init [--dry-run] [--yes]` | Wizard: detect, identities, logins, fallback, graft, write everything. Prints the plan before writing. Re-run to edit; `--dry-run` writes nothing. |
| `barrito status [--json] [--markdown]` | Tier per identity, Max 5h/7d usage, reset times, API spend today, plus a note per identity with throttled 429s passed to Claude Code today. `--json` dumps the raw router payload; `--markdown` renders the same table for step summaries. |
| `barrito which [path] [--json]` | Identity for a path and the rule that matched (env, remote, path, default). |
| `barrito doctor [--json]` | PATH order, shims, service health, logins, secret refs, catalog drift, host restarts needed. Non-zero exit on any ✗. |
| `barrito history sync [--apply] [--json] [--include-unknown <identity>]` | Find project histories (sessions + memory) living in the wrong identity's Claude dir; dry run by default, `--apply` copies them (never moves or overwrites). |
| `barrito pin <identity> <max\|model>` | Identity-wide default for every session. `max` never falls back. A model can be a full gateway id or a short suffix (`glm-5.3`); short names resolve against the cached catalog, preferring the identity's fallback chain, then the picker. Ambiguous or unknown names exit 2. |
| `barrito unpin <identity>` | Clear the pin; the tier state machine decides again per request. |
| `barrito set <identity> [rtk on\|off] [caveman off\|lite\|full\|ultra] [--reset]` | Token savers for one identity. `rtk on/off`, `caveman off/lite/full/ultra`; `--reset` returns the identity to the config defaults (`[transforms]` + `[identities.<id>.transforms]`). |
| `barrito models [sync\|search\|add\|rm]` | Show the picker; sync from the catalog (`--dry-run`, `--all`, `--json`); search with prices (no write); pin or drop one. |
| `barrito graft [add\|rm\|build] [path]` | Repo checklist, wire and build graphs. `--json` lists configured repos. |
| `barrito shim [harness…] [--dir <path>] [--force]` | (Re)generate shims; every known harness with no arguments. |
| `barrito exec <bin> [--] [args…]` | Run any binary with its identity applied — what shims call. |
| `barrito env [--shell] [--harness <name>] [path]` | Print the env for a path's identity; `--shell` emits export lines for eval. direnv users: `eval "$(barrito env --shell)"`. |
| `barrito logs [-f] [-n <lines>]` | Router log — one line per request, never headers or bodies. `-f` follows (rotation-safe). |
| `barrito serve [--detach]` | Run the router in the foreground (the service runs this). `--detach` backgrounds it with a pidfile, for containers and hosts without a service manager. |
| `barrito stop` | Stop a detached router (pidfile). A service-managed router is not ours to kill — this says how to stop it instead. |
| `barrito ci [--identity …] [--gateway-key env:…] [--fallback …] [--port …] [--config <file>]` / `barrito ci stop` | GitHub Actions setup/teardown. `ci` writes shims + router env, starts the router detached and waits for `/health`; `stop` writes the step summary and tears down. See below. |
| `barrito statusline [--append <command>]` | Claude Code statusline hook: identity, tier, Max usage, API spend and reset in one line. Never throws; `--append` runs another statusline first. |
| `barrito uninstall [--restore [--from <ts>]] [--list-backups] [--yes]` | Remove the service, shims and settings fragments; `--restore` puts the newest backup that has entries back (`--from <ts>` picks one, `--list-backups` lists them). |
| `/barrito [status\|pin <model>\|unpin\|rtk on\|off\|caveman <level>]` | Slash command inside Claude Code, scoped to the session's identity (`$BARRITO_IDENTITY`) — also toggles token savers: `/barrito caveman ultra`, `/barrito rtk off`. |

## Platforms

macOS is the first-class host: Keychain for secrets, a launchd service (`dev.barrito.router`), native notifications (`terminal-notifier` if present, else `osascript`; `brew install terminal-notifier` to show the burrito icon).

Linux runs the same router and CLI: `secret-tool` for secrets, a `systemd --user` unit at `~/.config/systemd/user/barrito.service`, `notify-send` when a display exists, XDG paths for config and state. `init` suggests `loginctl enable-linger <user>` so the router survives logout; without a user session bus, barrito points you at `serve --detach` instead of writing a broken unit.

CI and containers have neither keyring nor service manager. Secrets come from `env:`/`file:` refs, the router runs via `barrito serve --detach` and stops with `barrito stop`, and `barrito ci` covers GitHub Actions end to end.

## Secrets

A keychain slot in config.toml takes three ref forms:

| Ref | Reads from |
| --- | --- |
| `barrito: gateway work` (plain name) | The platform keyring — a Keychain item on macOS, `secret-tool` on Linux. |
| `env:AI_GATEWAY_API_KEY` | The environment variable, trimmed. |
| `file:~/.config/barrito/gateway.key` | The file, trimmed. |

On macOS barrito owns its Keychain items: names `barrito: <slot> <identity>`, account `barrito`, created with `-T /usr/bin/security` — creation never asks, and reads through `/usr/bin/security` never prompt again. When `init` finds the planned config pointing at an item made by another tool (e.g. `Vercel AI Gateway` from the Vercel CLI), it copies it once into the barrito-owned item — one macOS prompt per key — and repoints the config; the original is never modified or deleted, so the tool that made it keeps working. `barrito keychain own` does the same standalone for an existing config, and `uninstall --restore` removes the copies. A re-run of `init` where the config already points at `barrito: …` items plans zero keychain actions.

### Every overwrite is backed up first

barrito never overwrites an existing secret without saving the old value. Before any write that would replace an item (`init`, `keychain own`, `keychain restore`, `uninstall --restore`), it reads the current value and copies it into `barrito backup: <service> <ts>` (account `barrito`) **inside the keyring** — never on disk — through the same verified write path. A `file:` secret gets a `0600` sibling `<file>.barrito-bak-<ts>` instead. New items and unchanged values make no backup; if the current value can't be read, the overwrite is refused. The newest 3 backups per item are kept. `init` records each backup by name in its backup manifest (names only, never values).

```
barrito keychain backups                                            # names + timestamps, never values
barrito keychain restore "barrito: gateway work"                    # newest backup
barrito keychain restore "barrito: gateway work" --from 2026-10-02T14:05
```

A restore backs up the value it replaces, then deletes the backup it used. `doctor` warns when an item has more than 3 backups or the newest manifest names a backup that is gone.

`file:` is guarded both ways. barrito writes secrets only at `0600`, atomically, and refuses to write through a symlink or into a group/world-writable directory without the sticky bit. Reads refuse a symlink whose target isn't owned by you or isn't private. `env:` refs are read-only — `set` throws. `doctor` reports each ref by kind, so a keyring name on a box with no keyring is a visible ✗, not a silent failure.

No secrets in the config file either way. The router reads them itself and agents only ever hold the handle `barrito:<id>` — cursor-agent is the one exception, it needs the raw Cursor key in its env.

## GitHub Actions

```yaml
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- run: npx barrito ci --identity ci --gateway-key env:AI_GATEWAY_API_KEY --fallback zai/glm-5.3
  env:
    AI_GATEWAY_API_KEY: ${{ secrets.AI_GATEWAY_API_KEY }}
- run: claude -p "fix the failing test"
  env:
    CLAUDE_CODE_OAUTH_TOKEN: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
- if: always()
  run: npx barrito ci stop    # writes tier changes + API spend to the step summary
```

`barrito ci` writes shims to `$GITHUB_PATH`, the router env (`BARRITO_CONFIG`/`STATE`/`SHIMS`/`LOG`/`IDENTITY`) to `$GITHUB_ENV`, starts the router detached under `$RUNNER_TEMP` and waits for `/health`. Keyring item names can't resolve on a runner, so `--gateway-key` (and any identity in a `--config` file) must be an `env:` or `file:` ref; any value containing a newline is refused before anything is written. `barrito ci stop` runs `status --markdown` into `$GITHUB_STEP_SUMMARY` and tears down — it never fails the job, so pair it with `if: always()`.

Tier changes surface as GitHub annotations (`::warning` when Max is spent, `::notice` when it's back). Without `CLAUDE_CODE_OAUTH_TOKEN` the job still runs — on the gateway chain only — and `ci` prints a notice saying so.

Compliance holds in CI: Max only ever flows through genuine Claude Code using `CLAUDE_CODE_OAUTH_TOKEN`. Every other tool stays on the repo's gateway key.

## Configuration

`~/.config/barrito/config.toml`:

```toml
port = 4141
default = "personal"

[identities.work]
claude_config_dir = "~/.claude"
fallback = ["zai/glm-5.3", "deepseek/deepseek-v4.1-flash"]
match.remotes = ["github.com/acme/*"]
match.paths = ["~/Code/acme/**"]
keychain.gateway = "barrito: gateway work"
keychain.cursor = "barrito: cursor work"

[identities.personal]
claude_config_dir = "~/.claude-personal"
share_from = "~/.claude"      # symlink rules/ skills/ agents/ CLAUDE.md
fallback = ["zai/glm-5.3", "deepseek/deepseek-v4.1-flash"]
match.remotes = ["github.com/you/*"]
match.paths = ["~/Code/you/**"]
keychain.gateway = "barrito: gateway personal"
keychain.cursor = "barrito: cursor personal"

[graft]
roots = ["~/Code", "~/emdash/repositories"]
repos = [{ path = "~/Code/acme/api", summaries = false }]
```

Keychain slots accept any ref form above; `init` writes `env:` refs automatically on machines with no keyring.

## Compliant by design

- Max OAuth only ever originates from genuine Claude Code → Anthropic direct.
- Non-Claude-Code tools never touch Max → gateway keys only.
- Fallback = a different provider on your paid gateway key, not another subscription.

barrito won't pool subscriptions, replay OAuth tokens into other tools, spoof clients, or translate formats.

## Files & state

Every path has an env override: `BARRITO_CONFIG`, `BARRITO_STATE`, `BARRITO_LOG`, `BARRITO_SHIMS`, plus `BARRITO_HOME` for tests.

| What | macOS | Linux |
| --- | --- | --- |
| Config | `~/.config/barrito/config.toml` | `$XDG_CONFIG_HOME/barrito/config.toml` |
| State | `~/.local/state/barrito/` | `$XDG_STATE_HOME/barrito/` |
| Log | `~/Library/Logs/barrito.log` | `<state>/barrito.log` |
| Service | `~/Library/LaunchAgents/dev.barrito.router.plist` | `~/.config/systemd/user/barrito.service` |
| Shims | `~/.local/shims/` | `~/.local/shims/` |
| Backups | `~/.config/barrito/backup/<ts>/` | same |

The state dir holds `which.json` (identity cache), `tiers.json` (tier state), `spend.json` (daily API spend), `catalog.json` (gateway model cache), `graft-scan.json`, `graft-build/` (build locks) and `barrito.pid` (the detached router's pidfile). The log size-rotates in-process (5 MB, keeps 3).

## Uninstall

```
barrito uninstall --restore
```

Removes the service, generated shims, the marked PATH block and settings fragments. `--restore` puts back the previous router, shims and symlinks that `init` backed up, and every keychain item `init` overwrote — each from its in-keyring backup (verified write, then the backup item is deleted; a missing backup is skipped with a warning).

## Development

```
git clone https://github.com/tbarho/barrito && cd barrito
yarn
yarn verify
```

Strict TypeScript: Node ≥ 22.18 runs `.ts` directly; `tsc` builds `dist/` for npm. Runtime deps: `@clack/prompts`, `picocolors`, `smol-toml`.

- `yarn verify` — typecheck + tests
- `yarn build` — emit `dist/`
- `yarn e2e` — the full `barrito ci` flow against fake upstreams (direct hop, quota fallback, gateway proxy, `ci stop` summary)
- `yarn smoke` — build, pack, install into a temp prefix, prove the dist runs standalone

There is no `yarn check` — it's a yarn 1 builtin, not one of our scripts; use `yarn verify`. Tests never touch the real HOME, Keychain or network.

## Release

Push a tag `v*`. `.github/workflows/release.yml` runs `yarn verify && yarn e2e && yarn smoke`, checks the tag matches `package.json`, publishes to npm with provenance, then renders the Homebrew formula from `packaging/homebrew/barrito.rb` into `tbarho/homebrew-tap` (releasing twice concurrently queues; an in-flight release is never cancelled). Secrets: `NPM_TOKEN` (npm automation token) and `HOMEBREW_TAP_TOKEN` (classic PAT with write access to the tap).

MIT
