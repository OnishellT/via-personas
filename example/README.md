# crew personas example

A test project with one persona per harness, each ending its answer with its own marker line. Each persona only shows up when its harness is installed (binary on PATH) and signed in.

| Agent type | File | Harness | Marker |
| --- | --- | --- | --- |
| `crew:scout` | `.agents/agents/scout.md` | pi (read-only: `read, grep, find, ls`) | `MARKER-7Q2` |
| `crew:cx-scout` | `.agents/agents/cx-scout.md` | codex | `MARKER-CX5` |
| `crew:oc-scout` | `.agents/agents/oc-scout.md` | opencode | `MARKER-OC3` |
| `crew:ag-scout` | `.agents/agents/ag-scout.md` | agy | `MARKER-AG8` |
| `crew:ranger` | `.agents/agents/ranger.md` | cursor (no `tools` line: cursor can't enforce read-only) | `MARKER-4K9` |
| `crew:zscout` | `.agents/agents/zscout.md` | zcode | `MARKER-Z9K` |

The generic foreign subagents `crew:pi`, `crew:codex`, `crew:opencode`, `crew:agy`, `crew:cursor` and `crew:zcode` have no persona and never print a marker.

Install Crew at project scope from this folder (`example/`):

```
claude plugin marketplace add OnishellT/via-personas
claude plugin install crew@crew --scope project
claude --dangerously-skip-permissions
```

To try a checkout instead, use `claude plugin marketplace add ~/projects/via-personas` for the first command. Don't use `--plugin-dir` or user scope for acceptance runs.

## Acceptance checks

Run these for every harness, with its generic type `crew:<harness>` and with its persona:

1. The agent list shows `crew:<harness>` and the persona's `crew:<name>`.
2. Ask: "Ask <agent> what files are in this folder". The subagent runs in its harness, its steps show as `step` tool rows, and a model id appears at the end. The persona's answer contains its marker; the generic one has none.
3. A follow-up to that agent through SendMessage remembers the first answer (for example "Ask it which file it listed first").
4. The same request with "in the background" returns when done.
