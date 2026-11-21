---
name: opencode-follow-up
tags: [smoke]
max_turns: 10
allowed_tools: [SendMessage]
timeout_seconds: 400
---

Use the crew:opencode agent. Start the prompt you give it with this line:

model: opencode/beam-free

Then tell it: Remember the code word HERON and reply with only OK. When it has answered, send that same agent a follow-up message with SendMessage: What was the code word? Reply with only the word. Repeat its second answer word for word.
