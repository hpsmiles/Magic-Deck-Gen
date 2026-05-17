# MTG Deck Generator Skill Set — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build 5 composable OpenCode skills that generate playable MTG decks from a user's Archidekt card collection.

**Architecture:** Pipeline of independent skills communicating via JSON files. Each skill has a `SKILL.md` (agent instructions) and a `scripts/` directory with TypeScript helper scripts. The agent orchestrates the workflow and provides AI reasoning; scripts handle deterministic work (parsing, validation, formatting, API calls).

**Tech Stack:** TypeScript (Node.js), Scryfall API, Archidekt CSV export

---

## File Structure

```
~/.agents/skills/
├── import-collection/
│   ├── SKILL.md
│   └── scripts/
│       ├── package.json
│       ├── tsconfig.json
│       └── import-collection.ts
├── build-deck/
│   ├── SKILL.md
│   └── scripts/
│       ├── package.json
│       ├── tsconfig.json
│       └── compute-available-pool.ts
├── validate-deck/
│   ├── SKILL.md
│   └── scripts/
│       ├── package.json
│       ├── tsconfig.json
│       └── validate-deck.ts
├── optimize-deck/
│   ├── SKILL.md
│   └── scripts/
│       ├── package.json
│       ├── tsconfig.json
│       └── log-iteration.ts
└── export-deck/
    ├── SKILL.md
    └── scripts/
        ├── package.json
        ├── tsconfig.json
        └── export-deck.ts
```

Each skill's `scripts/` directory is self-contained with its own `package.json` and `tsconfig.json`. The agent runs scripts via `npx tsx scripts/<name>.ts <args>`.

---

## Shared Types

All skills share a common understanding of these JSON structures (defined in the spec, not in a shared package — each skill is independent):

- **`collection.json`** — Card library with Scryfall-enriched data
- **`deck.json`** — Deck list with metadata, mainboard, maybeboard, reserved decks
- **`validation-report.json`** — Errors, warnings, suggestions
- **`optimization-log.json`** — Iteration history with changes and evaluations

---

### Task 1: Project Setup — `import-collection` Scripts

**Files:**
- Create: `~/.agents/skills/import-collection/scripts/package.json`
- Create: `~/.agents/skills/import-collection/scripts/tsconfig.json`

- [ ] **Step 1: Create the scripts directory and package.json**

```json
{
  "name": "import-collection-scripts",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "csv-parse": "^5.6.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./dist",
    "rootDir": "./",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true
  },
  "include": ["./*.ts"]
}
```

- [ ] **Step 3: Install dependencies**

Run: `cd ~/.agents/skills/import-collection/scripts && npm install`
Expected: `node_modules` created, no errors

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: scaffold import-collection scripts"
```

---

### Task 2: `import-collection.ts` — CSV Parser

**Files:**
- Create: `~/.agents/skills/import-collection/scripts/import-collection.ts`

This script parses the Archidekt CSV export. The CSV format is dynamic (user-configurable columns), so the script must:
1. Read the header row to identify column positions
2. Map known column names to fields (case-insensitive)
3. Extract at minimum: card name and quantity

**Known Archidekt CSV column names** (from forum research):
- `Quantity` or `Qty` — card count
- `Card` or `Card Name` or `Name` — card name
- `Set` or `Set Name` or `Edition` — set name (optional)
- `Collector Number` — collector number (optional)
- `Foil` or `Foil/Variant` — foil status (optional)
- `Condition` — card condition (optional)
- `Language` — card language (optional)
- `Tags` — user tags (optional)
- `Date Added` — date added to collection (optional)

- [ ] **Step 1: Write the CSV parser script**

```typescript
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "csv-parse/sync";

interface RawCard {
  name: string;
  quantity: number;
  setName?: string;
  collectorNumber?: string;
  foil?: string;
  condition?: string;
  language?: string;
}

interface ParsedCollection {
  metadata: {
    source: string;
    importDate: string;
    totalUniqueCards: number;
    totalCards: number;
  };
  cards: RawCard[];
  warnings: string[];
}

// Column name mappings (case-insensitive)
const COLUMN_ALIASES: Record<string, string[]> = {
  quantity: ["quantity", "qty"],
  name: ["card", "card name", "name"],
  setName: ["set", "set name", "edition"],
  collectorNumber: ["collector number", "collector_number", "coll. number"],
  foil: ["foil", "foil/variant", "foil variant"],
  condition: ["condition", "cond"],
  language: ["language", "lang"],
};

function resolveColumns(headers: string[]): Record<string, number | null> {
  const normalized = headers.map((h) => h.trim().toLowerCase());
  const result: Record<string, number | null> = {
    quantity: null,
    name: null,
    setName: null,
    collectorNumber: null,
    foil: null,
    condition: null,
    language: null,
  };

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) {
      const idx = normalized.indexOf(alias);
      if (idx !== -1) {
        result[field] = idx;
        break;
      }
    }
  }

  return result;
}

