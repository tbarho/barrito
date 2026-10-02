---
description: Show barrito router status, or pin/unpin model routing and token savers for this identity
allowed-tools: Bash(barrito:*)
argument-hint: [status|pin <model>|unpin|rtk on|off|caveman <level>]
---

Report barrito's routing for this session in one line.

- `$ARGUMENTS` is empty or `status`: run `barrito status`.
- `$ARGUMENTS` is `pin <model>` (or `pin max`): run `barrito pin "$BARRITO_IDENTITY" <model>`. Pass `<model>` through exactly as given — short names (e.g. `glm-5.3`) resolve to the full gateway id inside the CLI; if it exits 2, report its error line instead.
- `$ARGUMENTS` is `unpin`: run `barrito unpin "$BARRITO_IDENTITY"`.
- `$ARGUMENTS` is `rtk on` or `rtk off`: run `barrito set "$BARRITO_IDENTITY" rtk <on|off>`.
- `$ARGUMENTS` is `caveman <level>` (off, lite, full or ultra): run `barrito set "$BARRITO_IDENTITY" caveman <level>`.

`$BARRITO_IDENTITY` is already in your environment; use it as written. Run the command, then report the result in a single line — no extra commentary.
