# 🏀 BGM Assistant

**A minimal, state-aware AI sidebar for Basketball GM.**

BGM Assistant is a Firefox extension that adds a smart sidebar to Basketball GM. It helps you think through decisions like a GM without pretending it can do things the game doesn’t allow.

It’s designed to feel like a **co-GM sitting next to you**, not a generic chatbot.

---

## Status
🟡 Mid-late stage development, testing and bug fixing.

---

## Philosophy

- **Grounded, not theoretical.** Advice is based on Basketball GM mechanics, not real NBA assumptions.
- **Direct when it matters.** The assistant aims to give clear recommendations instead of vague suggestions, especially in Co-GM and Auto modes.
- **Minimal, not cluttered.** Clean chat-style UI with only the information that matters.
- **State-aware.** Decisions are based on your current roster, situation, and recent context, not just generic advice.

---

## What does it do?

BGM Assistant helps you:

- Evaluate your roster and team direction
- Get trade ideas **with basic legality checks and acceptance estimates**
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
- Basic code-side trade validation (salary sanity checks)
- Acceptance feedback on trades (Likely / Possible / Unlikely / Very unlikely)
- Next-step guidance for trades (keep trying / add a sweetener / walk away)
- Reduced hallucination of impossible mechanics (minutes, substitutions, etc.)

---

## Limitations

This is still early and not everything is fully solved yet:

- Trade validation is **conservative and incomplete** (not a full Basketball GM trade engine)
- Trade acceptance is **heuristic**, not based on actual in-game AI logic
- The assistant can still suggest **legal but unrealistic trades**
- Follow-up trade refinement (e.g. “make this work”) is not always fully consistent
- Memory is short-term, not persistent across sessions
- Dynamic pages (draft/expansion) can occasionally desync from reality
- Player/team data can be incorrect if parsing fails

The current focus is improving:
- trade realism (legality + acceptance)
- state accuracy
- consistency

---

## Trade Advice (Current Behaviour)

Trade suggestions now include:

- **Acceptance likelihood**  
  (Likely / Possible / Unlikely / Very unlikely)

- **Next-step guidance**  
  - Keep trying  
  - Add a sweetener  
  - Walk away / look elsewhere  

- **Basic salary validation**  
  Exact trade packages are only suggested when they pass a conservative salary sanity check. Otherwise, the assistant will fall back to a **target + framework** instead of inventing invalid deals.

This system is still evolving and does not yet fully replicate Basketball GM’s internal trade logic.

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
deepseek/deepseek-chat-v3-0324

---

## Tech Stack

- JavaScript (Firefox extension APIs)
- IndexedDB (game state extraction)
- OpenRouter API (LLM integration)
- DeepSeek models
- HTML/CSS (UI)

---

## Why this project?

This project was built to explore how AI can be applied to real decision-making environments, rather than generic chat interfaces. The goal is to create an assistant that operates within the constraints of a system and provides grounded, actionable guidance.
