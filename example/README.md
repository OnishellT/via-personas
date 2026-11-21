# crew personas example

A test project with a Pi persona and a ZCode persona (`zscout`, ending `-- zscout (zcode persona) MARKER-Z9K`). The Pi persona is `.agents/agents/scout.md`: it runs in Pi, read-only (`read, grep, find, ls`), and always ends its answer with the line `-- scout (pi persona) MARKER-7Q2`.

Needs `pi` (for `scout`) and `zcode` (for `zscout`) on PATH, signed in. Each persona only shows up when its harness is installed.

From this folder (`example/`), run:

```
claude --plugin-dir ~/projects/via-personas --dangerously-skip-permissions
```

## Acceptance checks

1. `@scout` (or the agent list) shows `crew:scout`.
2. Ask: "Ask scout what files are in this folder". The subagent runs in Pi (its steps show as `step` tool rows), the answer contains `MARKER-7Q2`, and a model id appears at the end.
3. A follow-up to that agent through SendMessage remembers the first answer (for example "Ask scout which file it listed first").
4. The same request with "in the background" returns when done.
