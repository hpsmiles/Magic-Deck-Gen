# Commander Game Engine — Design Spec

**Date:** 2026-05-19
**Status:** Approved
**Approach:** Turn-Loop Engine with LLM Agent (Approach A)

## Overview

A Commander-format MTG game engine that simulates games between 2-5 decks. The engine enforces core MTG rules deterministically, uses LLM agents for gameplay decisions, and falls back to LLM for rulings on interactions it can't resolve. Supports tournament mode (multi-game simulation) with statistical aggregation and narrative reporting.

## Primary Use Case

Automated simulation — AI plays all decks against each other. No human player interaction. Used for deck performance testing, win-rate analysis, and generating play guides.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                  Game Orchestrator                │
│  (Turn loop, phase progression, game lifecycle)  │
├──────────┬──────────┬───────────┬───────────────┤
│  Game    │  Action  │  LLM      │  Ruling       │
│  State   │  Validator│ Agent    │  Oracle       │
│          │          │          │  (LLM fallback)│
├──────────┴──────────┴───────────┴───────────────┤
│              Card Data Provider                  │
│         (Scryfall API + cache)                   │
└─────────────────────────────────────────────────┘
```

### Modules

1. **Game Orchestrator** — Main loop. Runs turn structure (untap → upkeep → draw → main → combat → main2 → end), advances phases, triggers state-based actions, checks win conditions. Calls LLM Agent for decisions and Action Validator before executing them.

2. **Game State** — Single source of truth. Immutable-snapshot model: each action produces a new state. Contains battlefield, graveyards, hands, libraries, life totals, commander damage trackers, poison counters, mana pools, the stack, turn/phase info, and a game log.

3. **Action Validator** — Checks if a proposed action is legal: can you cast this spell, can you attack with this creature, do you have enough mana, is the target valid. Returns yes/no with reason.

4. **LLM Agent** — Receives a structured game-state summary and returns actions for the active player. One LLM call per decision point (multiple calls per turn as needed).

5. **Ruling Oracle** — When the engine encounters an interaction it can't resolve deterministically (complex replacement effects, layering issues, unusual triggers), it calls the LLM with the specific rules question and caches the answer.

6. **Card Data Provider** — Fetches card details from Scryfall API (550ms rate limit) and caches results to disk. Needs oracle text, mana cost, type line, power/toughness, and loyalty.

## Game State Model

```typescript
interface GameState {
  turn: number;
  activePlayerIndex: number;
  phase: GamePhase;
  step: GameStep;
  stack: StackItem[];
  players: PlayerState[];
  battlefield: Permanent[];
  commandZone: CommandZoneCard[];
  timestamp: number; // increments on every state change
  gameLog: GameLogEntry[];
}

interface PlayerState {
  index: number;
  life: number;
  poisonCounters: number;
  commanderDamage: Map<string, number>; // commander name → damage taken
  manaPool: ManaPool;
  hand: CardInstance[];
  library: CardInstance[];
  graveyard: CardInstance[];
  exile: CardInstance[];
  mulligansTaken: number;
  hasDrawnThisTurn: boolean;
  landPlaysRemaining: number;
}

interface Permanent {
  id: string; // unique instance ID
  card: CardData;
  owner: number; // player index
  controller: number;
  tapped: boolean;
  summoningSickness: boolean;
  damage: number;
  counters: Map<string, number>;
  attachments: string[]; // IDs of attached permanents
  attachedTo: string | null;
  copyOf: string | null; // for copy effects
}

interface StackItem {
  id: string;
  type: 'spell' | 'ability' | 'trigger';
  source: CardInstance | Permanent;
  controller: number;
  targets: Target[];
  manaCostPaid: ManaCost;
}

