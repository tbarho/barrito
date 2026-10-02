// Usage text per command; the dispatcher derives its command list from these keys
// and prints them for `<command> --help` before importing the command.

export const usage: Record<string, string> = {
  init: `usage: barrito init [--dry-run] [--yes]

Create-next-app-style wizard: detect harnesses and identities, check logins and
keychain items, pick the Max fallback chain, graft repos, then write config,
shims, service and statusline. Re-running edits the existing setup — it never
duplicates. Prints a diff before writing anything.

  barrito init              # interactive
  barrito init --dry-run    # show the diff, write nothing`,
  status: `usage: barrito status [--json] [--markdown]

Tier per identity, Max 5h/7d utilization, reset times and API spend today.
--json dumps the raw router payload; --markdown renders the same table for step
summaries.

  barrito status --markdown`,
  which: `usage: barrito which [path] [--json]

Identity for a path and the rule that matched (env, remote, path, default).
Defaults to the current directory.

  barrito which ~/Code/acme`,
  doctor: `usage: barrito doctor [--json]

Check PATH order, shims, router/service health, logins, keychain items, model
catalog freshness, and hosts that need a restart. Exits non-zero on any ✗.

  barrito doctor --json`,
  pin: `usage: barrito pin <identity> <max|model>

Identity-wide default for every session. 'max' never falls back — quota errors
surface instead. A model can be a full gateway id or a short suffix; short names
resolve against the cached catalog, preferring the identity's fallback chain,
then the model picker. Ambiguous or unknown short names exit 2.

  barrito pin personal glm-5.3   # stay cheap even after reset
  barrito pin work max            # never fall back`,
  unpin: `usage: barrito unpin <identity>

Clear the identity-wide pin; the tier state machine decides again per request.

  barrito unpin personal`,
  set: `usage: barrito set <identity> [rtk on|off] [caveman off|lite|full|ultra] [--reset]

Per-identity token savers. rtk compresses noisy tool output before it hits the
model (needs the rtk binary); caveman asks the model for terser replies. --reset
returns the identity to the config defaults.

  barrito set personal rtk on caveman ultra
  barrito set work --reset`,
  models: `usage: barrito models [sync [--dry-run] [--all] [--json] | search <q> | add <id> | rm <id>]

sync rewrites the Claude Code model picker from the gateway catalog by your
rules; search browses with prices (no write); add pins one model; rm drops one.

  barrito models sync --dry-run
  barrito models search glm`,
  graft: `usage: barrito graft [add|rm|build] [path] [--summaries] [--json]

Repo checklist: add wires and builds a repo's graphs (optionally with
summaries), rm removes it, build rebuilds. Defaults to the current directory.

  barrito graft add ~/Code/acme/web --summaries`,
  shim: `usage: barrito shim [harness…] [--dir <path>] [--force]

(Re)generate shims for built-in or config-defined harnesses. With no arguments,
every known harness. Shims exec the real binary with its identity applied.

  barrito shim mybot`,
  exec: `usage: barrito exec <bin> [--] [args…]

Run any binary with its identity applied — what shims call. A single -- right
after the bin is stripped so leading flags pass through untouched.

  barrito exec claude -- -p "fix it"`,
  env: `usage: barrito env [--shell] [--harness <name>] [path]

Print the environment for a path's identity; --shell emits export lines (and
\`exit n\` on failure) for eval. direnv users: eval "$(barrito env --shell)".

  barrito env --shell`,
  logs: `usage: barrito logs [-f] [-n <lines>]

Tail the router log — one line per request, no headers or bodies. -f follows
(rotation-safe); -n tails fewer lines.

  barrito logs -f`,
  serve: `usage: barrito serve [--detach]

Run the router in the foreground (the service runs this). --detach backgrounds
it with a pidfile for containers and hosts without a service manager.

  barrito serve --detach`,
  stop: `usage: barrito stop

Stop a detached router (pidfile). A service-managed router is not ours to
kill — this says how to stop it instead. \`barrito ci stop\` does the same for CI.

  barrito stop`,
  ci: `usage: barrito ci [--identity …] [--gateway-key env:…] [--fallback …] [--port …] [--config <file>]
       barrito ci stop

GitHub Actions setup/teardown. Writes shims to $GITHUB_PATH and router env to
$GITHUB_ENV, starts the router detached and waits for /health. stop writes
\`status --markdown\` into $GITHUB_STEP_SUMMARY and tears down.

  barrito ci --identity work --gateway-key env:WORK_GATEWAY_KEY`,
  statusline: `usage: barrito statusline [--append <command>]

Claude Code statusline hook: reads the stdin JSON and prints one line —
identity, tier, Max usage, API spend and reset. Never throws. --append runs
another statusline first and puts its output before ours.

  barrito statusline --append their-statusline`,
  uninstall: `usage: barrito uninstall [--restore] [--yes]

Remove the service, shims and settings fragments. --restore puts the backed-up
setup back instead of leaving a bare machine.

  barrito uninstall --restore`,
}
