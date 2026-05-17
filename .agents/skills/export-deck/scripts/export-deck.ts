#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

// ── Types ──────────────────────────────────────────────────────────────────

interface DeckCard {
  name: string;
  quantity: number;
  category: string;
  scryfallId?: string;
}

interface DeckMetadata {
  format: string;
  strategy: string;
  commander: string;
  colors: string[];
  createdAt: string;
}

interface Deck {
  metadata: DeckMetadata;
  mainboard: DeckCard[];
  maybeboard: DeckCard[];
  reservedDecks?: string[];
}

interface CollectionCard {
  name: string;
  quantity: number;
  set?: string;
  collectorNumber?: string;
  manaCost?: string;
  type?: string;
  cmc?: number;
  [key: string]: unknown;
}

interface Collection {
  cards: CollectionCard[];
  [key: string]: unknown;
}

type ExportFormat = "archidekt" | "text" | "summary" | "all";

// ── Helpers ────────────────────────────────────────────────────────────────

function parseArgs(args: string[]): {
  deckPath: string;
  collectionPath: string;
  format: ExportFormat;
  outputDir: string;
} {
  const positional: string[] = [];
  let format: ExportFormat = "all";
  let outputDir = process.cwd();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--format" && args[i + 1]) {
      format = args[i + 1] as ExportFormat;
      i++;
    } else if (arg === "--output-dir" && args[i + 1]) {
      outputDir = args[i + 1];
      i++;
    } else if (!arg.startsWith("--")) {
      positional.push(arg);
    }
  }

  if (positional.length < 2) {
    console.error(
      "Usage: npx tsx export-deck.ts <deck.json> <collection.json> [options]\n" +
        "Options:\n" +
        "  --format <archidekt|text|summary|all>  Export format (default: all)\n" +
        "  --output-dir <path>                    Output directory (default: cwd)"
    );
    process.exit(1);
  }

  return {
    deckPath: resolve(positional[0]),
    collectionPath: resolve(positional[1]),
    format,
    outputDir: resolve(outputDir),
  };
}

