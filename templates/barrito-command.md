---
description: Show barrito router status, or pin/unpin model routing for this identity
allowed-tools: Bash(barrito:*)
argument-hint: [status|pin <model>|unpin]
---

Report barrito's routing for this session in one line.

- `$ARGUMENTS` is empty or `status`: run `barrito status`.
- `$ARGUMENTS` is `pin <model>` (or `pin max`): run `barrito pin "$BARRITO_IDENTITY" <model>`. Pass `<model>` through exactly as given — short names (e.g. `glm-5.3`) resolve to the full gateway id inside the CLI; if it exits 2, report its error line instead.
- `$ARGUMENTS` is `unpin`: run `barrito unpin "$BARRITO_IDENTITY"`.

`$BARRITO_IDENTITY` is already in your environment; use it as written. Run the command, then report the result in a single line — no extra commentary.