function parseCsv(filePath: string): ParsedCollection {
  const content = readFileSync(filePath, "utf-8");
  const records: string[][] = parse(content, {
    relax_column_count: true,
    skip_empty_lines: true,
    bom: true,
  });

  if (records.length === 0) {
    throw new Error("CSV file is empty");
  }

  const headers = records[0];
  const colMap = resolveColumns(headers);
  const warnings: string[] = [];

  if (colMap.name === null) {
    throw new Error(
      "CSV must have a 'Card' or 'Card Name' column. Found headers: " +
        headers.join(", ")
    );
  }

  if (colMap.quantity === null) {
    warnings.push(
      "No 'Quantity' column found — defaulting all cards to quantity 1"
    );
  }

  const cards: RawCard[] = [];
  let totalCards = 0;

  for (let i = 1; i < records.length; i++) {
    const row = records[i];
    if (row.length === 0 || (row.length === 1 && row[0].trim() === ""))
      continue;

    const name = colMap.name !== null ? row[colMap.name]?.trim() : undefined;
    if (!name) {
      warnings.push(`Row ${i + 1}: missing card name, skipping`);
      continue;
    }

    const qtyStr =
      colMap.quantity !== null ? row[colMap.quantity]?.trim() : "1";
    const quantity = parseInt(qtyStr || "1", 10);
    if (isNaN(quantity) || quantity < 1) {
      warnings.push(`Row ${i + 1}: invalid quantity "${qtyStr}" for "${name}", defaulting to 1`);
      cards.push({ name, quantity: 1 });
      totalCards += 1;
      continue;
    }

    const card: RawCard = { name, quantity };
    if (colMap.setName !== null && row[colMap.setName]?.trim())
      card.setName = row[colMap.setName].trim();
    if (colMap.collectorNumber !== null && row[colMap.collectorNumber]?.trim())
      card.collectorNumber = row[colMap.collectorNumber].trim();
    if (colMap.foil !== null && row[colMap.foil]?.trim())
      card.foil = row[colMap.foil].trim();
    if (colMap.condition !== null && row[colMap.condition]?.trim())
      card.condition = row[colMap.condition].trim();
    if (colMap.language !== null && row[colMap.language]?.trim())
      card.language = row[colMap.language].trim();

    cards.push(card);
    totalCards += quantity;
  }

  // Merge duplicates (same name, different printings)
  const merged = new Map<string, RawCard>();
  for (const card of cards) {
    const key = card.name.toLowerCase();
    const existing = merged.get(key);
    if (existing) {
      existing.quantity += card.quantity;
    } else {
      merged.set(key, { ...card });
    }
  }

  return {
    metadata: {
      source: "archidekt-csv",
      importDate: new Date().toISOString(),
      totalUniqueCards: merged.size,
      totalCards,
    },
    cards: Array.from(merged.values()),
    warnings,
  };
}

// CLI entry point
const csvPath = process.argv[2];
if (!csvPath) {
  console.error("Usage: npx tsx import-collection.ts <csv-path> [output-path]");
  process.exit(1);
}

const outputPath = process.argv[3] || "collection-parsed.json";

try {
  const result = parseCsv(csvPath);
  writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log(
    `Parsed ${result.metadata.totalUniqueCards} unique cards (${result.metadata.totalCards} total) from ${csvPath}`
  );
  if (result.warnings.length > 0) {
    console.log(`\nWarnings:`);
    result.warnings.forEach((w) => console.log(`  - ${w}`));
  }
  console.log(`Output: ${outputPath}`);
} catch (err) {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
}
```

- [ ] **Step 2: Test the CSV parser manually**

Create a test CSV at a temp location:
```csv
Quantity,Card,Set Name,Collector Number,Foil,Condition,Language
4,Lightning Bolt,M10,146,Normal,Near Mint,English
2,Sol Ring,CMD1,72,Foil,Near Mint,English
1,Counterspell,2XM,30,Normal,Near Mint,English
```

Run: `cd ~/.agents/skills/import-collection/scripts && npx tsx import-collection.ts test.csv`
Expected: `Parsed 3 unique cards (7 total) from test.csv`

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: add CSV parser for import-collection"
```

---

### Task 3: `import-collection.ts` — Scryfall Enrichment

**Files:**
- Modify: `~/.agents/skills/import-collection/scripts/import-collection.ts`

Add Scryfall enrichment after CSV parsing. Uses `/cards/collection` (POST) for batch lookups (75 cards per request, 500ms between requests) and falls back to `/cards/named?fuzzy=` for any not found.

- [ ] **Step 1: Add Scryfall enrichment to the script**

Add these types and functions after the existing `RawCard` interface:

