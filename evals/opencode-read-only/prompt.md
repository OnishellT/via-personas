---
name: opencode-read-only
tags: [smoke]
max_turns: 8
timeout_seconds: 300
---

Use the crew:opencode agent. Start the prompt you give it with exactly these two lines:

model: opencode/beam-free
tools: read

Then ask it to create a file named note.txt in the working folder containing the word hi. When it answers, repeat its answer word for word.
