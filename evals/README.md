# Evals

What only a real model can show: Claude driving a `via` agent end to end. Everything else is a test (see CONTRIBUTING.md, Tests).

`pnpm eval` runs these with `claude plugin eval`, on Haiku as the main model, capped at $0.50; a run costs about $0.01. `--allow-real-servers` starts `via`'s own `step` server, which `via` agents need. Run before a release and after a harness bump; not in CI, as it needs your Claude login.

Each case runs in a fresh home, so only a harness with no login of its own runs here: OpenCode on its free models. Codex, agy and pi need your logins; `relay/checks/` covers them live.
