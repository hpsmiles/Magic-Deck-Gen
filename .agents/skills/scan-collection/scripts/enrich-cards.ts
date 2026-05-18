import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────

interface DetectedCard {
  name: string;
  quantity: number;
  confidence: "high" | "medium" | "low";
  sourcePhoto: string;
  gridPosition?: string;
  setName?: string;
  collectorNumber?: string;
  validatedName?: string;
  validationStatus?: "confirmed" | "corrected" | "flagged";
}

interface RawCardsOutput {
  metadata: {
    source: string;
    scanDate: string;
    photoDirectory: string;
    croppedDirectory?: string;
    cardsScanned?: number;
    photosProcessed?: number;
    photosSkipped?: number;
    totalCardsDetected: number;
    highConfidenceCards: number;
    uncertainCards: number;
    validatedCards?: number;
    correctedCards?: number;
    flaggedCards?: number;
  };
  cards: DetectedCard[];
  warnings: (DetectedCard | string)[];
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

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Scryfall Enrichment ────────────────────────────────────────────────────

async function scryfallRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${SCRYFALL_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
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

function mapScryfallCard(apiCard: ScryfallApiCard, name: string, quantity: number): ScryfallCard {
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
    name,
    quantity,
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
    collectorNumber: apiCard.collector_number,
  };
}

function makePartialCard(name: string, quantity: number): ScryfallCard {
  return {
    name,
    quantity,
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
  };
}

async function enrichCards(
  detectedCards: DetectedCard[],
  warnings: string[]
): Promise<{ cards: ScryfallCard[]; enrichedCount: number; notFoundCount: number }> {
  const result: ScryfallCard[] = [];
  let enrichedCount = 0;
  let notFoundCount = 0;

  // Build lookup from name → { quantity, setName, collectorNumber }
  const nameToInfo = new Map<string, { quantity: number; setName?: string; collectorNumber?: string }>();
  for (const card of detectedCards) {
    const existing = nameToInfo.get(card.name);
    if (existing) {
      existing.quantity += card.quantity;
    } else {
      nameToInfo.set(card.name, {
        quantity: card.quantity,
        setName: card.setName,
        collectorNumber: card.collectorNumber,
      });
    }
  }

  const entries = Array.from(nameToInfo.entries());

  // Process in batches of 75
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const identifiers: ScryfallIdentifier[] = batch.map(([name, _info]) => {
      // Use name-only lookup — the vision model's setName/collectorNumber
      // are unreliable and cause Scryfall batch lookups to fail
      return { name };
    });

    if (i > 0) {
      await sleep(RATE_LIMIT_MS);
    }

    let batchResponse: ScryfallBatchResponse;
    try {
      batchResponse = await fetchBatch(identifiers);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Batch request failed: ${msg}`);
      for (const [name, info] of batch) {
        result.push(makePartialCard(name, info.quantity));
        notFoundCount++;
      }
      continue;
    }

    // Map found cards — track which detected names were resolved
    const foundDetectedNames = new Set<string>();
    for (const apiCard of batchResponse.data || []) {
      // Try to match Scryfall result back to the detected name that requested it
      const detectedName = batch.find(([n]) => n.toLowerCase() === apiCard.name.toLowerCase())?.[0] ?? apiCard.name;
      const quantity = nameToInfo.get(detectedName)?.quantity ?? nameToInfo.get(apiCard.name)?.quantity ?? 1;
      result.push(mapScryfallCard(apiCard, apiCard.name, quantity));
      foundDetectedNames.add(detectedName);
      // Also mark by canonical name in case it differs
      if (detectedName.toLowerCase() !== apiCard.name.toLowerCase()) {
        foundDetectedNames.add(apiCard.name);
      }
      enrichedCount++;
    }

    // Handle not-found cards with fuzzy fallback
    const notFoundInBatch = batch.filter(([name]) => !foundDetectedNames.has(name));
    for (const [name, info] of notFoundInBatch) {
      await sleep(RATE_LIMIT_MS);

      const fuzzyResult = await fetchNamed(name);
      if (fuzzyResult) {
        result.push(mapScryfallCard(fuzzyResult, fuzzyResult.name, info.quantity));
        enrichedCount++;
      } else {
        warnings.push(`Card not found on Scryfall: "${name}"`);
        result.push(makePartialCard(name, info.quantity));
        notFoundCount++;
      }
    }

    const progress = Math.min(i + BATCH_SIZE, entries.length);
    console.error(`Processed ${progress}/${entries.length} unique cards...`);
  }

  return { cards: result, enrichedCount, notFoundCount };
}

// ── Merge ──────────────────────────────────────────────────────────────────

function mergeCollections(
  existing: CollectionOutput,
  incoming: CollectionOutput
): CollectionOutput {
  const cardMap = new Map<string, ScryfallCard>();

  // Add existing cards
  for (const card of existing.cards) {
    cardMap.set(card.name.toLowerCase(), { ...card });
  }

  // Merge incoming cards
  for (const card of incoming.cards) {
    const key = card.name.toLowerCase();
    const existingCard = cardMap.get(key);
    if (existingCard) {
      existingCard.quantity += card.quantity;
    } else {
      cardMap.set(key, { ...card });
    }
  }

  const mergedCards = Array.from(cardMap.values());
  const totalUniqueCards = mergedCards.length;
  const totalCards = mergedCards.reduce((sum, c) => sum + c.quantity, 0);

  return {
    metadata: {
      source: `merged:${existing.metadata.source}+${incoming.metadata.source}`,
      importDate: new Date().toISOString(),
      totalUniqueCards,
      totalCards,
      enrichedCount: mergedCards.filter((c) => c.scryfallId !== "").length,
      notFoundCount: mergedCards.filter((c) => c.scryfallId === "").length,
    },
    cards: mergedCards,
    warnings: [...existing.warnings, ...incoming.warnings],
  };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: npx tsx enrich-cards.ts <raw-cards-path> <output-path> [--merge]");
    process.exit(1);
  }

  const rawCardsPath = resolve(args[0]);
  const outputPath = resolve(args[1]);
  const shouldMerge = args.includes("--merge");

  // Read raw-cards.json
  console.error(`Reading detected cards from: ${rawCardsPath}`);
  const rawContent = readFileSync(rawCardsPath, "utf-8");
  const rawData: RawCardsOutput = JSON.parse(rawContent);

  if (!rawData.cards || rawData.cards.length === 0) {
    console.error("Error: No high-confidence cards found in raw-cards.json");
    process.exit(1);
  }

  console.error(`Found ${rawData.metadata.highConfidenceCards} unique cards to enrich`);

  // Carry forward all warnings from scan — convert DetectedCard warnings to descriptive strings
  const warnings: string[] = rawData.warnings.map((w) => {
    if (typeof w === "string") return w;
    return `Uncertain card: ${w.name} (qty ${w.quantity}, confidence: ${w.confidence}, photo: ${w.sourcePhoto})`;
  });

  // Enrich with Scryfall
  const { cards, enrichedCount, notFoundCount } = await enrichCards(rawData.cards, warnings);

  const totalCards = cards.reduce((sum, c) => sum + c.quantity, 0);

  // Build output
  const output: CollectionOutput = {
    metadata: {
      source: "photo-scan",
      importDate: new Date().toISOString(),
      totalUniqueCards: cards.length,
      totalCards,
      enrichedCount,
      notFoundCount,
    },
    cards,
    warnings,
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf-8");
  console.error(`\nEnrichment complete! ${enrichedCount} cards enriched, ${notFoundCount} not found.`);
  console.error(`Output written to: ${outputPath}`);

  // Optional merge
  if (shouldMerge) {
    // Resolve collection.json relative to the output path's directory (typically project root)
    const outputDir = resolve(outputPath, "..");
    const collectionPath = resolve(outputDir, "collection.json");
    if (!existsSync(collectionPath)) {
      console.error(`\nNo collection.json found at ${collectionPath} — skipping merge.`);
      return;
    }

    // Backup
    const backupPath = resolve(outputDir, "collection.json.bak");
    copyFileSync(collectionPath, backupPath);
    console.error(`Backed up collection.json to collection.json.bak`);

    const existingContent = readFileSync(collectionPath, "utf-8");
    const existing: CollectionOutput = JSON.parse(existingContent);

    const merged = mergeCollections(existing, output);
    writeFileSync(collectionPath, JSON.stringify(merged, null, 2), "utf-8");

    console.error(`\nMerged into collection.json:`);
    console.error(`  Before: ${existing.metadata.totalUniqueCards} unique (${existing.metadata.totalCards} total)`);
    console.error(`  After:  ${merged.metadata.totalUniqueCards} unique (${merged.metadata.totalCards} total)`);
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
