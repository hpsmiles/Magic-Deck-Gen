---
name: scan-collection
description: "Use when the user wants to import their MTG card collection from photos. Triggers include requests to 'scan my cards', 'import from photos', 'read my card photos', or 'scan a directory of card images'."
---

# Scan Collection

Import an MTG card collection from a directory of photos. Uses OpenCV to detect and crop individual cards, then Gemma 4 vision model to identify each card, then enriches with Scryfall data.

## Prerequisites

- LM Studio must be running with Gemma 4 model loaded (`gemma-4-26b-a4b`)
- Photos should be `.jpg`, `.jpeg`, `.png`, or `.webp` format
- Phone camera photos are supported (handles glare, angles, varied lighting)
- Dependencies must be installed: `cd .agents/skills/scan-collection/scripts && npm install`

## Workflow

1. Ask the user for the path to their photo directory
2. Ask the user whether to merge with an existing `collection.json` (if one exists)
3. Run the crop script:
   ```bash
   cd .agents/skills/scan-collection/scripts && npx tsx crop-cards.ts <photo-dir>
   ```
   - `<photo-dir>`: Path to directory containing card photos
   - Creates `<photo-dir>/cropped/` with individual card images
   - Optional flags: `--min-area-pct`, `--max-area-pct`, `--card-ratio`, `--ratio-tolerance`
4. **User reviews cropped images** (optional but recommended — check for missed or poorly cropped cards)
5. Run the scan script:
   ```bash
   cd .agents/skills/scan-collection/scripts && npx tsx scan-cards.ts <photo-dir> [raw-cards-path]
   ```
   - `<photo-dir>`: Path to photo directory (must contain `cropped/` subfolder from step 3)
   - `[raw-cards-path]`: Where to write `raw-cards.json` (default: `raw-cards.json` in current directory)
6. Review `raw-cards.json` — show the user the detected cards and warnings (uncertain cards are listed in warnings)
7. Ask the user if they want to proceed with enrichment
8. Run the enrichment script:
   ```bash
   cd .agents/skills/scan-collection/scripts && npx tsx enrich-cards.ts <raw-cards-path> <output-path> [--merge]
   ```
   - `<raw-cards-path>`: Path to `raw-cards.json` from step 5
   - `<output-path>`: Where to write `photo-collection.json`
   - `--merge`: Optional flag to merge into existing `collection.json` (backs up to `collection.json.bak`)
9. Inform the user of the results: cards detected, enriched, not found, uncertain cards for review

## Output

- `<photo-dir>/cropped/` — individual card images (from crop-cards.ts)
- `raw-cards.json` — intermediate file with detected card names, quantities, confidence levels, and source photos
- `photo-collection.json` — enriched card library (same schema as `collection.json`), usable by all downstream MTG deck skills

## Troubleshooting

- **"No contours found"**: Photos may have poor contrast between cards and playmat. Try better-lit photos with a contrasting background
- **"LM Studio not running"**: Start LM Studio and load the Gemma 4 model before scanning
- **"Invalid JSON from model"**: Gemma 4 sometimes wraps JSON in markdown. The script handles this automatically with retry + brace-matching
- **"npm install fails on sharp"**: Sharp requires native build tools on Windows. Install Visual Studio Build Tools or try `npm install --ignore-scripts` then `npm install sharp` separately
- **Too many/few cards detected**: Adjust `--min-area-pct` and `--max-area-pct` flags on crop-cards.ts
- **Cards not found on Scryfall**: The vision model may have misread a card name. Check `raw-cards.json` for typos
- **Rate limiting**: Scryfall requests are rate-limited to 550ms. Large collections may take a few minutes