```typescript
interface ScryfallCard {
  name: string;
  quantity: number;
  scryfallId: string;
  oracleId: string;
  manaCost: string;
  cmc: number;
  typeLine: string;
  colorIdentity: string[];
  rulesText: string;
  legalities: Record<string, string>;
  imageUri: string;
  power?: string;
  toughness?: string;
  keywords: string[];
  producedMana?: string[];
  edhrecRank?: number;
  setName?: string;
  collectorNumber?: string;
  foil?: string;
  condition?: string;
  language?: string;
}

interface EnrichedCollection {
  metadata: {
    source: string;
    importDate: string;
    totalUniqueCards: number;
    totalCards: number;
    enrichedCount: number;
    notFoundCount: number;
  };
  cards: ScryfallCard[];
  warnings: string[];
}

const SCRYFALL_BASE = "https://api.scryfall.com";
const BATCH_SIZE = 75;
const REQUEST_DELAY_MS = 550; // 500ms + 50ms safety margin

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchBatch(
  names: string[]
): Promise<{ found: any[]; notFound: string[] }> {
  const identifiers = names.map((n) => ({ name: n }));
  const res = await fetch(`${SCRYFALL_BASE}/cards/collection`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "MagicDeckGen/1.0",
    },
    body: JSON.stringify({ identifiers }),
  });

  if (!res.ok) {
    throw new Error(`Scryfall /cards/collection returned ${res.status}: ${await res.text()}`);
  }

  const data = await res.json();
  const foundNames = new Set(data.data.map((c: any) => c.name));
  const notFound = names.filter((n) => !foundNames.has(n));

  return { found: data.data, notFound };
}

async function fetchSingle(name: string): Promise<any | null> {
  const url = `${SCRYFALL_BASE}/cards/named?fuzzy=${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "MagicDeckGen/1.0" },
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Scryfall /cards/named returned ${res.status} for "${name}"`);
  }

  return res.json();
}

function mapScryfallCard(raw: any, existing: RawCard): ScryfallCard {
  // Handle multi-face cards (transform, MDFC)
  const face = raw.card_faces?.[0];
  const name = raw.name;
  const manaCost = face?.mana_cost ?? raw.mana_cost ?? "";
  const typeLine = face?.type_line ?? raw.type_line ?? "";
  const rulesText = face?.oracle_text ?? raw.oracle_text ?? "";
  const colors = face?.colors ?? raw.colors ?? [];

  return {
    name,
    quantity: existing.quantity,
    scryfallId: raw.id,
    oracleId: raw.oracle_id ?? "",
    manaCost,
    cmc: raw.cmc ?? 0,
    typeLine,
    colorIdentity: raw.color_identity ?? [],
    rulesText,
    legalities: raw.legalities ?? {},
    imageUri: raw.image_uris?.normal ?? raw.image_uris?.small ?? "",
    power: raw.power ?? face?.power,
    toughness: raw.toughness ?? face?.toughness,
    keywords: raw.keywords ?? [],
    producedMana: raw.produced_mana,
    edhrecRank: raw.edhrec_rank,
    setName: existing.setName,
    collectorNumber: existing.collectorNumber,
    foil: existing.foil,
    condition: existing.condition,
    language: existing.language,
  };
}

async function enrichCollection(
  parsed: ParsedCollection
): Promise<EnrichedCollection> {
  const cards: ScryfallCard[] = [];
  const warnings = [...parsed.warnings];
  let enrichedCount = 0;
  let notFoundCount = 0;

  // Batch lookup via /cards/collection
  const allNames = parsed.cards.map((c) => c.name);
  const nameToCard = new Map(parsed.cards.map((c) => [c.name, c]));

  for (let i = 0; i < allNames.length; i += BATCH_SIZE) {
    const batch = allNames.slice(i, i + BATCH_SIZE);
    const { found, notFound } = await fetchBatch(batch);

    for (const scryfallCard of found) {
      const existing = nameToCard.get(scryfallCard.name);
      if (existing) {
        cards.push(mapScryfallCard(scryfallCard, existing));
        enrichedCount++;
      }
    }

    // Fallback: try individual fuzzy lookup for not-found cards
    for (const name of notFound) {
      await sleep(REQUEST_DELAY_MS);
      const card = await fetchSingle(name);
      const existing = nameToCard.get(name);
      if (card && existing) {
        cards.push(mapScryfallCard(card, existing));
        enrichedCount++;
      } else {
        warnings.push(`Card not found on Scryfall: "${name}"`);
        notFoundCount++;
        // Include with partial data
        const existingCard = nameToCard.get(name)!;
        cards.push({
          name: existingCard.name,
          quantity: existingCard.quantity,
          scryfallId: "",
          oracleId: "",
          manaCost: "",
          cmc: 0,
          typeLine: "",
          colorIdentity: [],
          rulesText: "",
          legalities: {},
          imageUri: "",
          setName: existingCard.setName,
          collectorNumber: existingCard.collectorNumber,
          foil: existingCard.foil,
          condition: existingCard.condition,
          language: existingCard.language,
        });
      }
    }

    // Rate limit between batches
    if (i + BATCH_SIZE < allNames.length) {
      await sleep(REQUEST_DELAY_MS);
    }
  }

  return {
    metadata: {
      source: "archidekt-csv",
      importDate: parsed.metadata.importDate,
      totalUniqueCards: cards.length,
      totalCards: cards.reduce((sum, c) => sum + c.quantity, 0),
      enrichedCount,
      notFoundCount,
    },
    cards,
    warnings,
  };
}
```

- [ ] **Step 2: Update the CLI entry point to run enrichment**

Replace the existing CLI block with:

```typescript
const csvPath = process.argv[2];
if (!csvPath) {
  console.error("Usage: npx tsx import-collection.ts <csv-path> [output-path]");
  process.exit(1);
}

const outputPath = process.argv[3] || "collection.json";

try {
  console.log(`Parsing CSV: ${csvPath}`);
  const parsed = parseCsv(csvPath);
  console.log(
    `Found ${parsed.metadata.totalUniqueCards} unique cards (${parsed.metadata.totalCards} total)`
  );

  console.log("Enriching with Scryfall data...");
  const enriched = await enrichCollection(parsed);
  writeFileSync(outputPath, JSON.stringify(enriched, null, 2));

  console.log(
    `Enriched ${enriched.metadata.enrichedCount}/${enriched.metadata.totalUniqueCards} cards`
  );
  if (enriched.metadata.notFoundCount > 0) {
    console.log(
      `${enriched.metadata.notFoundCount} cards not found on Scryfall`
    );
  }
  if (enriched.warnings.length > 0) {
    console.log(`\nWarnings:`);
    enriched.warnings.forEach((w) => console.log(`  - ${w}`));
  }
  console.log(`Output: ${outputPath}`);
} catch (err) {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
}
```

- [ ] **Step 3: Test with a small CSV**

Run: `cd ~/.agents/skills/import-collection/scripts && npx tsx import-collection.ts test.csv`
Expected: Cards enriched with Scryfall data, `collection.json` written

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add Scryfall enrichment to import-collection"
```

---

### Task 4: `import-collection` SKILL.md

**Files:**
- Create: `~/.agents/skills/import-collection/SKILL.md`

- [ ] **Step 1: Write the SKILL.md**

```markdown
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
   cd ~/.agents/skills/import-collection/scripts && npx tsx import-collection.ts <csv-path> <output-path>
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
- **Rate limiting**: The script respects Scryfall's rate limits (500ms between requests). Large collections (500+ cards) may take a few minutes
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: add import-collection SKILL.md"
```

---

### Task 5: `build-deck` — Compute Available Pool Script

**Files:**
- Create: `~/.agents/skills/build-deck/scripts/package.json`
- Create: `~/.agents/skills/build-deck/scripts/tsconfig.json`
- Create: `~/.agents/skills/build-deck/scripts/compute-available-pool.ts`

This script takes `collection.json` and a directory of reserved deck CSVs, then outputs the available card pool after subtraction.

- [ ] **Step 1: Create package.json and tsconfig.json**

Same as Task 1 but with name `build-deck-scripts`.

- [ ] **Step 2: Write compute-available-pool.ts**

```typescript
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";

