# crew personas example

A test project with one persona, `.agents/agents/scout.md`: it runs in Pi, read-only (`read, grep, find, ls`), and always ends its answer with the line `-- scout (pi persona) MARKER-7Q2`.

Needs `pi` on PATH, signed in.

From this folder (`example/`), run:

```
claude --plugin-dir ~/projects/via-personas --dangerously-skip-permissions
```

## Acceptance checks

1. `@scout` (or the agent list) shows `crew:scout`.
2. Ask: "Ask scout what files are in this folder". The subagent runs in Pi (its steps show as `step` tool rows), the answer contains `MARKER-7Q2`, and a model id appears at the end.
3. A follow-up to that agent through SendMessage remembers the first answer (for example "Ask scout which file it listed first").
4. The same request with "in the background" returns when done.
