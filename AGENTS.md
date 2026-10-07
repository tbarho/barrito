# barrito — Agent Development Guide

This repository is designed for reliable AI coding agent work.

## Quick Reference

**Technical Contracts:** See [`CONTRACTS.md`](CONTRACTS.md) for module signatures, style rules (strict TypeScript, minimal names, guard clauses, DRY), and comprehensive API documentation.

**Verification Commands:**

```bash
yarn verify     # typecheck + tests (~32s)
yarn build      # emit dist/ (~0.3s)
yarn e2e        # full barrito ci flow against fake upstreams (~0.8s)
yarn smoke      # pack, install to temp prefix, prove dist runs (~1.8s)
```

**Requirements:**
- Node.js ≥ 22.18 (see [`.nvmrc`](.nvmrc))
- yarn package manager

**Configuration Examples:**
- [`config.toml.example`](config.toml.example) — annotated barrito configuration
- [`.env.example`](.env.example) — environment variable overrides

## Development Workflow

1. Read `CONTRACTS.md` for style rules and module contracts
2. Tests use `node:test` + `node:assert/strict`, live in `test/<module>.test.ts`
3. Tests inject fakes via options objects, never touch real HOME/Keychain/network
4. Run `yarn verify` before committing (CI runs this on every PR)

## Codebase Structure

```
src/
├── cli/         # Command implementations (init, status, doctor, etc.)
├── router/      # HTTP router, tier state machine, transforms
├── keychain/    # Platform keyring adapters (macOS Keychain, Linux secret-tool)
├── service/     # Service managers (launchd, systemd)
└── *.ts         # Core modules (config, identity, graft, models, etc.)

test/
├── *.test.ts    # Unit tests mirroring src/ structure
├── e2e/         # End-to-end CI flow tests
└── fixtures/    # Test fixtures and mock data
```

Router code (`src/router/**`) imports only Node builtins, `src/types.ts`, and its siblings — no CLI or config dependencies.

## Testing Philosophy

- Every function touching the outside world (fs, exec, git, fetch, clock) accepts it via options
- Tests inject fakes: `{ exec: mockExec, fs: mockFs, now: () => fixedTimestamp }`
- Zero flaky tests: deterministic, fast, isolated
- Coverage: 652 test cases across 35 test files

## Style Highlights (from CONTRACTS.md)

- Strict TypeScript: `noUncheckedIndexedAccess`, `erasableSyntaxOnly`, `verbatimModuleSyntax`
- No `any`, `enum`, `namespace`, or parameter properties
- Minimal names: `snooze()` not `handleSnoozeAction()`
- Guard clauses / early return, no nested `if`, no `else` unless unavoidable
- Comments only when absolutely necessary
- Relative imports use `.ts` extension

## External Dependencies

Runtime (minimal):
- `@clack/prompts` — CLI prompts
- `picocolors` — terminal colors
- `smol-toml` — TOML parser

Development:
- `typescript` — type checking and build
- `@types/node` — Node.js type definitions

Optional runtime binaries (documented in README):
- `rtk` — compresses noisy tool output
- `terminal-notifier` (macOS) — native notifications
- `secret-tool` (Linux) — keyring access
- `@nanonets/graft` — repo graph builder

## CI Configuration

See [`.github/workflows/ci.yml`](.github/workflows/ci.yml) for the full test matrix:
- Platforms: macOS, Ubuntu
- Node versions: 22.x, 26.x
- Tests: `yarn verify`, `yarn smoke`, `yarn e2e`
- Container test: proves env: refs and detached router work without keyring

## For More Detail

Everything you need is in [`CONTRACTS.md`](CONTRACTS.md) — module ownership, function signatures, state management, testing patterns, and the complete style guide.
