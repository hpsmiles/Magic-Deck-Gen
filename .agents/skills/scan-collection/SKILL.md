---
name: scan-collection
description: "Use when the user wants to import their MTG card collection from photos. Triggers include requests to 'scan my cards', 'import from photos', 'read my card photos', or 'scan a directory of card images'."
---

# Scan Collection

Import an MTG card collection from a directory of photos. Uses Kimi K2.5 Fast vision model to identify card names and quantities, then enriches with Scryfall data.

## Prerequisites

- `NEURALWATT_API_KEY` environment variable must be set
- Photos should be `.jpg`, `.jpeg`, `.png`, or `.webp` format
- Phone camera photos are supported (handles glare, angles, varied lighting)

## Workflow

1. Ask the user for the path to their photo directory
2. Ask the user whether to merge with an existing `collection.json` (if one exists)
3. Run the scan script:
   ```bash
   cd .agents/skills/scan-collection/scripts && npx tsx scan-photos.ts <photo-dir> [raw-cards-path]
   ```
   - `<photo-dir>`: Path to directory containing card photos
   - `<raw-cards-path>`: Where to write `raw-cards.json` (default: `raw-cards.json` in current directory)
4. Review `raw-cards.json` — show the user the detected cards and warnings (uncertain cards are listed in warnings)
5. Ask the user if they want to proceed with enrichment
6. Run the enrichment script:
   ```bash
   cd .agents/skills/scan-collection/scripts && npx tsx enrich-cards.ts <raw-cards-path> <output-path> [--merge]
   ```
   - `<raw-cards-path>`: Path to `raw-cards.json` from step 3
   - `<output-path>`: Where to write `photo-collection.json`
   - `--merge`: Optional flag to merge into existing `collection.json` (backs up to `collection.json.bak`)
7. Inform the user of the results: cards detected, enriched, not found, uncertain cards for review

## Output

- `raw-cards.json` — intermediate file with detected card names, quantities, confidence levels, and source photos
- `photo-collection.json` — enriched card library (same schema as `collection.json`), usable by all downstream MTG deck skills

## Troubleshooting

- **"Set NEURALWATT_API_KEY environment variable"**: Export the API key before running: `export NEURALWATT_API_KEY=your-key`
- **"No cards confidently identified"**: Photos may be too blurry, dark, or have too much glare. Try better-lit, flat-lay photos
- **Cards not found on Scryfall**: The vision model may have misread a card name. Check `raw-cards.json` for typos
- **Rate limiting**: Scryfall requests are rate-limited to 550ms. Large collections may take a few minutes
- **Large images**: Images over 20MB are automatically resized before sending to the API
