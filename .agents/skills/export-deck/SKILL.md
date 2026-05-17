---
name: export-deck
description: "Use when the user wants to export their MTG deck to a file format for import into deck-building tools. Triggers include requests to 'export my deck', 'download deck list', 'create Archidekt import', or 'save my deck'."
---

# Export Deck

Export a deck.json to formats compatible with deck-building tools (Archidekt CSV, plain text, markdown summary).

## Prerequisites

- `deck.json` must exist (run `build-deck` and optionally `optimize-deck` first)
- `collection.json` must exist (for card details)

## Workflow

1. Run the export script:
   ```bash
   cd .agents/skills/export-deck/scripts && npx tsx export-deck.ts <deck.json> <collection.json> --format all --output-dir <path>
   ```
   - `<deck.json>`: Path to the deck file
   - `<collection.json>`: Path to the collection file
   - `--format`: `archidekt`, `text`, `summary`, or `all` (default: `all`)
   - `--output-dir`: Where to write output files (default: current directory)

2. Present the exported files to the user:
   - **Archidekt CSV**: Import directly into Archidekt via "Import → CSV"
   - **Plain text**: Copy-paste into any deck builder or share as-is
   - **Markdown summary**: Review deck composition, mana curve, and card list

3. **Offer upgrade suggestions** (agent reasoning, not script):
   - Identify cards that could be upgraded if the user acquires them
   - Suggest cards from EDHREC or popular lists that aren't in the collection
   - Note: these are aspirational — the deck as exported uses only available cards

4. **Offer a play guide** (agent reasoning, not script):
   - Summarize the deck's game plan
   - Key combos and synergies
   - Mulligan guide
   - Early/mid/late game strategy

## Export Formats

### Archidekt CSV
Columns: `Quantity,Card Name,Set,Collector Number,Category`
Import via Archidekt → New Deck → Import → CSV

### Plain Text
Grouped by category with counts. Easy to copy-paste or share.

### Markdown Summary
Full deck breakdown with stats, mana curve, and card list. Good for review and sharing.
