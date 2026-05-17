---
name: build-deck
description: "Use when the user wants to build a new MTG deck from their card collection. Triggers include requests to 'build a deck', 'make a commander deck', 'create a new deck', or 'construct a deck from my cards'."
---

# Build Deck

Interactive deck construction from the user's card collection. Ask questions one at a time, then construct an initial deck.

## Prerequisites

- `collection.json` must exist (run `import-collection` first)

## Workflow

1. **Load the collection**: Read `collection.json`

2. **Ask about reserved decks**: "Do you have existing decks whose cards should not be reused? Provide CSV files in a directory, or Archidekt deck URLs/IDs for public decks."
   - If CSV files provided: run `compute-available-pool.ts`
   - If Archidekt URLs/IDs: fetch via `https://archidekt.com/api/decks/{id}/`, extract card names + quantities, then run `compute-available-pool.ts`
   - If none: the full collection is the available pool

3. **Compute available pool** (if reserved decks exist):
   ```bash
   cd .agents/skills/build-deck/scripts && npx tsx compute-available-pool.ts <collection.json> <reserved-decks-dir> <output-path>
   ```

4. **Ask one question at a time** (do NOT ask all at once):
   - "What format?" — determines deck size, banned list, commander rules
   - "What strategy or archetype?" — aggro, control, combo, midrange, etc. Offer suggestions based on the available card pool
   - "What colors?" — or offer to suggest based on collection strengths
   - For Commander: "Any commander preference?" — or suggest commanders from the collection that match chosen colors/strategy
   - "Any specific cards you want included?"

5. **Construct the deck** using your reasoning about:
   - Synergy between cards toward the stated strategy
   - Mana curve balance (enough early plays, ramp for late game)
   - Color identity matching the commander (Commander format)
   - Quantity limits (singleton for Commander, 4x for constructed)
   - Deck size requirements (100 for Commander, 60 for Standard, etc.)
   - Only cards available in the pool (after reserved deck subtraction)

6. **Present the strategy + commander** to the user for feedback. Iterate until approved.

7. **Write `deck.json`** with the final deck list.

## deck.json Structure

```json
{
  "metadata": {
    "format": "commander",
    "strategy": "tokens go-wide",
    "commander": "Winota, Joiner of Forces",
    "colors": ["R", "W"],
    "createdAt": "2026-05-17T..."
  },
  "mainboard": [
    {
      "name": "Winota, Joiner of Forces",
      "quantity": 1,
      "category": "commander",
      "scryfallId": "uuid..."
    }
  ],
  "maybeboard": [],
  "reservedDecks": ["deck-1.csv"]
}
```

## Card Categories

Use these categories in the `category` field:
- `commander` — the commander card
- `creature` — creature spells
- `instant` — instant spells
- `sorcery` — sorcery spells
- `enchantment` — enchantments
- `artifact` — artifacts
- `ramp` — ramp/mana acceleration
- `removal` — spot removal, board wipes
- `draw` — card draw spells
- `land` — lands

## Key Constraints

- Only use cards available in the pool (after reserved deck subtraction)
- Respect format quantity limits (singleton for Commander, 4x for constructed)
- Color identity must match commander (for Commander format)
- Deck size must match format requirements