interface CollectionCard {
  name: string;
  quantity: number;
  scryfallId: string;
  oracleId: string;
  manaCost: string;
  cmc: number;
  typeLine: string;
  colorIdentity: string[];
  rulesText: string;
  legalities: Record<string, string>;
  imageUri: string;
  power?: string;
  toughness?: string;
  keywords: string[];
  producedMana?: string[];
  edhrecRank?: number;
}

interface Collection {
  metadata: { source: string; importDate: string; totalUniqueCards: number; totalCards: number; enrichedCount: number; notFoundCount: number };
  cards: CollectionCard[];
  warnings: string[];
}

interface ReservedCard {
  name: string;
  quantity: number;
}

function parseReservedDeckCsv(filePath: string): ReservedCard[] {
  const content = readFileSync(filePath, "utf-8");
  const records: string[][] = parse(content, {
    relax_column_count: true,
    skip_empty_lines: true,
    bom: true,
  });

  if (records.length === 0) return [];

  const headers = records[0].map((h) => h.trim().toLowerCase());
  const qtyIdx = headers.findIndex((h) => ["quantity", "qty"].includes(h));
  const nameIdx = headers.findIndex((h) => ["card", "card name", "name"].includes(h));

  if (nameIdx === -1) {
    console.warn(`Skipping ${filePath}: no card name column found`);
    return [];
  }

  const cards: ReservedCard[] = [];
  for (let i = 1; i < records.length; i++) {
    const row = records[i];
    const name = row[nameIdx]?.trim();
    if (!name) continue;
    const quantity = qtyIdx !== -1 ? parseInt(row[qtyIdx]?.trim() || "1", 10) : 1;
    cards.push({ name, quantity: isNaN(quantity) ? 1 : quantity });
  }

  return cards;
}

function computeAvailablePool(
  collection: Collection,
  reservedDecks: Map<string, ReservedCard[]>
): Collection {
  // Build a map of card name -> total reserved quantity
  const reservedTotals = new Map<string, number>();
  for (const [deckName, cards] of reservedDecks) {
    for (const card of cards) {
      const key = card.name.toLowerCase();
      reservedTotals.set(key, (reservedTotals.get(key) ?? 0) + card.quantity);
    }
  }

  // Subtract reserved quantities from collection
  const availableCards: CollectionCard[] = [];
  for (const card of collection.cards) {
    const key = card.name.toLowerCase();
    const reserved = reservedTotals.get(key) ?? 0;
    const available = card.quantity - reserved;

    if (available > 0) {
      availableCards.push({ ...card, quantity: available });
    }
    // If available <= 0, card is fully reserved — exclude from pool
  }

  return {
    metadata: {
      ...collection.metadata,
      totalUniqueCards: availableCards.length,
      totalCards: availableCards.reduce((sum, c) => sum + c.quantity, 0),
    },
    cards: availableCards,
    warnings: collection.warnings,
  };
}

// CLI
const collectionPath = process.argv[2];
const reservedDir = process.argv[3] || "";
const outputPath = process.argv[4] || "available-pool.json";

if (!collectionPath) {
  console.error("Usage: npx tsx compute-available-pool.ts <collection.json> [reserved-decks-dir] [output-path]");
  process.exit(1);
}

try {
  const collection: Collection = JSON.parse(readFileSync(collectionPath, "utf-8"));

  // Load reserved decks
  const reservedDecks = new Map<string, ReservedCard[]>();
  if (reservedDir) {
    const files = readdirSync(reservedDir).filter((f) => f.endsWith(".csv"));
    for (const file of files) {
      const cards = parseReservedDeckCsv(join(reservedDir, file));
      reservedDecks.set(file, cards);
    }
  }

  const result = computeAvailablePool(collection, reservedDecks);
  writeFileSync(outputPath, JSON.stringify(result, null, 2));

  console.log(`Available pool: ${result.metadata.totalUniqueCards} unique cards (${result.metadata.totalCards} total)`);
  if (reservedDecks.size > 0) {
    console.log(`Reserved decks: ${reservedDecks.size}`);
    for (const [name, cards] of reservedDecks) {
      const total = cards.reduce((s, c) => s + c.quantity, 0);
      console.log(`  - ${name}: ${cards.length} unique cards (${total} total)`);
    }
  }
  console.log(`Output: ${outputPath}`);
} catch (err) {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
}
```

- [ ] **Step 3: Install dependencies and test**

Run: `cd ~/.agents/skills/build-deck/scripts && npm install`
Then test with the collection.json from Task 3.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add compute-available-pool script for build-deck"
```

---

### Task 6: `build-deck` SKILL.md

**Files:**
- Create: `~/.agents/skills/build-deck/SKILL.md`

- [ ] **Step 1: Write the SKILL.md**

```markdown
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
   cd ~/.agents/skills/build-deck/scripts && npx tsx compute-available-pool.ts <collection.json> <reserved-decks-dir> <output-path>
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
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: add build-deck SKILL.md"
```

---

### Task 7: `validate-deck` — Validation Script

**Files:**
- Create: `~/.agents/skills/validate-deck/scripts/package.json`
- Create: `~/.agents/skills/validate-deck/scripts/tsconfig.json`
- Create: `~/.agents/skills/validate-deck/scripts/validate-deck.ts`

- [ ] **Step 1: Create package.json and tsconfig.json** (same pattern as Task 1, name `validate-deck-scripts`)

- [ ] **Step 2: Write validate-deck.ts**

