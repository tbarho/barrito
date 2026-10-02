// Hermetic test env: runner/CI/session variables must never change test behavior
const prefixes = /^(GITHUB_|RUNNER_|XDG_|BARRITO_)/
const names = new Set([
  'CI',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'AI_GATEWAY_API_KEY',
  'CURSOR_API_KEY',
  'DISPLAY',
  'WAYLAND_DISPLAY',
])

Object.keys(process.env)
  .filter((key) => prefixes.test(key) || names.has(key))
  .forEach((key) => {
    delete process.env[key]
  })
