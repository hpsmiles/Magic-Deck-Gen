import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "csv-parse/sync";

// ── Types ──────────────────────────────────────────────────────────────────

interface CsvRow {
  [header: string]: string;
}

interface ParsedCard {
  name: string;
  quantity: number;
  set?: string;
  collectorNumber?: string;
  foil?: string;
  condition?: string;
  language?: string;
}

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

interface CollectionOutput {
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

interface ScryfallIdentifier {
  name?: string;
  set?: string;
  collector_number?: string;
}

interface ScryfallBatchResponse {
  object: string;
  data: ScryfallApiCard[];
  not_found: { name: string }[];
}

interface ScryfallApiCard {
  object: string;
  id: string;
  oracle_id: string;
  name: string;
  mana_cost?: string;
  cmc: number;
  type_line?: string;
  color_identity: string[];
  oracle_text?: string;
  legalities: Record<string, string>;
  image_uris?: { [size: string]: string };
  card_faces?: {
    mana_cost?: string;
    type_line?: string;
    oracle_text?: string;
    image_uris?: { [size: string]: string };
  }[];
  power?: string;
  toughness?: string;
  keywords: string[];
  produced_mana?: string[];
  edhrec_rank?: number;
  set_name?: string;
  collector_number?: string;
}

// ── Constants ──────────────────────────────────────────────────────────────

const SCRYFALL_BASE = "https://api.scryfall.com";
const BATCH_SIZE = 75;
const RATE_LIMIT_MS = 550;

const CARD_NAME_HEADERS = ["card", "card name", "name"];
const QUANTITY_HEADERS = ["quantity", "qty"];
const SET_HEADERS = ["set", "set name", "edition"];
const COLLECTOR_NUMBER_HEADERS = ["collector number"];
const FOIL_HEADERS = ["foil", "foil/variant"];
const CONDITION_HEADERS = ["condition"];
const LANGUAGE_HEADERS = ["language"];

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findHeader(headers: string[], candidates: string[]): string | undefined {
  const lowerHeaders = headers.map((h) => h.toLowerCase().trim());
  for (const candidate of candidates) {
    const idx = lowerHeaders.indexOf(candidate.toLowerCase());
    if (idx !== -1) return headers[idx];
  }
  return undefined;
}

function parseQuantity(value: string | undefined, warnings: string[], cardName: string): number {
  if (value === undefined || value.trim() === "") return 1;
  const num = parseInt(value.trim(), 10);
  if (isNaN(num) || num < 1) {
    warnings.push(`Invalid quantity "${value}" for "${cardName}", defaulting to 1`);
    return 1;
  }
  return num;
}

// ── CSV Parsing ────────────────────────────────────────────────────────────

function parseCsv(csvPath: string): { cards: Map<string, ParsedCard>; warnings: string[] } {
  const warnings: string[] = [];
  const raw = readFileSync(csvPath, "utf-8");

  const records: CsvRow[] = parse(raw, {
    columns: true,
    relax_column_count: true,
    skip_empty_lines: true,
    bom: true,
  });

  if (records.length === 0) {
    throw new Error("CSV file is empty or has no data rows");
  }

  const headers = Object.keys(records[0]);
  const cardNameHeader = findHeader(headers, CARD_NAME_HEADERS);
  if (!cardNameHeader) {
    throw new Error(
      `CSV must have a Card column. Found headers: ${headers.join(", ")}. Expected one of: ${CARD_NAME_HEADERS.join(", ")}`
    );
  }

  const quantityHeader = findHeader(headers, QUANTITY_HEADERS);
  const setHeader = findHeader(headers, SET_HEADERS);
  const collectorNumberHeader = findHeader(headers, COLLECTOR_NUMBER_HEADERS);
  const foilHeader = findHeader(headers, FOIL_HEADERS);
  const conditionHeader = findHeader(headers, CONDITION_HEADERS);
  const languageHeader = findHeader(headers, LANGUAGE_HEADERS);

  const cards = new Map<string, ParsedCard>();

  for (const row of records) {
    const name = (row[cardNameHeader] || "").trim();
    if (!name) continue;

    const quantity = parseQuantity(
      quantityHeader ? row[quantityHeader] : undefined,
      warnings,
      name
    );

    const existing = cards.get(name);
    if (existing) {
      existing.quantity += quantity;
    } else {
      cards.set(name, {
        name,
        quantity,
        set: setHeader ? (row[setHeader] || "").trim() || undefined : undefined,
        collectorNumber: collectorNumberHeader ? (row[collectorNumberHeader] || "").trim() || undefined : undefined,
        foil: foilHeader ? (row[foilHeader] || "").trim() || undefined : undefined,
        condition: conditionHeader ? (row[conditionHeader] || "").trim() || undefined : undefined,
        language: languageHeader ? (row[languageHeader] || "").trim() || undefined : undefined,
      });
    }
  }

  return { cards, warnings };
}

// ── Scryfall Enrichment ────────────────────────────────────────────────────

async function scryfallRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${SCRYFALL_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "MagicDeckGen/1.0",
      ...(options?.headers || {}),
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Scryfall API error ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

async function fetchBatch(identifiers: ScryfallIdentifier[]): Promise<ScryfallBatchResponse> {
  return scryfallRequest<ScryfallBatchResponse>("/cards/collection", {
    method: "POST",
    body: JSON.stringify({ identifiers }),
  });
}

async function fetchNamed(name: string): Promise<ScryfallApiCard | null> {
  try {
    const encoded = encodeURIComponent(name);
    return await scryfallRequest<ScryfallApiCard>(`/cards/named?fuzzy=${encoded}`);
  } catch {
    return null;
  }
}

function mapScryfallCard(
  apiCard: ScryfallApiCard,
  parsed: ParsedCard
): ScryfallCard {
  const hasFaces = apiCard.card_faces && apiCard.card_faces.length > 0;
  const face0 = hasFaces ? apiCard.card_faces![0] : null;

  const manaCost = face0?.mana_cost ?? apiCard.mana_cost ?? "";
  const typeLine = face0?.type_line ?? apiCard.type_line ?? "";
  const oracleText = face0?.oracle_text ?? apiCard.oracle_text ?? "";

  const imageUri =
    face0?.image_uris?.normal ??
    apiCard.image_uris?.normal ??
    face0?.image_uris?.large ??
    apiCard.image_uris?.large ??
    "";

  return {
    name: parsed.name,
    quantity: parsed.quantity,
    scryfallId: apiCard.id,
    oracleId: apiCard.oracle_id,
    manaCost,
    cmc: apiCard.cmc,
    typeLine,
    colorIdentity: apiCard.color_identity,
    rulesText: oracleText,
    legalities: apiCard.legalities,
    imageUri,
    power: apiCard.power,
    toughness: apiCard.toughness,
    keywords: apiCard.keywords,
    producedMana: apiCard.produced_mana,
    edhrecRank: apiCard.edhrec_rank,
    setName: apiCard.set_name,
    collectorNumber: parsed.collectorNumber ?? apiCard.collector_number,
    foil: parsed.foil,
    condition: parsed.condition,
    language: parsed.language,
  };
}

function makePartialCard(parsed: ParsedCard): ScryfallCard {
  return {
    name: parsed.name,
    quantity: parsed.quantity,
    scryfallId: "",
    oracleId: "",
    manaCost: "",
    cmc: 0,
    typeLine: "",
    colorIdentity: [],
    rulesText: "",
    legalities: {},
    imageUri: "",
    keywords: [],
    collectorNumber: parsed.collectorNumber,
    foil: parsed.foil,
    condition: parsed.condition,
    language: parsed.language,
  };
}

async function enrichCards(
  parsedCards: Map<string, ParsedCard>,
  warnings: string[]
): Promise<{ cards: ScryfallCard[]; enrichedCount: number; notFoundCount: number }> {
  const entries = Array.from(parsedCards.values());
  const result: ScryfallCard[] = [];
  let enrichedCount = 0;
  let notFoundCount = 0;

  // Build lookup from name → parsed card
  const parsedByName = new Map<string, ParsedCard>();
  for (const p of entries) {
    parsedByName.set(p.name, p);
  }

  // Process in batches of 75
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const identifiers: ScryfallIdentifier[] = batch.map((c) => ({
      name: c.name,
      ...(c.set ? { set: c.set.toLowerCase() } : {}),
      ...(c.collectorNumber ? { collector_number: c.collectorNumber } : {}),
    }));

    if (i > 0) {
      await sleep(RATE_LIMIT_MS);
    }

    let batchResponse: ScryfallBatchResponse;
    try {
      batchResponse = await fetchBatch(identifiers);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Batch request failed: ${msg}`);
      // Add all cards in this batch as partial
      for (const card of batch) {
        result.push(makePartialCard(card));
        notFoundCount++;
      }
      continue;
    }

    // Map found cards
    const foundNames = new Set<string>();
    for (const apiCard of batchResponse.data || []) {
      const parsed = parsedByName.get(apiCard.name);
      if (parsed) {
        result.push(mapScryfallCard(apiCard, parsed));
        foundNames.add(parsed.name);
        enrichedCount++;
      }
    }

    // Handle not-found cards with fuzzy fallback
    const notFoundInBatch = batch.filter((c) => !foundNames.has(c.name));
    for (const card of notFoundInBatch) {
      await sleep(RATE_LIMIT_MS);

      const fuzzyResult = await fetchNamed(card.name);
      if (fuzzyResult) {
        result.push(mapScryfallCard(fuzzyResult, card));
        enrichedCount++;
      } else {
        warnings.push(`Card not found on Scryfall: "${card.name}"`);
        result.push(makePartialCard(card));
        notFoundCount++;
      }
    }

    const progress = Math.min(i + BATCH_SIZE, entries.length);
    console.error(`Processed ${progress}/${entries.length} unique cards...`);
  }

  return { cards: result, enrichedCount, notFoundCount };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: npx tsx import-collection.ts <csv-path> [output-path]");
    process.exit(1);
  }

  const csvPath = resolve(args[0]);
  const outputPath = resolve(args[1] || "collection.json");

  console.error(`Importing collection from: ${csvPath}`);
  console.error(`Output will be written to: ${outputPath}`);

  // Parse CSV
  const { cards: parsedCards, warnings: parseWarnings } = parseCsv(csvPath);

  const totalUniqueCards = parsedCards.size;
  const totalCards = Array.from(parsedCards.values()).reduce((sum, c) => sum + c.quantity, 0);

  console.error(`Found ${totalUniqueCards} unique cards (${totalCards} total) in CSV`);

  // Enrich with Scryfall
  const { cards, enrichedCount, notFoundCount } = await enrichCards(parsedCards, parseWarnings);

  // Build output
  const output: CollectionOutput = {
    metadata: {
      source: "archidekt-csv",
      importDate: new Date().toISOString(),
      totalUniqueCards,
      totalCards,
      enrichedCount,
      notFoundCount,
    },
    cards,
    warnings: parseWarnings,
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf-8");

  console.error(`\nDone! ${enrichedCount} cards enriched, ${notFoundCount} not found.`);
  if (parseWarnings.length > 0) {
    console.error(`\nWarnings (${parseWarnings.length}):`);
    for (const w of parseWarnings) {
      console.error(`  - ${w}`);
    }
  }
  console.error(`\nOutput written to: ${outputPath}`);
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