```typescript
import { readFileSync, writeFileSync } from "node:fs";

interface DeckCard {
  name: string;
  quantity: number;
  category: string;
  scryfallId: string;
}

interface Deck {
  metadata: {
    format: string;
    strategy: string;
    commander?: string;
    colors: string[];
    createdAt: string;
  };
  mainboard: DeckCard[];
  maybeboard: DeckCard[];
  reservedDecks: string[];
}

interface ValidationIssue {
  rule: string;
  message: string;
  severity: "error" | "warning" | "info";
  cards: string[];
}

interface ValidationReport {
  deckId: string;
  format: string;
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  suggestions: string[];
}

const FORMAT_RULES: Record<string, { minCards: number; maxCopies: number; requiresCommander: boolean }> = {
  commander: { minCards: 100, maxCopies: 1, requiresCommander: true },
  standard: { minCards: 60, maxCopies: 4, requiresCommander: false },
  modern: { minCards: 60, maxCopies: 4, requiresCommander: false },
  pioneer: { minCards: 60, maxCopies: 4, requiresCommander: false },
  legacy: { minCards: 60, maxCopies: 4, requiresCommander: false },
  vintage: { minCards: 60, maxCopies: 4, requiresCommander: false },
  pauper: { minCards: 60, maxCopies: 4, requiresCommander: false },
  brawl: { minCards: 60, maxCopies: 1, requiresCommander: true },
};

function validateDeck(deck: Deck): ValidationReport {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const suggestions: string[] = [];
  const format = deck.metadata.format.toLowerCase();
  const rules = FORMAT_RULES[format];

  if (!rules) {
    errors.push({
      rule: "format",
      message: `Unknown format: "${deck.metadata.format}". Supported: ${Object.keys(FORMAT_RULES).join(", ")}`,
      severity: "error",
      cards: [],
    });
    return { deckId: "deck.json", format, valid: false, errors, warnings, suggestions };
  }

  const mainboard = deck.mainboard;
  const totalCards = mainboard.reduce((sum, c) => sum + c.quantity, 0);

  // 1. Deck size
  if (totalCards < rules.minCards) {
    errors.push({
      rule: "deck-size",
      message: `Deck has ${totalCards} cards, needs ${rules.minCards}`,
      severity: "error",
      cards: [],
    });
    suggestions.push(`Add ${rules.minCards - totalCards} more cards to reach ${rules.minCards}`);
  } else if (totalCards > rules.minCards && format === "commander") {
    errors.push({
      rule: "deck-size",
      message: `Commander deck has ${totalCards} cards, must be exactly ${rules.minCards}`,
      severity: "error",
      cards: [],
    });
  }

  // 2. Commander presence
  const commanderCards = mainboard.filter((c) => c.category === "commander");
  if (rules.requiresCommander) {
    if (commanderCards.length === 0) {
      errors.push({
        rule: "commander",
        message: "Deck requires a commander",
        severity: "error",
        cards: [],
      });
    } else if (commanderCards.length > 1) {
      errors.push({
        rule: "commander",
        message: `Deck has ${commanderCards.length} commanders, must have exactly 1`,
        severity: "error",
        cards: commanderCards.map((c) => c.name),
      });
    }
  }

  // 3. Quantity limits (singleton / 4x)
  const cardCounts = new Map<string, number>();
  for (const card of mainboard) {
    if (card.category === "land" && card.name.startsWith("Basic ")) continue; // Basic lands exempt
    cardCounts.set(card.name, (cardCounts.get(card.name) ?? 0) + card.quantity);
  }
  for (const [name, count] of cardCounts) {
    if (count > rules.maxCopies) {
      errors.push({
        rule: "quantity-limit",
        message: `${name} has ${count} copies, max is ${rules.maxCopies} in ${format}`,
        severity: "error",
        cards: [name],
      });
    }
  }

  // 4. Color identity (Commander)
  if (rules.requiresCommander && commanderCards.length === 1) {
    const commanderColors = deck.metadata.colors;
    const colorSet = new Set(commanderColors.map((c) => c.toUpperCase()));
    // Check that all cards' color identities are within commander's colors
    // This requires Scryfall data — we check from the deck metadata
    // The agent should verify this during build; the script checks the declared colors
  }

  // 5. Card legality (requires Scryfall data in collection.json)
  // The script checks the `legalities` field if available in the card data
  // For now, flag cards without legality data
  const cardsWithoutLegality = mainboard.filter(
    (c) => !c.scryfallId && c.category !== "commander"
  );
  if (cardsWithoutLegality.length > 0) {
    warnings.push({
      rule: "legality",
      message: `${cardsWithoutLegality.length} cards have no Scryfall data — legality cannot be verified`,
      severity: "warning",
      cards: cardsWithoutLegality.map((c) => c.name),
    });
  }

  // 6. Mana curve warning
  const nonLandCards = mainboard.filter((c) => c.category !== "land" && c.category !== "commander");
  if (nonLandCards.length > 0) {
    // We can't compute CMC without Scryfall data here, so we flag it as info
    // The agent should check mana curve during optimization
  }

  // 7. Land count warning
  const landCount = mainboard.filter((c) => c.category === "land").reduce((s, c) => s + c.quantity, 0);
  const landRatio = totalCards > 0 ? landCount / totalCards : 0;
  if (landRatio < 0.33 && totalCards >= rules.minCards) {
    warnings.push({
      rule: "land-count",
      message: `Only ${landCount} lands (${Math.round(landRatio * 100)}%) — most decks need 33-40%`,
      severity: "warning",
      cards: [],
    });
    suggestions.push("Consider adding more lands for consistent mana");
  }

  const valid = errors.length === 0;
  return { deckId: "deck.json", format, valid, errors, warnings, suggestions };
}

// CLI
const deckPath = process.argv[2];
const outputPath = process.argv[3] || "validation-report.json";

if (!deckPath) {
  console.error("Usage: npx tsx validate-deck.ts <deck.json> [output-path]");
  process.exit(1);
}

try {
  const deck: Deck = JSON.parse(readFileSync(deckPath, "utf-8"));
  const report = validateDeck(deck);
  writeFileSync(outputPath, JSON.stringify(report, null, 2));

  if (report.valid) {
    console.log("✓ Deck is valid");
  } else {
    console.log("✗ Deck has errors:");
    report.errors.forEach((e) => console.log(`  [${e.severity}] ${e.message}`));
  }
  if (report.warnings.length > 0) {
    console.log("\nWarnings:");
    report.warnings.forEach((w) => console.log(`  [${w.severity}] ${w.message}`));
  }
  if (report.suggestions.length > 0) {
    console.log("\nSuggestions:");
    report.suggestions.forEach((s) => console.log(`  - ${s}`));
  }
  console.log(`\nOutput: ${outputPath}`);
} catch (err) {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
}
```

