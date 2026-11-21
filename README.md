# crew

## Fork: crew personas

`crew` is a fork of [via](https://github.com/SeanLF/claude-code-subagent-harnesses) by Sean Floyd (MIT, licence kept), renamed `via` to `crew` (plugin, marketplace, step tool `mcp__plugin_crew_step__step`, data dir `~/.claude/crew/`). Everything below this section is upstream's, with the name changed.

What this fork adds: **personas**. A file `.agents/agents/<name>.md` in the session's folder, with `name`, `description`, `harness: pi`, `codex`, `opencode`, `agy`, `cursor` or `zcode` and optionally `harness-model`, `tools`, `thinking` in its frontmatter and the instructions as its body, becomes the agent type `crew:<name>`. The host spawns it like any subagent; its harness gets the instructions through its own system-prompt channel when it has one (pi: `--append-system-prompt`, codex: `developer_instructions`, on every run, follow-ups included); opencode, agy, cursor and zcode get them as a `<persona name="…">…</persona>` block at the start of the session's first prompt, not repeated on follow-ups. `harness-model`, `tools` and `thinking` are defaults that a `model:`, `tools:` or `thinking:` prompt line overrides. The per-harness types (`crew:pi`, `crew:codex`, ...) work as before. Try it in [example/](example/README.md), which has one persona per harness, each with its own marker.

### Personas and generic subagents

Each installed harness has a **generic foreign subagent**, `crew:pi`, `crew:codex`, `crew:opencode`, `crew:agy`, `crew:cursor` and `crew:zcode`. It has no persona and just follows the host's prompt. A **persona** is optional: it adds `crew:<name>` next to the generic type, running on the harness the persona names. A persona's name can't equal a harness name.

| Harness | How the persona reaches it |
| --- | --- |
| pi | `--append-system-prompt`, on every run |
| codex | `developer_instructions`, on every request |
| opencode, agy, cursor, zcode | a `<persona name="…">…</persona>` block at the start of the session's first prompt, not repeated on follow-ups |

A persona with a non-`claude` harness gets no `.claude/agents` link, so Claude never also runs it natively.

## Install

```
claude plugin marketplace add OnishellT/via-personas
claude plugin install crew@crew --scope project
```

(`/plugin install crew@crew` inside Claude Code does the same.)

# via (upstream README)

Claude hands a task to Codex, Antigravity, OpenCode or pi, and each runs it through its own CLI and login, as a Claude Code subagent.

![A crew:codex agent in Claude Code, its steps folded into lines such as "Ran 4 commands"](https://github.com/user-attachments/assets/e36113c3-b375-4f0d-99ae-5851e73105e9)

## Set up

`/plugin marketplace add OnishellT/via-personas`, then `/plugin install crew@crew` in Claude Code, or from a shell:

```
claude plugin marketplace add OnishellT/via-personas
claude plugin install crew@crew
```

Needs Node 22.18 or later on PATH; Codex also needs npm. Install at least one harness: [Codex](https://github.com/openai/codex), [Antigravity CLI](https://github.com/google-antigravity/antigravity-cli), [OpenCode](https://opencode.ai), [Cursor](https://cursor.com/cli) (`cursor-agent`), [pi](https://pi.dev) or ZCode (`zcode`). Your agent can run the installs; signing in opens a browser, so that part is yours. Restart Claude Code afterwards, and again after adding another harness, so it sees what's on your PATH. Tested on macOS, CI also runs on Linux; Windows is untested.

## Who it's for

Claude Code users who also pay for ChatGPT or Google AI, or want OpenCode's free models, and want to hand off tasks or get a second model's review without switching windows.

Codex and the Antigravity CLI (`agy`) are OpenAI's and Google's own tools, so you sign in to them directly. Google has [suspended accounts](https://discuss.ai.google.dev/t/paid-pro-subscriber-banned-instantly-for-testing-opencode-oauth/124403) whose Google login was used through third-party tools, though it later said it was lifting those bans. `via` stores no credentials, and no Claude subagent sits in between: the harness's work costs no Claude tokens; Claude only writes the task and reads the answer.

Not for you if:

- Claude Code isn't your main window: use a harness that switches models itself (OpenCode, pi, Cursor).
- You want Claude Code itself to run on another model: [claude-code-router](https://github.com/musistudio/claude-code-router).

Pairs with OpenAI's [codex-plugin-cc](https://github.com/openai/codex-plugin-cc) if you want its review commands, a review before Claude stops, or to move a session into Codex.

## What I've used it for

- Codex, to spend my ChatGPT plan too: a TypeScript migration one slice per agent, refactors, mutation testing.
- Free models for small tasks, on OpenCode's free tier or OpenRouter through pi.
- A review by a model that didn't write the code.
- The same fix on two models, to see which one is good enough.

> [!IMPORTANT]
> - Each harness runs its own tools as you, with its own permission settings, outside Claude Code's. The one thing `via` enforces is read-only: plan mode, or `tools: read` at the top of the prompt. Codex, OpenCode and pi then can't write. agy, cursor and zcode have no enforceable read-only mode, so `via` won't run them in one. zcode runs on its own global default model: a `model:` line is refused.
> - Outside read-only, a repository's `.codex`, `.opencode` and `.pi` config loads, as if you had trusted it. In a repository you didn't write, use `tools: read`. Codex and OpenCode then won't run at all in a repository that has its own `.codex` or `.opencode` folder.
> - pi and OpenCode are third-party clients. A subscription login there is subject to that provider's rules for third-party clients.

## Use

Ask in plain language: "Have codex review src/api". Optional lines at the top of the prompt set options. They carry over to that agent's follow-ups.

| Line | Effect |
| --- | --- |
| `model: <model>` | The harness's model |
| `tools: read` | Read-only, whatever the permission mode |
| `thinking: <level>` | Reasoning effort; a level the harness or model doesn't have is refused |
| `config: <option>=<value>` | Codex and OpenCode: one of the harness's own options that tune its model, such as `fast-mode=on`; one per line, `fast-mode=` drops it. Never a mode or sandbox option, and none in a read-only run |
| `crew-help` | Lists the harness's options instead of running it |

At session start Crew adds a short **crew guide** to Claude's context (about 660 tokens, built from the cached model lists, so it costs no wait): how to spawn `crew:<harness>` and `crew:<persona>`, the lines above, two models per harness, the default model of pi, codex and ZCode (read from their own settings; the plugin's `defaultModel` setting wins for pi), a plain "its own pick" for agy and opencode, which have no setting to read, and the personas of the folder. Only installed harnesses are listed. `crew-help` is a prompt you send to an agent type, not a shell command.

A message to a running Codex, OpenCode or pi agent reaches it at its next step; `interrupt:` first stops the current step. That holds for Claude's SendMessage; one you type into the agent's view waits in Claude Code until the current step ends, so it can't cut a long command short. agy only takes follow-ups. A completed answer ends with the model the harness reports; one only taken from your `model:` line says `(requested)`, and a harness that won't say gets `model not reported`.

## Permissions

- **Read-only:** Codex runs in its read-only sandbox with MCP servers and plugins off; OpenCode and pi get reading tools only.
- **Bypass mode:** Codex runs with full access, no sandbox, as Claude Code itself does in bypass: its commands reach any file and the network.
- **Otherwise:** Codex works in its workspace sandbox and asks before going past it; OpenCode, pi and agy use their own permission settings. Codex also edits outside a Git repository.
- A harness's question (Codex past its sandbox, OpenCode where its config says `ask`, cursor before a command) shows in Claude Code's dialog with only a one-time allow and a deny. There's no "always allow", so no approval outlives the run. No answer, or `claude -p`, is a deny. Bypass mode approves; don't-ask mode denies. The mode is set when the agent starts; a follow-up to an agent that finished takes the current one. pi and agy never ask.
- When a harness starts its own subagent, `via` approves that call without asking you.

## Harnesses

Each loads its own user config and instructions files (agy reads your global `AGENTS.md`).

- `codex`: an interrupted command keeps running until the run ends. A subagent's task shows as its nested agent's prompt only with Codex's v1 subagent tools. Codex lets the model pick, and gpt-6-luna picks the v2 tools. These [send no task text](https://github.com/openai/codex/issues/61750), so the nested agent gets its title instead.
- `agy`: commands run in Antigravity's sandbox, away from credentials such as `~/.kube`; its own file edits are not sandboxed. Per its changelog, background tasks it starts, such as dev servers, outlive a headless run.
- `cursor`: `cursor-agent acp`, with the persona as a first-prompt block. `model:` takes cursor's own value with its brackets, such as `default[]` (the model in your cursor config), or `composer-2.5[fast=true]`, and there is no `thinking:` (the effort is inside the value). A Free plan only runs Auto and the models its plan includes; for the rest cursor answers "Upgrade your plan to continue" as if it were the answer. It asks before commands outside bypass mode, which the Claude Code dialog answers.
- `opencode`: a read-only run replaces your own `OPENCODE_CONFIG_CONTENT`.
- `pi`: any model pi reaches by API key or `/login`. On a ChatGPT login it runs pi's own tools, not Codex's sandbox. `tools:` takes a pi tool list: one of only `read`, `grep`, `find`, `ls` is read-only and skips the project's `.pi` extensions, even in a project you trusted; any other, such as `-bash,read`, can edit and loads them.

## Settings

In `/config`, or `pluginConfigs` in `settings.json`:

- `timeoutMinutes` (default 30): a longer run is stopped; its partial output is kept.
- `defaultModel`: pi's model when the prompt has no `model:` line.
- `codexAcp` (default `pinned`): `pinned` installs Codex's adapter from the lockfile `via` ships, hash-checked, no install scripts. `latest` installs the newest once per Claude Code session.

Claude Code doesn't know a harness model's context size and would stop a `via` agent at 200k tokens. While a Claude model is the main one, `via` raises `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, which only applies to models Claude Code doesn't know; any other non-Claude agent in the session gets the same window. A value you set is left alone, and `via` removes its own when `/model` switches to a non-Claude model.

## Develop

`mise install && pnpm install`, then `pnpm lint`, `pnpm test` and `pnpm validate`; see [CONTRIBUTING.md](CONTRIBUTING.md). Harness tool calls show in transcripts as calls to `via`'s `step` tool.

## Credit

Inspired by [pi-agent-for-claude](https://github.com/FazalAAli/pi-agent-for-claude) by Fazal Ali. [claudexor](https://github.com/razzant/claudexor)'s Antigravity adapter was prior art for `crew:agy`. The relay bundles the [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk) (Apache-2.0) and zod (MIT); see `relay/THIRD_PARTY_LICENSES`. MIT licence.