type GamePhase = 'beginning' | 'precombat_main' | 'combat' | 'postcombat_main' | 'ending';
type GameStep = 'untap' | 'upkeep' | 'draw' | 'main_precombat' | 'begin_combat' | 'declare_attackers' | 'declare_blockers' | 'combat_damage' | 'end_combat' | 'main_postcombat' | 'end_step' | 'cleanup';
```

### Key Design Decisions

- **Immutable snapshots** — Each action creates a new state. Enables undo, replay, and safe concurrent reads by the LLM agent.
- **Unique instance IDs** — Every card instance gets a UUID. Critical for tracking which specific card is where (especially with tokens and copies).
- **Commander damage tracking** — Stored per-player, keyed by commander name. Essential for Commander format.
- **Timestamps** — Incremented on every state change. Used for dependency resolution in layering.

## Turn Structure & Core Rules

### Turn Flow

```
Untap → Upkeep (triggers) → Draw →
Precombat Main (cast spells, play lands) →
Combat (declare attackers → declare blockers → damage) →
Postcombat Main → End Step → Cleanup
```

### Core Rules Implemented

1. **Mana system** — Lands tap for mana, mana pool empties at end of each phase. Color identity enforced for commanders. Mana cost parsing from Scryfall data.
2. **Stack** — Spells and abilities go on the stack. Priority passes between players. Both players can respond before resolution.
3. **Combat** — Declare attackers → declare blockers → first strike damage → regular damage. Attacking a planeswalker or player. Commander damage tracked.
4. **State-based actions** — Checked after every action: creatures with 0 toughness die, players at 0 life lose, commander damage ≥ 21 = loss, poison ≥ 10 = loss.
5. **Commander tax** — Each time a commander is cast from command zone, it costs {2} more. Returns to command zone on death/exile (owner's choice).
6. **Mulligan** — Vancouver mulligan: draw 7, scry 1 if you keep after mulligan. Free mulligan in multiplayer on first mulligan.
7. **Land per turn** — One land play per turn (unless effect says otherwise).

### Common Edge Cases Handled

- Replacement effects (Torpor Orb, Rest in Peace) — engine intercepts zone-change events
- Copy effects (Clone, Phyrexian Metamorph) — engine creates copy with modified properties
- Triggered ability ordering — when multiple triggers fire, active player orders theirs first
- Flash effects — spells can be cast at instant speed when permitted

### Not in Scope for v1

- Full layering system (dependency/interaction of continuous effects)
- Complex targeting restrictions (protection, hexproof from specific colors)
- Alternative costs (overload, evoke, dash) — handled case-by-case
- Sideboards/wishes

## LLM Agent & Decision-Making

### Decision Points

The engine pauses for LLM input at these moments:
- **Main phase**: What spells to cast, in what order, what targets
- **Combat**: Who to attack, with which creatures
- **Blockers**: How to block incoming attacks
- **Stack responses**: Whether to respond to a spell/ability on the stack
- **Triggered abilities**: How to order triggers, optional triggers (may)
- **Mulligan**: Keep or mulligan the opening hand

### Prompt Structure

Each LLM call receives:
1. **Game state summary** — Your hand, battlefield, life totals, visible opponent info (public zones only)
2. **Legal actions** — The engine pre-computes what you CAN do (castable spells, attackable creatures, etc.)
3. **Context** — Turn number, phase, what happened recently (last 3 actions)
4. **Deck strategy** — From the deck's `metadata.strategy` field

### Response Format

```json
{
  "actions": [
    { "type": "cast", "cardId": "abc123", "targets": ["def456"] },
    { "type": "activate", "ability": "tap", "permanentId": "ghi789" }
  ],
  "reasoning": "Playing Sol Ring for ramp..."
}
```

### Validation

The engine validates every action before executing. If an action is illegal, it's rejected and the LLM is re-prompted with the error. Max 3 re-prompts before the turn is passed.

### Cost Optimization

- Batch simple decisions (e.g., "cast these 3 ramp spells") into one LLM call
- Use a cheaper model for routine decisions (main phase when behind, obvious blocks)
- Cache common patterns (opening hand mulligan decisions)

### Ruling Oracle

When the engine can't resolve an interaction:
1. Serialize the specific game state and interaction
2. Send to LLM with CR references
3. Cache the ruling by interaction hash
4. Apply the ruling and continue

## Tournament Mode & Output

### Tournament Mode

- Run N games (configurable, default 10) between 2-5 decks
- Each game is independent — fresh shuffle, fresh state
- Seat order is randomized per game
- Results are aggregated into statistics

### Per-Game Output

```json
{
  "gameId": "uuid",
  "players": [
    { "deckName": "Omnath", "seatIndex": 0, "result": "loss", "turnsSurvived": 12 }
  ],
  "winner": { "deckName": "Ayli", "seatIndex": 2 },
  "totalTurns": 12,
  "log": [
    { "turn": 1, "player": 0, "phase": "main", "action": "cast", "card": "Sol Ring", "details": "..." }
  ]
}
```

### Tournament Output

```json
{
  "tournamentId": "uuid",
  "decks": ["Omnath", "Ayli", "Tatyova"],
  "gamesPlayed": 10,
  "results": {
    "Omnath": { "wins": 4, "losses": 6, "winRate": 0.4, "avgTurnsSurvived": 9.2 },
    "Ayli": { "wins": 4, "losses": 6, "winRate": 0.4, "avgTurnsSurvived": 10.1 },
    "Tatyova": { "wins": 2, "losses": 8, "winRate": 0.2, "avgTurnsSurvived": 7.5 }
  },
  "gameLogs": ["game-001.json", "game-002.json", "..."]
}
```

### Narrative Report

After the tournament, an LLM generates a human-readable summary:
- Overall standings and win rates
- Key moments from notable games
- Deck performance analysis (early game vs late game strength)
- Commander damage breakdown
- Recommendations for deck improvement

### File Outputs

- `simulation-results.json` — Tournament aggregate
- `simulation-games/` — Directory of per-game JSON logs
- `simulation-report.md` — Narrative report

## Skill Integration

### Pipeline Position

```
import-collection → build-deck → validate-deck → optimize-deck → [simulate-game] → export-deck
```

The simulate-game skill reads `deck.json` files (or specific named deck files) and produces simulation outputs.

### Deck Input Sources

1. **Local deck JSON** — `omnath-locus-of-rage-deck.json` (existing format)
2. **Archidekt URL** — `https://archidekt.com/decks/1234567` — fetch deck list via Archidekt API, convert to internal format, enrich via Scryfall
3. **Archidekt CSV** — existing export format (already handled by import-collection)