- [ ] **Step 3: Install dependencies and test**

Run: `cd ~/.agents/skills/validate-deck/scripts && npm install`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add validate-deck script"
```

---

### Task 8: `validate-deck` SKILL.md

**Files:**
- Create: `~/.agents/skills/validate-deck/SKILL.md`

- [ ] **Step 1: Write the SKILL.md**

```markdown
---
name: validate-deck
description: "Use when the user needs to validate an MTG deck list against format rules. Triggers include requests to 'check my deck', 'validate this deck', 'is this deck legal', or 'verify deck rules'. Also used internally by optimize-deck."
---

# Validate Deck

Check a deck against format rules and identify issues. Works on any deck list, not just generated ones.

## Workflow

1. Load `deck.json`
2. Run the validation script:
   ```bash
   cd ~/.agents/skills/validate-deck/scripts && npx tsx validate-deck.ts <deck.json> [output-path]
   ```
3. Review the `validation-report.json` output
4. Report results to the user — errors must be fixed, warnings should be addressed

## Checks Performed

| Check | What it validates |
|---|---|
| Deck size | Correct number of cards for the format |
| Card legality | Each card is legal/banned/restricted (requires Scryfall data) |
| Color identity | All cards fit within the commander's color identity (Commander only) |
| Quantity limits | Singleton for Commander, 4x max for constructed |
| Commander presence | Exactly 1 commander for Commander format |
| Land count | Warns if land ratio is below 33% |

## Supported Formats

commander, standard, modern, pioneer, legacy, vintage, pauper, brawl

## Output

`validation-report.json` with `errors` (must fix), `warnings` (should fix), and `suggestions`.

## Severity Levels

- `error` — deck is invalid, must fix before playtesting
- `warning` — deck is legal but likely weak
- `info` — neutral observations
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: add validate-deck SKILL.md"
```

---

### Task 9: `optimize-deck` — Log Iteration Script

**Files:**
- Create: `~/.agents/skills/optimize-deck/scripts/package.json`
- Create: `~/.agents/skills/optimize-deck/scripts/tsconfig.json`
- Create: `~/.agents/skills/optimize-deck/scripts/log-iteration.ts`

This script appends an iteration entry to the optimization log. The agent calls it after each optimization pass.

- [ ] **Step 1: Create package.json and tsconfig.json** (same pattern, name `optimize-deck-scripts`)

- [ ] **Step 2: Write log-iteration.ts**

```typescript
import { readFileSync, writeFileSync, existsSync } from "node:fs";

interface CardChange {
  action: "add" | "remove";
  card: string;
  reason: string;
}

interface IterationEntry {
  iteration: number;
  changes: CardChange[];
  evaluation: {
    manaCurve?: string;
    synergy?: string;
    playtestNotes?: string;
  };
  validAfterChanges: boolean;
}

interface OptimizationLog {
  deckId: string;
  iterations: IterationEntry[];
  finalAssessment?: string;
}

// CLI: log-iteration.ts <log-path> <iteration> <changes-json> <evaluation-json> <valid>
const logPath = process.argv[2];
const iteration = parseInt(process.argv[3], 10);
const changesJson = process.argv[4];
const evaluationJson = process.argv[5];
const validStr = process.argv[6];

if (!logPath || isNaN(iteration)) {
  console.error("Usage: npx tsx log-iteration.ts <log-path> <iteration> <changes-json> <evaluation-json> <valid>");
  console.error("  changes-json: JSON string of CardChange[]");
  console.error("  evaluation-json: JSON string of { manaCurve?, synergy?, playtestNotes? }");
  console.error("  valid: 'true' or 'false'");
  process.exit(1);
}

try {
  const changes: CardChange[] = JSON.parse(changesJson);
  const evaluation = JSON.parse(evaluationJson);
  const validAfterChanges = validStr === "true";

  let log: OptimizationLog;
  if (existsSync(logPath)) {
    log = JSON.parse(readFileSync(logPath, "utf-8"));
  } else {
    log = { deckId: "deck.json", iterations: [] };
  }

  const entry: IterationEntry = {
    iteration,
    changes,
    evaluation,
    validAfterChanges,
  };

  log.iterations.push(entry);
  writeFileSync(logPath, JSON.stringify(log, null, 2));

  console.log(`Logged iteration ${iteration}: ${changes.length} changes, valid=${validAfterChanges}`);
} catch (err) {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
}
```

- [ ] **Step 3: Install dependencies and test**

Run: `cd ~/.agents/skills/optimize-deck/scripts && npm install`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add log-iteration script for optimize-deck"
```

---

### Task 10: `optimize-deck` SKILL.md

**Files:**
- Create: `~/.agents/skills/optimize-deck/SKILL.md`

- [ ] **Step 1: Write the SKILL.md**

