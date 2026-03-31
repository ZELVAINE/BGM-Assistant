# 🏀 BGM Assistant

**A minimal, state-aware AI sidebar for Basketball GM.**

BGM Assistant is a Firefox extension that adds a smart sidebar to Basketball GM. It helps you think through decisions like a GM without pretending it can do things the game doesn’t allow.

It’s designed to feel like a **co-GM sitting next to you**, not a generic chatbot.

---

## Philosophy

- **Grounded, not theoretical.** Advice is based on Basketball GM mechanics, not real NBA assumptions.
- **Direct when it matters.** The assistant aims to give clear recommendations instead of vague suggestions, especially in Co-GM and Auto modes.
- **Minimal, not cluttered.** Clean chat-style UI with only the information that matters.
- **State-aware.** Decisions are based on your current roster, situation, and recent context — not just generic advice.

---

## What does it do?

BGM Assistant helps you:

- Evaluate your roster and team direction
- Get trade ideas (with improving realism and constraints)
- Navigate drafts and expansion drafts
- Make free agency decisions
- Decide what to do next in your current situation
- Understand *why* a decision makes sense (optional learning mode)

---

## Modes

The assistant changes behaviour depending on how much control you want:

- **Scout**  
  Only speaks when asked. Very brief, evaluation-focused.

- **Advisor**  
  Offers occasional insight. Balanced detail.

- **Co-GM**  
  Proactive and more directive. Flags issues and suggests actions.

- **Auto**  
  Tells you what to do next and why. Minimal fluff.

---

## Learning Mode

Toggleable.

When enabled:
- explains reasoning
- highlights trade-offs
- points out what to watch next

When disabled:
- shorter, more direct responses

---

## Current Features

- Chat-style sidebar UI (green/grey messaging style)
- OpenRouter integration (DeepSeek models)
- Short-term memory (recent context + roster awareness)
- Page-aware behaviour (draft, roster, free agency, etc.)
- Basketball GM rules awareness (e.g. 18-player roster cap)
- Reduced hallucination of impossible mechanics (minutes, substitutions, etc.)

---

## Limitations

This is still early and not everything is fully solved yet:

- Trade suggestions are not fully validated against all cap rules
- Other teams’ decision-making is estimated, not simulated
- Memory is short-term, not persistent across sessions
- Dynamic pages (draft/expansion) can occasionally desync from reality
- Player/team data can be incorrect if parsing fails

The current focus is improving:
- state accuracy
- trade realism
- consistency

---

## Setup

1. Install the extension as a temporary Firefox add-on  
2. Create an account on OpenRouter  
3. Add a small amount of credit (a few dollars is enough)  
4. Generate an API key  
5. Paste the key into the extension settings  
6. Open Basketball GM and load a league  
7. Open the sidebar (red “GM” tab)

---

## Model

Recommended:

```text
deepseek/deepseek-chat-v3-0324
