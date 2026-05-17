---
name: validate-deck
description: "Use when the user wants to validate an MTG deck for format legality and rules compliance. Triggers include requests to 'check my deck', 'validate this deck', 'is this deck legal', or 'verify deck rules'."
---

# Validate Deck

Validate a deck.json against format-specific rules and produce a validation report.

## Prerequisites

- `deck.json` must exist (run `build-deck` first)
- `collection.json` must exist (run `import-collection` first)

## Workflow

1. Run the validation script:
   ```bash
   cd .agents/skills/validate-deck/scripts && npx tsx validate-deck.ts <deck.json> <collection.json> <output-path>
   ```
   - `<deck.json>`: Path to the deck file
   - `<collection.json>`: Path to the collection file (for availability checks)
   - `<output-path>`: Where to write `validation-report.json` (default: `validation-report.json`)

2. Review the validation report:
   - **Errors** (severity: "error") must be fixed before the deck is playable
   - **Warnings** (severity: "warning") should be addressed for optimal play
   - **Info** (severity: "info") is informational

3. If errors exist, inform the user and suggest fixes:
   - For deck size issues: suggest adding or removing cards
   - For legality issues: suggest replacements for banned/not-legal cards
   - For color identity issues: suggest removing off-color cards or changing commander
   - For availability issues: note which cards aren't in the collection

4. If the deck is valid, proceed to `optimize-deck` or `export-deck`

## Supported Formats

- Commander (100 cards, singleton, color identity rules)
- Standard (60+ cards, 4x limit)
- Modern (60+ cards, 4x limit)
- Legacy (60+ cards, 4x limit)
- Pioneer (60+ cards, 4x limit)

## Validation Checks

1. Deck size matches format requirements
2. Card legality in the chosen format
3. Quantity limits per card (singleton for Commander, 4x for others)
4. Commander rules (if applicable): legendary creature, color identity
5. Card availability in the user's collection
6. Mana curve analysis (informational)