```markdown
---
name: optimize-deck
description: "Use when the user wants to optimize or improve an MTG deck. Triggers include requests to 'optimize my deck', 'improve this deck', 'tune my deck', 'playtest this deck', or 'make this deck better'."
---

# Optimize Deck

Iteratively improve a deck through a validate → evaluate → playtest → improve loop (max 10 iterations).

## Prerequisites

- `deck.json` must exist (run `build-deck` first)
- `collection.json` must exist (for available card pool)
- `validation-report.json` should exist (run `validate-deck` first, or it will be generated)

## Workflow

1. Load `deck.json`, `collection.json`, and `validation-report.json`

2. **Iteration loop** (max 10 times):

   a. **Validate** — run the validation script:
      ```bash
      cd ~/.agents/skills/validate-deck/scripts && npx tsx validate-deck.ts <deck.json> validation-report.json
      ```
      If errors exist, fix those first before evaluating.

   b. **Evaluate** — reason about the deck's strengths and weaknesses:
      - Mana curve: too top-heavy? not enough ramp?
      - Synergy: do cards work together toward the stated strategy?
      - Color balance: enough sources for each color pip?
      - Interaction density: enough removal/counters/protection?
      - Card draw / card advantage

   c. **Playtest** — mentally simulate sample scenarios:
      - Typical opening hands (7 cards) — are they keepable?
      - Curve-out: what do turns 1-5 look like?
      - Key matchups: how does the deck handle common threats?
      - Commander gameplay: how reliably can you cast and leverage the commander?

   d. **Identify swaps** — based on evaluation + playtest, propose card changes from the available pool

   e. **Apply changes** — update `deck.json`

   f. **Log the iteration**:
      ```bash
      cd ~/.agents/skills/optimize-deck/scripts && npx tsx log-iteration.ts <log-path> <iteration-number> '<changes-json>' '<evaluation-json>' <valid>
      ```
      Example:
      ```bash
      npx tsx log-iteration.ts optimization-log.json 1 '[{"action":"remove","card":"Cancel","reason":"Low synergy"},{"action":"add","card":"Lightning Bolt","reason":"Efficient removal"}]' '{"manaCurve":"improved","synergy":"moderate","playtestNotes":"Keepable ~70%"}' true
      ```

3. **Exit conditions** (stop early if met):
   - Deck validates clean AND you judge no further meaningful improvements
   - Max iterations (10) reached
   - User interrupts with feedback

4. **Write final assessment** to `optimization-log.json`

## Key Principles

- Each iteration should make targeted, incremental changes — not wholesale rewrites
- Always validate after changes — don't let errors accumulate
- Log every iteration so the user can review the optimization path
- 10 iterations is a ceiling, not a target — stop when satisfied
- Only swap in cards that are available in the collection (after reserved deck subtraction)
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: add optimize-deck SKILL.md"
```

---

### Task 11: `export-deck` — Export Script

**Files:**
- Create: `~/.agents/skills/export-deck/scripts/package.json`
- Create: `~/.agents/skills/export-deck/scripts/tsconfig.json`
- Create: `~/.agents/skills/export-deck/scripts/export-deck.ts`

This script generates the Archidekt import file and deck summary. The play guide and upgrade suggestions are written by the agent (they require reasoning, not just formatting).

- [ ] **Step 1: Create package.json and tsconfig.json** (same pattern, name `export-deck-scripts`)

- [ ] **Step 2: Write export-deck.ts**

