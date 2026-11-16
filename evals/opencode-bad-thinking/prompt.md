---
name: opencode-bad-thinking
tags: [smoke]
max_turns: 6
timeout_seconds: 300
---

Use the via:opencode agent. Start the prompt you give it with exactly these two lines:

model: opencode/beam-free
thinking: ultra

Then ask it: Reply with only OK. Repeat whatever comes back word for word.
