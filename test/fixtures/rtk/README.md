# rtk pipe fixtures

Captured with rtk 0.49.0 on 2026-10-02 against real barrito repo command output, so
`test/transforms.test.ts` never needs the rtk binary installed. `<name>-raw.txt` is
the original command output; `<name>-filtered.txt` is byte-exact `rtk pipe --filter <f>`
output for the filter listed below. If your rtk version differs, only the optional
"real rtk" test runs — it asserts savings, not exact fixture bytes.

| name       | command that produced the raw sample              | pipe filter |
| ---------- | -------------------------------------------------- | ----------- |
| gitdiff    | `git diff HEAD~3`                                  | git-diff    |
| gitlog     | `git log -30`                                      | git-log     |
| grep       | `grep -rn barrito src/router src/cli src/service`   | grep        |
| find       | `find src test scripts bin packaging -type f`      | find        |
| gitstatus  | `git status --porcelain -b` (112 B — size-floor case) | —         |
| noise      | text no filter recognizes (empty-output case)      | git-diff    |

Recapture with: `<name>-raw.txt` content | `rtk pipe --filter <f> > <name>-filtered.txt`.