### CLI Usage

```bash
npx tsx simulate.ts \
  --decks omnath-locus-of-rage-deck.json https://archidekt.com/decks/1234567 \
  --games 10
```

### Script Structure

```
.agents/skills/simulate-game/
├── SKILL.md                    # Agent instructions
├── scripts/
│   ├── simulate.ts             # Main entry point — runs tournament
│   ├── game-engine.ts          # Core game loop & turn structure
│   ├── game-state.ts           # GameState types & immutable operations
│   ├── action-validator.ts     # Legal action checking
│   ├── combat-resolver.ts      # Attack/block/damage resolution
│   ├── mana-resolver.ts        # Mana cost parsing & payment
│   ├── state-based-actions.ts  # SBA checks (death, win/loss)
│   ├── card-provider.ts        # Scryfall API + cache
│   ├── archidekt-fetcher.ts    # Archidekt URL → deck conversion
│   ├── llm-agent.ts            # LLM decision-making client
│   ├── ruling-oracle.ts        # LLM fallback for rules questions
│   ├── tournament-runner.ts    # Multi-game orchestration & stats
│   ├── narrative-generator.ts  # LLM-powered narrative report
│   └── types.ts                # Shared type definitions
```

### Dependencies

- `openai` or `@anthropic-ai/sdk` — for LLM calls (configurable via environment variable)
- No other external dependencies — pure TypeScript

### Conventions

- Scripts run via: `cd .agents/skills/simulate-game/scripts && npx tsx <script>.ts <args>`
- TypeScript: ES2022, Node16 module resolution
- Scryfall rate limit: 550ms between requests
- LLM provider configured via `LLM_PROVIDER` env var (`openai` | `anthropic`)
- LLM model configured via `LLM_MODEL` env var
