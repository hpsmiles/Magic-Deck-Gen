# Commander Game Engine — Handoff

## What Was Built

A Commander-format MTG game simulation engine at `.agents/skills/simulate-game/`. Uses LLM-driven AI agents to play decks against each other in automatic tournaments.

## File Structure

```
.agents/skills/simulate-game/
├── SKILL.md                              # Skill definition
└── scripts/
    ├── types.ts                          # All type definitions
    ├── card-provider.ts                  # Scryfall API + disk cache (550ms rate limit)
    ├── archidekt-fetcher.ts              # Archidekt URL + local file deck loading
    ├── game-state.ts                     # Immutable game state operations
    ├── mana-resolver.ts                  # Mana ability/cost resolution
    ├── state-based-actions.ts            # SBA checker (death, loss, commander zone)
    ├── action-validator.ts               # Legal action validation (incl. commander casting)
    ├── combat-resolver.ts                # Combat damage (first strike, double strike, commander damage)
    ├── llm-agent.ts                      # LLM client + decision-making + game summary
    ├── ruling-oracle.ts                  # LLM fallback for complex rulings (disk cached)
    ├── game-engine.ts                    # Core turn loop + action execution
    ├── tournament-runner.ts              # Tournament execution (multi-game, stats)
    ├── narrative-generator.ts            # LLM-generated narrative report
    ├── simulate.ts                       # CLI entry point
    ├── .env                              # API config (gitignored)
    └── test-llm.ts                       # LLM connectivity test
```

## How to Run

```bash
cd .agents/skills/simulate-game/scripts

# Test 2 decks, 1 game
npx tsx simulate.ts --decks <deck1> <deck2> --games 1

# 4 decks, 10 games
npx tsx simulate.ts --decks <url1> <url2> <url3> <url4> --games 10
```

Deck sources: Archidekt URLs (`https://archidekt.com/decks/<id>`) or local JSON files.

## Configuration (`.env`)

```
LLM_PROVIDER=openai
LLM_MODEL=qwen3.6-35b-fast
OPENAI_API_KEY=<your-key>
LLM_BASE_URL=https://api.neuralwatt.com/v1
```

## Current State

- **All 13 tasks implemented and committed** (18 commits on `main`)
- **Decks load correctly** from Archidekt (sideboard/maybeboard filtered out, commander detected via `categories[]`)
- **Game engine runs** — turns progress, LLM makes decisions
- **Critical bug fixed**: Commanders can now be cast from command zone (was broken — no code path to cast from command zone)
- **Known issues**: See below

## Known Issues / Limitations

1. **Performance**: ~30-45s per turn with `qwen3.6-35b-fast`. A 30-turn game takes ~15-20 minutes. See `game-engine.ts` for the optimization section.
   - Auto-play land heuristic implemented
   - Parallel blocker decisions implemented
   - Skip postcombat main when hand is empty
   - More ambitious optimizations would require: cheaper model for routine decisions, consolidated LLM prompts per turn, or heuristic-only early turns

2. **No stack-based interaction**: Spells resolve immediately. `respond` action type exists but isn't handled. Instants have no mechanical advantage.

3. **No advanced combat features**: No reach, flying, trample, or menace checks. Damage assignment is simplified.

4. **No Vancouver scry**: After mulligan, the scry-1 step is not implemented.

5. **Partner commanders not supported**: Only single-commander decks.

6. **O(n) name cache scan**: `fetchCardByName` scans all cached files linearly. OK for <1000 cards, slow beyond that.

7. **`game-engine.ts` is ~1000 lines**: Candidate for splitting into `action-executor.ts` and `turn-runner.ts`.

## Model Tiers (NeuralWatt)

| Tier | Model | Cost (in/out per M) | Used For |
|------|-------|---------------------|----------|
| Cheap | `qwen3.6-35b-fast` | $0.05/$0.10 | Current default — gameplay decisions |
| Smart | `Qwen/Qwen3.5-397B-A3B-FP8` | $0.69/$4.14 | Reserved for complex decisions |
| Cheapest | `openai/gpt-oss-20b` | $0.03/$0.16 | Fallback (json_mode=True) |

## Recent Commits

```
5842dd5 fix: Archidekt sideboard filter + turn progress logging
8560408 fix: commander casting, double strike, shared LLM client
5163dfe feat: dotenv config, LLM_BASE_URL support
548241d fix: tournament error recovery, Map→Record, markdown sanitization
399d678 feat: CLI entry point
5461de5 feat: tournament runner + narrative generator
0264cad fix: combat assignments, player elimination, commander tax scoping
```
