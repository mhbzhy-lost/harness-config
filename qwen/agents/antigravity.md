---
name: antigravity
description: Delegate one self-contained task to the Google Antigravity CLI (agy acp), using its own authentication, Gemini models and tools — bills to the Antigravity subscription, not Qwen channels. Foreground by default.
executor:
  kind: acp
  command: agy
  args:
    - acp
---
Complete the delegated task and report the verified result.