function loadJson<T>(path: string): T {
  if (!existsSync(path)) {
    console.error(`File not found: ${path}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Build a lookup map from collection cards by name (lowercased). */
function buildCollectionLookup(
  collection: Collection
): Map<string, CollectionCard> {
  const map = new Map<string, CollectionCard>();
  for (const card of collection.cards) {
    map.set(card.name.toLowerCase(), card);
  }
  return map;
}

/** Get the deck name from commander or strategy. */
function deckName(deck: Deck): string {
  return slugify(deck.metadata.commander || deck.metadata.strategy || "deck");
}

// ── Archidekt CSV ──────────────────────────────────────────────────────────

function exportArchidektCsv(
  deck: Deck,
  lookup: Map<string, CollectionCard>
): string {
  const header = "Quantity,Card Name,Set,Collector Number,Category";
  const rows: string[] = [header];

  for (const card of deck.mainboard) {
    const details = lookup.get(card.name.toLowerCase());
    const set = details?.set ?? "";
    const collectorNumber = details?.collectorNumber ?? "";
    // Escape card names that contain commas
    const cardName = card.name.includes(",") ? `"${card.name}"` : card.name;
    rows.push(
      `${card.quantity},${cardName},${set},${collectorNumber},${card.category}`
    );
  }

  return rows.join("\n");
}

// ── Plain Text Deck List ───────────────────────────────────────────────────

function exportPlainText(
  deck: Deck,
  lookup: Map<string, CollectionCard>
): string {
  const lines: string[] = [];

  // Commander line
  const commander = deck.mainboard.find((c) => c.category === "commander");
  if (commander) {
    lines.push(`Commander: ${commander.name}`);
    lines.push("");
  }

  // Group by category (excluding commander)
  const categoryOrder = [
    "creatures",
    "ramp",
    "draw",
    "removal",
    "board-wipes",
    "tutors",
    "protection",
    "recursion",
    "enchantments",
    "artifacts",
    "lands",
    "other",
  ];

  const grouped = new Map<string, DeckCard[]>();
  for (const card of deck.mainboard) {
    if (card.category === "commander") continue;
    const cat = card.category || "other";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(card);
  }

  // Sort categories: known order first, then alphabetical
  const sortedCategories = [...grouped.keys()].sort((a, b) => {
    const ai = categoryOrder.indexOf(a);
    const bi = categoryOrder.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  for (const category of sortedCategories) {
    const cards = grouped.get(category)!;
    const count = cards.reduce((sum, c) => sum + c.quantity, 0);
    const label = category.charAt(0).toUpperCase() + category.slice(1);
    lines.push(`// ${label} (${count})`);
    for (const card of cards) {
      lines.push(`${card.quantity}x ${card.name}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

// ── Markdown Summary ───────────────────────────────────────────────────────

function colorSymbolToName(colors: string[]): string {
  const map: Record<string, string> = {
    W: "White",
    U: "Blue",
    B: "Black",
    R: "Red",
    G: "Green",
  };
  return colors.map((c) => map[c] ?? c).join("/");
}

function exportSummary(
  deck: Deck,
  lookup: Map<string, CollectionCard>
): string {
  const lines: string[] = [];
  const meta = deck.metadata;

  // Title
  lines.push(`# Deck: ${meta.commander}`);
  lines.push("");

  // Overview
  const colorNames = colorSymbolToName(meta.colors);
  lines.push(
    `**Format:** ${meta.format.charAt(0).toUpperCase() + meta.format.slice(1)} | **Strategy:** ${meta.strategy} | **Colors:** ${colorNames}`
  );
  lines.push("");

  // ── Deck Stats ──
  lines.push("## Deck Stats");

  const totalCards = deck.mainboard.reduce((s, c) => s + c.quantity, 0);

  // Count by type line
  const typeCounts: Record<string, number> = {};
  let totalCmc = 0;
  let cmcCardCount = 0;

  for (const card of deck.mainboard) {
    const details = lookup.get(card.name.toLowerCase());
    const typeLine = details?.type ?? "";
    const cmc = details?.cmc ?? 0;

    // Classify by type
    let typeCategory = "Other";
    const t = typeLine.toLowerCase();
    if (t.includes("creature")) typeCategory = "Creatures";
    else if (t.includes("instant")) typeCategory = "Instants";
    else if (t.includes("sorcery")) typeCategory = "Sorceries";
    else if (t.includes("enchantment")) typeCategory = "Enchantments";
    else if (t.includes("artifact")) typeCategory = "Artifacts";
    else if (t.includes("land")) typeCategory = "Lands";
    else if (t.includes("planeswalker")) typeCategory = "Planeswalkers";

    typeCounts[typeCategory] = (typeCounts[typeCategory] ?? 0) + card.quantity;

    // CMC (skip lands)
    if (!t.includes("land")) {
      totalCmc += cmc * card.quantity;
      cmcCardCount += card.quantity;
    }
  }

  const avgCmc = cmcCardCount > 0 ? (totalCmc / cmcCardCount).toFixed(1) : "0.0";

  lines.push(`- Total cards: ${totalCards}`);

  const statParts = Object.entries(typeCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([type, count]) => `${type}: ${count}`)
    .join(" | ");
  lines.push(`- ${statParts}`);
  lines.push(`- Average CMC: ${avgCmc}`);
  lines.push("");

  // ── Mana Curve ──
  lines.push("## Mana Curve");

  const curve: Record<string, number> = {};
  for (const card of deck.mainboard) {
    const details = lookup.get(card.name.toLowerCase());
    const t = (details?.type ?? "").toLowerCase();
    if (t.includes("land")) continue; // skip lands

    const cmc = details?.cmc ?? 0;
    let bucket: string;
    if (cmc === 0) bucket = "0";
    else if (cmc === 1) bucket = "1";
    else if (cmc === 2) bucket = "2";
    else if (cmc === 3) bucket = "3";
    else if (cmc === 4) bucket = "4";
    else if (cmc === 5) bucket = "5";
    else bucket = "6+";

    curve[bucket] = (curve[bucket] ?? 0) + card.quantity;
  }

  lines.push("| CMC | Count |");
  lines.push("|-----|-------|");
  const buckets = ["0", "1", "2", "3", "4", "5", "6+"];
  for (const b of buckets) {
    lines.push(`| ${b}   | ${curve[b] ?? 0}     |`);
  }
  lines.push("");

  // ── Card List ──
  lines.push("## Card List");
  lines.push("");

  // Group by category
  const categoryOrder = [
    "commander",
    "creatures",
    "ramp",
    "draw",
    "removal",
    "board-wipes",
    "tutors",
    "protection",
    "recursion",
    "enchantments",
    "artifacts",
    "lands",
    "other",
  ];

  const grouped = new Map<string, DeckCard[]>();
  for (const card of deck.mainboard) {
    const cat = card.category || "other";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(card);
  }

  const sortedCategories = [...grouped.keys()].sort((a, b) => {
    const ai = categoryOrder.indexOf(a);
    const bi = categoryOrder.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });

  for (const category of sortedCategories) {
    const cards = grouped.get(category)!;
    const count = cards.reduce((sum, c) => sum + c.quantity, 0);
    const label = category.charAt(0).toUpperCase() + category.slice(1);
    lines.push(`### ${label} (${count})`);
    lines.push("");
    for (const card of cards) {
      lines.push(`- ${card.quantity}x ${card.name}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

// ── Main ───────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const { deckPath, collectionPath, format, outputDir } = parseArgs(args);

  // Load inputs
  const deck: Deck = loadJson<Deck>(deckPath);
  const collection: Collection = loadJson<Collection>(collectionPath);
  const lookup = buildCollectionLookup(collection);

  // Ensure output directory exists
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const name = deckName(deck);

  const formats: { key: ExportFormat; ext: string; fn: (d: Deck, l: Map<string, CollectionCard>) => string }[] = [
    { key: "archidekt", ext: "archidekt.csv", fn: exportArchidektCsv },
    { key: "text", ext: "decklist.txt", fn: exportPlainText },
    { key: "summary", ext: "summary.md", fn: exportSummary },
  ];

  const formatsToExport = format === "all"
    ? formats
    : formats.filter((f) => f.key === format);

  if (formatsToExport.length === 0) {
    console.error(`Unknown format: ${format}. Use archidekt, text, summary, or all.`);
    process.exit(1);
  }

  for (const fmt of formatsToExport) {
    const filename = `${name}-${fmt.ext}`;
    const filepath = resolve(outputDir, filename);
    const content = fmt.fn(deck, lookup);
    writeFileSync(filepath, content, "utf-8");
    console.log(`Exported: ${filepath}`);
  }
}

main();
