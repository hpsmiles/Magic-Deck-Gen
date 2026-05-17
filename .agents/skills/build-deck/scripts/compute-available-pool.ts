import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { parse } from "csv-parse/sync";

// ── Types ──────────────────────────────────────────────────────────────────

interface CollectionCard {
  name: string;
  quantity: number;
  scryfallId?: string;
  oracleId?: string;
  manaCost?: string;
  cmc?: number;
  typeLine?: string;
  colorIdentity?: string[];
  rulesText?: string;
  legalities?: Record<string, string>;
  imageUri?: string;
  keywords?: string[];
  producedMana?: string[];
  edhrecRank?: number;
  [key: string]: unknown;
}

interface Collection {
  metadata: {
    source: string;
    importDate: string;
    totalUniqueCards: number;
    totalCards: number;
    enrichedCount?: number;
    notFoundCount?: number;
    [key: string]: unknown;
  };
  cards: CollectionCard[];
  warnings: string[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

function die(msg: string): never {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

/** Detect the card-name column from CSV headers. */
function findNameColumn(headers: string[]): string | null {
  const candidates = ["Card", "Card Name", "Name", "card", "card name", "name"];
  for (const c of candidates) {
    const idx = headers.indexOf(c);
    if (idx !== -1) return headers[idx];
  }
  return null;
}

/** Detect the quantity column from CSV headers. */
function findQuantityColumn(headers: string[]): string | null {
  const candidates = ["Quantity", "Qty", "quantity", "qty"];
  for (const c of candidates) {
    const idx = headers.indexOf(c);
    if (idx !== -1) return headers[idx];
  }
  return null;
}

// ── Core logic ─────────────────────────────────────────────────────────────

function loadCollection(path: string): Collection {
  if (!resolve(path).endsWith(".json")) {
    die("Collection file must be a .json file");
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as Collection;
    if (!data.cards || !Array.isArray(data.cards)) {
      die("Collection JSON must contain a 'cards' array");
    }
    return data;
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      die(`Invalid JSON in collection file: ${err.message}`);
    }
    die(`Cannot read collection file: ${path}`);
  }
}

/**
 * Read all CSV files in a directory and return a map of
 * lowercase card name → total reserved quantity.
 */
function buildReservedMap(dir: string): Map<string, number> {
  const reserved = new Map<string, number>();

  let files: string[];
  try {
    files = readdirSync(dir).filter((f) =>
      f.toLowerCase().endsWith(".csv")
    );
  } catch {
    die(`Cannot read reserved-decks directory: ${dir}`);
  }

  if (files.length === 0) {
    console.warn(`Warning: No CSV files found in ${dir}`);
    return reserved;
  }

  for (const file of files) {
    const filePath = resolve(dir, file);
    const raw = readFileSync(filePath, "utf-8");

    const records: Record<string, string>[] = parse(raw, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    if (records.length === 0) continue;

    const headers = Object.keys(records[0]);
    const nameCol = findNameColumn(headers);
    const qtyCol = findQuantityColumn(headers);

    if (!nameCol) {
      die(
        `Could not detect card-name column in ${file}. ` +
          `Expected one of: Card, Card Name, Name. ` +
          `Found headers: ${headers.join(", ")}`
      );
    }
    if (!qtyCol) {
      die(
        `Could not detect quantity column in ${file}. ` +
          `Expected one of: Quantity, Qty. ` +
          `Found headers: ${headers.join(", ")}`
      );
    }

    for (const row of records) {
      const name = (row[nameCol] ?? "").trim();
      const qty = parseInt(row[qtyCol] ?? "1", 10);
      if (!name || isNaN(qty) || qty <= 0) continue;

      const key = name.toLowerCase();
      reserved.set(key, (reserved.get(key) ?? 0) + qty);
    }

    console.log(`  Loaded ${records.length} entries from ${basename(file)}`);
  }

  return reserved;
}

function computeAvailablePool(
  collection: Collection,
  reserved: Map<string, number>
): Collection {
  const availableCards: CollectionCard[] = [];
  let totalAvailable = 0;

  for (const card of collection.cards) {
    const key = card.name.toLowerCase();
    const reservedQty = reserved.get(key) ?? 0;
    const availableQty = card.quantity - reservedQty;

    if (availableQty > 0) {
      availableCards.push({ ...card, quantity: availableQty });
      totalAvailable += availableQty;
    }
    // If availableQty <= 0, card is fully reserved — exclude it
  }

  return {
    metadata: {
      ...collection.metadata,
      totalUniqueCards: availableCards.length,
      totalCards: totalAvailable,
      reservedDecksCount: reserved.size > 0 ? undefined : undefined,
    },
    cards: availableCards,
    warnings: [...collection.warnings],
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error(
      "Usage: npx tsx compute-available-pool.ts <collection.json> [reserved-decks-dir] [output-path]"
    );
    process.exit(1);
  }

  const collectionPath = resolve(args[0]);
  const reservedDir = args[1] ? resolve(args[1]) : null;
  const outputPath = args[2] ? resolve(args[2]) : resolve("available-pool.json");

  console.log(`Loading collection from ${collectionPath}`);
  const collection = loadCollection(collectionPath);
  console.log(
    `  Collection: ${collection.cards.length} unique cards, ${collection.metadata.totalCards} total`
  );

  let reserved: Map<string, number>;
  if (reservedDir) {
    console.log(`\nLoading reserved decks from ${reservedDir}`);
    reserved = buildReservedMap(reservedDir);
    console.log(`  Total reserved card entries: ${reserved.size}`);
  } else {
    console.log("\nNo reserved decks directory provided — using full collection");
    reserved = new Map();
  }

  const availablePool = computeAvailablePool(collection, reserved);

  console.log(
    `\nAvailable pool: ${availablePool.cards.length} unique cards, ${availablePool.metadata.totalCards} total`
  );

  writeFileSync(outputPath, JSON.stringify(availablePool, null, 2), "utf-8");
  console.log(`\nWrote available pool to ${outputPath}`);
}

main();
