# MTG Deck Generator — OpenCode Skill Set Design

## Overview

A set of 5 composable OpenCode skills that generate playable Magic: The Gathering decks from a user's card collection. The OpenCode agent itself provides the AI reasoning — no external LLM API needed. Helper scripts are written in TypeScript and handle parsing, validation, and formatting. The agent orchestrates the workflow and makes strategic decisions.

**Data source:** User's card collection exported as CSV from Archidekt. Card details (rules text, mana cost, legality, etc.) enriched via the Scryfall API.

**Interface:** CLI — the agent runs in the terminal, asks questions interactively, and outputs files.

## Skill Set

| Skill | Purpose | Input | Output |
|---|---|---|---|
| `import-collection` | Parse Archidekt CSV + enrich via Scryfall | CSV file path | `collection.json` |
| `build-deck` | Interactive deck construction | `collection.json` + optional `reserved-decks/` + user Q&A | `deck.json` |
| `validate-deck` | Format legality & rules checks | `deck.json` + format | `validation-report.json` |
| `optimize-deck` | Iterative improvement loop (max 10 iterations) | `deck.json` + `collection.json` + `validation-report.json` | `deck.json` (updated) + `optimization-log.json` |
| `export-deck` | Output final deliverables | `deck.json` + `collection.json` | Archidekt import file, summary, play guide, upgrade suggestions |

**Typical flow:**
```
import-collection → build-deck → validate-deck → optimize-deck → export-deck
                                        ↑              │
                                        └──────────────┘
                                  (optimize calls validate internally)
```

**Shared data contract:** All skills communicate through JSON files in a working directory. The agent reads/writes these files between skill invocations. No runtime dependencies between skills.

---

## Skill 1: `import-collection`

**Purpose:** Parse the Archidekt CSV export and enrich each card with Scryfall data.

**Workflow:**
1. Agent asks user for the CSV file path
2. Run `import-collection.ts` — parses CSV, extracts card names + quantities
3. For each unique card, call Scryfall API (`/cards/named?fuzzy={name}`) to get: mana cost, type line, color identity, rules text, CMC, legality per format, Scryfall ID
4. Batch Scryfall requests with 50ms delay between calls (respects ~75 req/sec rate limit)
5. Output `collection.json`

**`collection.json` structure:**
```json
{
  "metadata": {
    "source": "archidekt-csv",
    "importDate": "2026-05-17T...",
    "totalUniqueCards": 450,
    "totalCards": 1200
  },
  "cards": [
    {
      "name": "Sol Ring",
      "quantity": 3,
      "scryfallId": "uuid...",
      "manaCost": "{1}",
      "cmc": 1,
      "typeLine": "Artifact",
      "colorIdentity": [],
      "rulesText": "{T}: Add {C}{C}.",
      "legalities": { "commander": "legal", "standard": "not_legal" },
      "imageUri": "https://..."
    }
  ]
}
```

**Error handling:**
- Cards not found on Scryfall: logged with warning, included with partial data
- Duplicate card names (different printings): merged, quantity summed
- Rate limiting: built-in 50ms delay between requests

---

## Skill 2: `build-deck`

**Purpose:** Interactive deck construction — ask the user questions, then build an initial deck from the available card pool.

**Workflow:**
1. Load `collection.json` + optional `reserved-decks/` directory
2. Compute available pool — subtract reserved deck quantities from collection
3. Interactive Q&A — agent asks one question at a time:
   - What format? (determines deck size, banned list, commander rules)
   - What strategy/archetype? (aggro, control, combo, midrange, etc.)
   - What colors? (or "suggest based on collection")
   - For Commander: any commander preference? (or "suggest from collection")
   - Any specific cards you want included?
   - Which existing decks to reserve? (if not already provided)
4. Agent constructs the deck using its reasoning about synergy, mana curve, color identity, and the available pool
5. Present the strategy + commander (if applicable) to the user for feedback
6. Iterate on feedback — user can adjust strategy, swap commander, add constraints
7. Output `deck.json`