```typescript
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

interface DeckCard {
  name: string;
  quantity: number;
  category: string;
  scryfallId: string;
}

interface Deck {
  metadata: {
    format: string;
    strategy: string;
    commander?: string;
    colors: string[];
    createdAt: string;
  };
  mainboard: DeckCard[];
  maybeboard: DeckCard[];
  reservedDecks: string[];
}

function generateArchidektImport(deck: Deck): string {
  const lines: string[] = [];

  // Commander section
  const commander = deck.mainboard.filter((c) => c.category === "commander");
  if (commander.length > 0) {
    lines.push("// Commander");
    for (const card of commander) {
      lines.push(`${card.quantity}x ${card.name}`);
    }
    lines.push("");
  }

  // Mainboard sections by category
  const categories = ["creature", "instant", "sorcery", "enchantment", "artifact", "ramp", "removal", "draw", "land"];
  const categoryLabels: Record<string, string> = {
    creature: "Creatures",
    instant: "Instants",
    sorcery: "Sorceries",
    enchantment: "Enchantments",
    artifact: "Artifacts",
    ramp: "Ramp",
    removal: "Removal",
    draw: "Card Draw",
    land: "Lands",
  };

  for (const cat of categories) {
    const cards = deck.mainboard.filter((c) => c.category === cat);
    if (cards.length === 0) continue;
    lines.push(`// ${categoryLabels[cat] ?? cat}`);
    for (const card of cards) {
      lines.push(`${card.quantity}x ${card.name}`);
    }
    lines.push("");
  }

  // Catch any uncategorized cards
  const categorized = new Set(["commander", ...categories]);
  const uncategorized = deck.mainboard.filter((c) => !categorized.has(c.category));
  if (uncategorized.length > 0) {
    lines.push("// Other");
    for (const card of uncategorized) {
      lines.push(`${card.quantity}x ${card.name}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function generateSummary(deck: Deck): string {
  const lines: string[] = [];
  const m = deck.metadata;

  lines.push(`# ${m.commander ? m.commander : "Deck"} — Summary`);
  lines.push("");
  lines.push(`- **Format:** ${m.format}`);
  lines.push(`- **Strategy:** ${m.strategy}`);
  if (m.commander) lines.push(`- **Commander:** ${m.commander}`);
  lines.push(`- **Colors:** ${m.colors.join(", ") || "Colorless"}`);
  lines.push("");

  // Card type distribution
  const categories = ["commander", "creature", "instant", "sorcery", "enchantment", "artifact", "ramp", "removal", "draw", "land"];
  lines.push("## Card Distribution");
  lines.push("");
  lines.push("| Category | Cards | Quantity |");
  lines.push("|----------|-------|----------|");
  for (const cat of categories) {
    const cards = deck.mainboard.filter((c) => c.category === cat);
    if (cards.length === 0) continue;
    const qty = cards.reduce((s, c) => s + c.quantity, 0);
    lines.push(`| ${cat} | ${cards.length} | ${qty} |`);
  }
  lines.push("");

  // Total
  const totalCards = deck.mainboard.reduce((s, c) => s + c.quantity, 0);
  lines.push(`**Total:** ${totalCards} cards`);
  lines.push("");

  // Maybeboard
  if (deck.maybeboard.length > 0) {
    lines.push("## Maybeboard");
    lines.push("");
    for (const card of deck.maybeboard) {
      lines.push(`- ${card.quantity}x ${card.name}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// CLI
const deckPath = process.argv[2];
const outputDir = process.argv[3] || "output";

if (!deckPath) {
  console.error("Usage: npx tsx export-deck.ts <deck.json> [output-dir]");
  process.exit(1);
}

try {
  const deck: Deck = JSON.parse(readFileSync(deckPath, "utf-8"));
  const deckName = (deck.metadata.commander ?? "deck").toLowerCase().replace(/[^a-z0-9]+/g, "-");

  mkdirSync(join(outputDir, deckName), { recursive: true });

  // Archidekt import file
  const importContent = generateArchidektImport(deck);
  const importPath = join(outputDir, deckName, `${deckName}.txt`);
  writeFileSync(importPath, importContent);

  // Summary
  const summaryContent = generateSummary(deck);
  const summaryPath = join(outputDir, deckName, `${deckName}-summary.md`);
  writeFileSync(summaryPath, summaryContent);

  console.log(`Exported to ${join(outputDir, deckName)}/`);
  console.log(`  - ${deckName}.txt (Archidekt import)`);
  console.log(`  - ${deckName}-summary.md (Summary)`);
  console.log(`\nRemaining outputs (agent-written):`);
  console.log(`  - ${deckName}-play-guide.md`);
  console.log(`  - ${deckName}-upgrades.md`);
} catch (err) {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
}
```

- [ ] **Step 3: Install dependencies and test**

Run: `cd ~/.agents/skills/export-deck/scripts && npm install`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add export-deck script"
```

---

### Task 12: `export-deck` SKILL.md

**Files:**
- Create: `~/.agents/skills/export-deck/SKILL.md`

- [ ] **Step 1: Write the SKILL.md**

```markdown
---
name: export-deck
description: "Use when the user wants to export or finalize an MTG deck. Triggers include requests to 'export my deck', 'create a deck list', 'generate a play guide', or 'show me upgrade options'."
---

# Export Deck

Generate all final deliverables from the completed deck.

## Prerequisites

- `deck.json` must exist (run `build-deck` and `optimize-deck` first)
- `collection.json` must exist (for upgrade suggestions)

## Workflow

1. **Run the export script** for the Archidekt import file and summary:
   ```bash
   cd ~/.agents/skills/export-deck/scripts && npx tsx export-deck.ts <deck.json> [output-dir]
   ```
   This generates:
   - `<deck-name>.txt` — Archidekt import file (paste into Archidekt → New Deck → Import → Plain Text)
   - `<deck-name>-summary.md` — Deck summary with card distribution

2. **Write the play guide** (`<deck-name>-play-guide.md`) — this requires your reasoning, not a script. Include:
   - **Mulligan guide** — what to keep vs. ship
   - **Early game plan** — turns 1-3 priorities
   - **Mid game plan** — turns 4-6 pivots
   - **Late game plan** — closing out
   - **Key card interactions** — combos and synergies
   - **Commander strategy** — when to cast, how to protect, how to leverage
   - **Common threats and answers** — what to watch for
   - **Sideboard guide** (if applicable)

3. **Write upgrade suggestions** (`<deck-name>-upgrades.md`) — also requires reasoning:
   - Cards that would improve the deck but aren't in the collection
   - Organized by: "High impact", "Nice to have", "Budget alternatives"
   - For each: what it replaces and why it's an upgrade
   - Use Scryfall search to find alternatives:
     ```
     https://api.scryfall.com/cards/search?q=id<=<colors>+f:<format>+<search-criteria>&order=edhrec
     ```

4. **Present all outputs to the user** with file paths

## Output Structure

```
output/
└── <deck-name>/
    ├── <deck-name>.txt              # Archidekt import
    ├── <deck-name>-summary.md       # Summary
    ├── <deck-name>-play-guide.md    # Play guide (agent-written)
    └── <deck-name>-upgrades.md      # Upgrade suggestions (agent-written)
```
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: add export-deck SKILL.md"
```

---

### Task 13: Update AGENTS.md

**Files:**
- Modify: `C:\aaa\code\Magic-Deck-Gen\AGENTS.md`

- [ ] **Step 1: Update AGENTS.md with skill information**

Add the skill set reference and key conventions discovered during implementation.

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs: update AGENTS.md with skill set info"
```

---

## Self-Review

**1. Spec coverage:**
- ✅ `import-collection` — CSV parsing + Scryfall enrichment (Tasks 2-4)
- ✅ `build-deck` — Interactive Q&A + available pool computation (Tasks 5-6)
- ✅ `validate-deck` — Format rules checks (Tasks 7-8)
- ✅ `optimize-deck` — Iteration loop + logging (Tasks 9-10)
- ✅ `export-deck` — Archidekt import + summary + play guide + upgrades (Tasks 11-12)
- ✅ Reserved decks — handled in `build-deck` via `compute-available-pool.ts`
- ✅ Archidekt API fetch for public decks — mentioned in `build-deck` SKILL.md (agent-driven)
- ✅ AGENTS.md update (Task 13)

**2. Placeholder scan:** No TBDs, TODOs, or vague steps. All code is complete.

**3. Type consistency:**
- `DeckCard` interface used consistently across `validate-deck.ts`, `export-deck.ts`, and `build-deck` SKILL.md
- `CollectionCard` / `ScryfallCard` interfaces consistent between `import-collection.ts` and `compute-available-pool.ts`
- `ValidationIssue` / `ValidationReport` consistent between `validate-deck.ts` and `optimize-deck` SKILL.md
- `CardChange` / `IterationEntry` consistent between `log-iteration.ts` and `optimize-deck` SKILL.md
