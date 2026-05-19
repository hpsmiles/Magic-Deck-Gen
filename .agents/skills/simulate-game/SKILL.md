---
name: simulate-game
description: "Use when the user wants to simulate MTG Commander games between decks. Triggers include requests to 'simulate games', 'test my deck', 'run a tournament', 'play decks against each other', or 'battle test decks'."
---

# Simulate Game

Simulate Commander-format MTG games between 2-5 decks using AI-driven gameplay.

## Prerequisites

- At least 2 deck files (local JSON, Archidekt URL, or Archidekt CSV)
- `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` environment variable set

## Workflow

1. Identify the decks to simulate:
   - Local deck JSON files (e.g., `omnath-locus-of-rage-deck.json`)
   - Archidekt URLs (e.g., `https://archidekt.com/decks/1234567`)
   - Archidekt CSV exports

2. Run the simulation:
   ```bash
   cd .agents/skills/simulate-game/scripts && npx tsx simulate.ts --decks <deck1> <deck2> [<deck3>...] --games <N>
   ```
   - `--decks`: Space-separated list of deck sources (local paths or Archidekt URLs)
   - `--games`: Number of games to simulate (default: 10)

3. Review the output:
   - `simulation-results.json` — Tournament aggregate statistics
   - `simulation-games/` — Per-game JSON logs
   - `simulation-report.md` — Narrative summary

4. Present results to the user with key insights

## Environment Variables

- `LLM_PROVIDER`: `openai` (default) or `anthropic`
- `LLM_MODEL`: Model name (default: `gpt-4o` or `claude-sonnet-4-20250514`)
- `OPENAI_API_KEY`: Required if using OpenAI
- `ANTHROPIC_API_KEY`: Required if using Anthropic