**`deck.json` structure:**
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
  "reservedDecks": ["deck-1.csv", "deck-2.csv"]
}
```

**Reserved decks:** The user can provide existing deck lists as Archidekt CSV files in the `reserved-decks/` directory. If the user provides Archidekt deck URLs/IDs for public decks, the agent fetches those via the Archidekt API (`/api/decks/{id}/`) and converts them to the same format before subtracting. This is a `build-deck` concern, not `import-collection`, because which decks to reserve changes per build.

**Key constraints the agent enforces:**
- Only uses cards available in the pool (after reserved deck subtraction)
- Respects quantity limits (singleton for Commander, 4x for Standard, etc.)
- Color identity must match commander (for Commander format)
- Deck size matches format requirements (100 for Commander, 60 for Standard, etc.)

---

## Skill 3: `validate-deck`

**Purpose:** Check a deck against format rules and identify issues. Independently useful — works on any deck list, not just generated ones.

**Workflow:**
1. Load `deck.json`
2. Run `validate-deck.ts` — performs automated checks
3. Output `validation-report.json`

**Checks performed:**

| Check | What it validates |
|---|---|
| Deck size | Correct number of cards for the format |
| Card legality | Each card is legal/banned/restricted in the chosen format |
| Color identity | All cards fit within the commander's color identity (Commander only) |
| Quantity limits | Singleton rule for Commander, 4x max for constructed formats |
| Commander presence | Exactly 1 commander card for Commander format |
| Available quantities | No card exceeds what's available in the collection (after reserved deck subtraction) |
| Basic land sanity | Not missing basic land types needed for the color identity |

**`validation-report.json` structure:**
```json
{
  "deckId": "deck.json",
  "format": "commander",
  "valid": false,
  "errors": [
    {
      "rule": "deck-size",
      "message": "Deck has 94 cards, needs 100",
      "severity": "error",
      "cards": []
    }
  ],
  "warnings": [
    {
      "rule": "mana-curve",
      "message": "Average CMC is 4.2 — consider adding more low-cost cards",
      "severity": "warning",
      "cards": []
    }
  ],
  "suggestions": [
    "Add 6 more cards to reach 100",
    "Consider adding more ramp to support high CMC"
  ]
}
```

**Severity levels:**
- `error` — deck is invalid, must fix before playtesting
- `warning` — deck is legal but likely weak, should address during optimization
- `info` — neutral observations

---

## Skill 4: `optimize-deck`

**Purpose:** Iteratively improve the deck through a validate → evaluate → playtest → improve loop (max 10 iterations).

**Workflow:**
1. Load `deck.json`, `collection.json`, and `validation-report.json`
2. Iteration loop (max 10 times):
   - **Validate** — run `validate-deck.ts` internally; if errors exist, fix those first
   - **Evaluate** — agent reasons about the deck's strengths and weaknesses:
     - Mana curve analysis (too top-heavy? not enough ramp?)
     - Synergy assessment (do cards work together toward the stated strategy?)
     - Color balance (enough sources for each color pip?)
     - Interaction density (enough removal/counters/protection?)
     - Card draw / card advantage
   - **Playtest** — agent mentally simulates sample scenarios:
     - Typical opening hands (7 cards) — are they keepable?
     - Curve-out scenarios — what does turns 1-5 look like?
     - Key matchup scenarios — how does the deck handle common threats?
     - Commander gameplay — how reliably can you cast and leverage the commander?
   - **Identify swaps** — based on evaluation + playtest, agent proposes card changes from the available pool
   - **Apply changes** — update `deck.json`
   - **Log iteration** — append to `optimization-log.json`
3. Exit conditions:
   - Deck validates clean AND agent judges no further meaningful improvements
   - Max iterations (10) reached
   - User interrupts with feedback

**`optimization-log.json` structure:**
```json
{
  "deckId": "deck.json",
  "iterations": [
    {
      "iteration": 1,
      "changes": [
        { "action": "remove", "card": "Cancel", "reason": "Low synergy with aggro strategy" },
        { "action": "add", "card": "Lightning Bolt", "reason": "Efficient removal fits aggro plan" }
      ],
      "evaluation": {
        "manaCurve": "improved — avg CMC 3.8 → 3.4",
        "synergy": "moderate — needs more token generators",
        "playtestNotes": "Opening hands keepable ~70% of the time"
      },
      "validAfterChanges": true
    }
  ],
  "finalAssessment": "Deck is well-optimized for the available card pool."
}
```

**Key design decisions:**
- The agent calls `validate-deck.ts` as a script internally — it doesn't invoke the `validate-deck` skill
- The agent's own reasoning drives evaluation and playtest — no external AI needed
- Each iteration is logged so the user can review the optimization path
- The agent can stop early if satisfied — 10 is a ceiling, not a target

---

## Skill 5: `export-deck`

**Purpose:** Generate all final deliverables from the completed deck.

**Workflow:**
1. Load `deck.json` and `collection.json`
2. Run `export-deck.ts` — generates 4 outputs:

**Output 1: Archidekt import file** (`deck-name.txt`)
- Format: `1x Card Name` per line (Archidekt's "Plain Text" import format)
- Sections separated by blank lines with headers: `// Commander`, `// Mainboard`, `// Sideboard`
- User can paste directly into Archidekt's import dialog (New Deck → Import → Plain Text)

**Output 2: Deck summary** (`deck-name-summary.md`)
- Deck name, format, commander, strategy
- Color identity breakdown
- Mana curve chart (text-based)
- Card type distribution (creatures, instants, sorceries, enchantments, artifacts, lands)
- Key synergies and win conditions
- Total cards from collection used / remaining available

**Output 3: Play guide** (`deck-name-play-guide.md`)
- Mulligan guide — what to keep vs. ship
- Early game plan — turns 1-3 priorities
- Mid game plan — turns 4-6 pivots
- Late game plan — closing out
- Key card interactions — combos and synergies to look for
- Commander strategy — when to cast, how to protect, how to leverage
- Common threats and answers — what to watch for and how to respond
- Sideboard guide (if applicable for the format)

**Output 4: Upgrade suggestions** (`deck-name-upgrades.md`)
- Cards that would improve the deck but aren't in the collection
- Organized by category: "High impact", "Nice to have", "Budget alternatives"
- For each card: what it replaces and why it's an upgrade
- Sourced by the agent reasoning about the deck's weaknesses + Scryfall search for alternatives

**File structure after export:**
```
output/
└── deck-name/
    ├── deck-name.txt              # Archidekt import
    ├── deck-name-summary.md       # Summary
    ├── deck-name-play-guide.md    # Play guide
    └── deck-name-upgrades.md      # Upgrade suggestions
```

---

## Technology

- **Language:** TypeScript
- **Card data:** Scryfall API (`/cards/named?fuzzy=...`) with 50ms request delay
- **Collection input:** Archidekt CSV export
- **AI reasoning:** The OpenCode agent itself — no external LLM API
- **Helper scripts:** Each skill has a corresponding `.ts` script for deterministic work (parsing, validation, formatting). The agent handles reasoning, strategy, and creative decisions.
