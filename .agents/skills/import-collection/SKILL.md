---
name: import-collection
description: "Use when the user needs to import their MTG card collection from an Archidekt CSV export. Triggers include requests to 'load my collection', 'import my cards', 'parse my CSV', or 'read my card library'."
---

# Import Collection

Parse an Archidekt CSV export and enrich each card with Scryfall data (mana cost, type, color identity, rules text, legality, etc.).

## Workflow

1. Ask the user for the path to their Archidekt CSV export file
2. Run the import script:
   ```bash
   cd .agents/skills/import-collection/scripts && npx tsx import-collection.ts <csv-path> <output-path>
   ```
   - `<csv-path>`: Path to the Archidekt CSV file
   - `<output-path>`: Where to write `collection.json` (default: `collection.json` in current directory)
3. Review the output for warnings (cards not found on Scryfall, missing columns)
4. Inform the user of the results: how many cards imported, any issues

## CSV Format

The Archidekt CSV export has dynamic columns (user-configurable). The script auto-detects columns by name. Required: at least a card name column. A quantity column is expected but defaults to 1 if missing.

## Output

`collection.json` — the enriched card library used by all other MTG deck skills.

## Troubleshooting

- **"CSV must have a Card column"**: The CSV needs a column named "Card", "Card Name", or "Name"
- **Cards not found on Scryfall**: Check for typos in card names. The script uses fuzzy matching but some names may not resolve
- **Rate limiting**: The script respects Scryfall's rate limits (550ms between requests). Large collections (500+ cards) may take a few minutes
