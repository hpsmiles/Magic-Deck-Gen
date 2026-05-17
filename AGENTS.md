# Magic-Deck-Gen

Magic: The Gathering deck generator that builds decks from a user's existing card library.

## Project Status

Implemented as a set of 5 OpenCode skills (pipeline architecture). Each skill is installed at `.agents/skills/<skill-name>/` (project-local) and contains a `SKILL.md` with agent instructions plus a `scripts/` directory with TypeScript helper scripts.

## Key Domain Concepts

- **Card Library**: The user's personal collection of MTG cards (the input), sourced via CSV export from Archidekt
- **Deck Generation**: Interactive deck construction using agent reasoning + deterministic helper scripts
- **MTG specifics**: Color identity, mana curve, card types, format legality, synergy — all matter for deck quality
- **Scryfall API**: Card data enrichment (mana cost, type, legality, color identity, etc.) — 550ms rate limit between requests

## Skill Pipeline

1. **`import-collection`** — Parse Archidekt CSV + enrich via Scryfall → `collection.json`
2. **`build-deck`** — Interactive Q&A + compute available pool → `deck.json`
3. **`validate-deck`** — Format legality & rules checks → `validation-report.json`
4. **`optimize-deck`** — Iterative improvement loop (max 10 iterations) → updated `deck.json` + `optimization-log.json`
5. **`export-deck`** — Archidekt CSV, plain text, markdown summary

## Data Files

| File | Produced By | Consumed By | Description |
|------|-------------|-------------|-------------|
| `collection.json` | import-collection | build-deck, validate-deck, export-deck | Enriched card library |
| `available-pool.json` | build-deck | (agent reads directly) | Collection minus reserved deck cards |
| `deck.json` | build-deck | validate-deck, optimize-deck, export-deck | The deck list |
| `validation-report.json` | validate-deck | optimize-deck | Format legality & rules check results |
| `optimization-log.json` | optimize-deck | (audit trail) | Iteration-by-iteration change log |

## Conventions

- Remote: `https://github.com/hpsmiles/Magic-Deck-Gen.git`
- Default branch: `main`
- Skills installed at: `.agents/skills/<skill-name>/` (project-local)
- Scripts run via: `cd .agents/skills/<skill-name>/scripts && npx tsx <script>.ts <args>`
- TypeScript for all helper scripts (ES2022, Node16 module resolution)
- Scryfall rate limit: 550ms between requests
