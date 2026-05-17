#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Types ────────────────────────────────────────────────────────────────────

interface DeckCard {
  name: string;
  quantity: number;
  category?: string;
  scryfallId?: string;
}

interface DeckJson {
  metadata: {
    format: string;
    strategy: string;
    commander?: string;
    colors?: string[];
    createdAt: string;
  };
  mainboard: DeckCard[];
  maybeboard: DeckCard[];
  reservedDecks?: string[];
}

interface CollectionCard {
  name: string;
  quantity: number;
  scryfallId: string;
  oracleId?: string;
  manaCost?: string;
  cmc: number;
  typeLine: string;
  colorIdentity: string[];
  rulesText?: string;
  legalities: Record<string, string>;
  imageUri?: string;
  keywords?: string[];
  producedMana?: string[];
  edhrecRank?: number;
}

interface CollectionJson {
  metadata: Record<string, unknown>;
  cards: CollectionCard[];
  warnings?: string[];
}

interface ValidationEntry {
  type: string;
  severity: "error" | "warning" | "info";
  message: string;
  cards: string[];
}

interface ManaCurve {
  "0": number;
  "1": number;
  "2": number;
  "3": number;
  "4": number;
  "5": number;
  "6+": number;
}

interface ValidationReport {
  metadata: {
    deckFile: string;
    collectionFile: string;
    format: string;
    validatedAt: string;
  };
  valid: boolean;
  errors: ValidationEntry[];
  warnings: ValidationEntry[];
  manaCurve: ManaCurve;
  summary: {
    totalCards: number;
    uniqueCards: number;
    formatLegal: boolean;
    availableInCollection: boolean;
  };
}

// ── Format rules ─────────────────────────────────────────────────────────────

interface FormatRules {
  minDeckSize: number;
  exactDeckSize?: number;
  maxCopies: number;
  commanderRequired: boolean;
  colorIdentityCheck: boolean;
  sideboardMax: number | null;
}

const FORMAT_RULES: Record<string, FormatRules> = {
  commander: {
    minDeckSize: 100,
    exactDeckSize: 100,
    maxCopies: 1,
    commanderRequired: true,
    colorIdentityCheck: true,
    sideboardMax: null,
  },
  standard: {
    minDeckSize: 60,
    maxCopies: 4,
    commanderRequired: false,
    colorIdentityCheck: false,
    sideboardMax: 15,
  },
  modern: {
    minDeckSize: 60,
    maxCopies: 4,
    commanderRequired: false,
    colorIdentityCheck: false,
    sideboardMax: 15,
  },
  legacy: {
    minDeckSize: 60,
    maxCopies: 4,
    commanderRequired: false,
    colorIdentityCheck: false,
    sideboardMax: 15,
  },
  pioneer: {
    minDeckSize: 60,
    maxCopies: 4,
    commanderRequired: false,
    colorIdentityCheck: false,
    sideboardMax: 15,
  },
};

const BASIC_LAND_NAMES = new Set([
  "Plains",
  "Island",
  "Swamp",
  "Mountain",
  "Forest",
  "Wastes",
  "Snow-Covered Plains",
  "Snow-Covered Island",
  "Snow-Covered Swamp",
  "Snow-Covered Mountain",
  "Snow-Covered Forest",
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

function isBasicLand(name: string): boolean {
  return BASIC_LAND_NAMES.has(name);
}

function loadJson<T>(filePath: string): T {
  const abs = resolve(filePath);
  const raw = readFileSync(abs, "utf-8");
  return JSON.parse(raw) as T;
}

function buildCollectionLookup(
  cards: CollectionCard[]
): Map<string, CollectionCard> {
  const map = new Map<string, CollectionCard>();
  for (const card of cards) {
    map.set(card.name.toLowerCase(), card);
  }
  return map;
}

// ── Validation functions ─────────────────────────────────────────────────────

function validateDeckSize(
  deck: DeckJson,
  rules: FormatRules,
  errors: ValidationEntry[]
): number {
  const totalCards = deck.mainboard.reduce(
    (sum, c) => sum + c.quantity,
    0
  );

  if (rules.exactDeckSize !== undefined) {
    if (totalCards !== rules.exactDeckSize) {
      errors.push({
        type: "deck_size",
        severity: "error",
        message: `Deck has ${totalCards} cards, requires exactly ${rules.exactDeckSize} for ${capitalize(deck.metadata.format)}`,
        cards: [],
      });
    }
  } else if (totalCards < rules.minDeckSize) {
    errors.push({
      type: "deck_size",
      severity: "error",
      message: `Deck has ${totalCards} cards, requires at least ${rules.minDeckSize} for ${capitalize(deck.metadata.format)}`,
      cards: [],
    });
  }

  return totalCards;
}

function validateCardLegality(
  deck: DeckJson,
  collectionLookup: Map<string, CollectionCard>,
  errors: ValidationEntry[]
): void {
  const format = deck.metadata.format.toLowerCase();

  for (const card of deck.mainboard) {
    const colCard = collectionLookup.get(card.name.toLowerCase());
    if (!colCard) continue; // availability check handles missing cards

    const status = colCard.legalities[format];
    if (status === "banned") {
      errors.push({
        type: "legality",
        severity: "error",
        message: `${card.name} is banned in ${capitalize(deck.metadata.format)}`,
        cards: [card.name],
      });
    } else if (status === "not_legal") {
      errors.push({
        type: "legality",
        severity: "error",
        message: `${card.name} is not legal in ${capitalize(deck.metadata.format)}`,
        cards: [card.name],
      });
    } else if (status === "restricted") {
      // Restricted only matters in Vintage; flag as warning for other formats
      if (card.quantity > 1) {
        errors.push({
          type: "legality",
          severity: "error",
          message: `${card.name} is restricted to 1 copy but deck has ${card.quantity}`,
          cards: [card.name],
        });
      }
    }
  }
}

function validateQuantityLimits(
  deck: DeckJson,
  rules: FormatRules,
  errors: ValidationEntry[]
): void {
  for (const card of deck.mainboard) {
    if (isBasicLand(card.name)) continue;

    if (card.quantity > rules.maxCopies) {
      errors.push({
        type: "quantity_limit",
        severity: "error",
        message: `${card.name} has ${card.quantity} copies, maximum is ${rules.maxCopies} for ${capitalize(deck.metadata.format)}`,
        cards: [card.name],
      });
    }
  }
}

function validateCommanderRules(
  deck: DeckJson,
  rules: FormatRules,
  collectionLookup: Map<string, CollectionCard>,
  errors: ValidationEntry[]
): string[] {
  if (!rules.commanderRequired) return [];

  const commanderCards = deck.mainboard.filter(
    (c) => c.category === "commander"
  );

  // Must have exactly one commander
  if (commanderCards.length === 0) {
    errors.push({
      type: "commander",
      severity: "error",
      message: "Deck has no commander card",
      cards: [],
    });
    return [];
  }

  if (commanderCards.length > 1) {
    errors.push({
      type: "commander",
      severity: "error",
      message: `Deck has ${commanderCards.length} commander cards, requires exactly 1`,
      cards: commanderCards.map((c) => c.name),
    });
    return [];
  }

  const commander = commanderCards[0];
  const colCard = collectionLookup.get(commander.name.toLowerCase());

  // Check if commander is a legendary creature or has "can be your commander"
  if (colCard) {
    const isLegendaryCreature =
      colCard.typeLine.toLowerCase().includes("legendary") &&
      colCard.typeLine.toLowerCase().includes("creature");

    const canBeCommander =
      colCard.rulesText
        ?.toLowerCase()
        .includes("can be your commander") ?? false;

    if (!isLegendaryCreature && !canBeCommander) {
      errors.push({
        type: "commander",
        severity: "error",
        message: `${commander.name} is not a legendary creature and does not have "can be your commander"`,
        cards: [commander.name],
      });
    }
  }

  // Get commander's color identity
  const commanderIdentity: string[] = colCard
    ? [...colCard.colorIdentity].sort()
    : deck.metadata.colors
      ? [...deck.metadata.colors].sort()
      : [];

  // Color identity check
  if (rules.colorIdentityCheck && commanderIdentity.length > 0) {
    const identitySet = new Set(
      commanderIdentity.map((c) => c.toUpperCase())
    );

    for (const card of deck.mainboard) {
      if (card.category === "commander") continue;

      const cardCol = collectionLookup.get(card.name.toLowerCase());
      if (!cardCol) continue;

      const cardColors = cardCol.colorIdentity.map((c) => c.toUpperCase());
      const offColor = cardColors.filter((c) => !identitySet.has(c));

      if (offColor.length > 0) {
        errors.push({
          type: "color_identity",
          severity: "error",
          message: `${card.name} has color identity [${offColor.join(",")}] outside commander's identity [${commanderIdentity.join(",")}]`,
          cards: [card.name],
        });
      }
    }
  }

  return commanderIdentity;
}

function validateCardAvailability(
  deck: DeckJson,
  collectionLookup: Map<string, CollectionCard>,
  errors: ValidationEntry[]
): boolean {
  let allAvailable = true;

  for (const card of deck.mainboard) {
    const colCard = collectionLookup.get(card.name.toLowerCase());

    if (!colCard) {
      errors.push({
        type: "availability",
        severity: "error",
        message: `${card.name} not found in collection`,
        cards: [card.name],
      });
      allAvailable = false;
      continue;
    }

    if (colCard.quantity < card.quantity) {
      errors.push({
        type: "availability",
        severity: "error",
        message: `${card.name}: deck needs ${card.quantity} but collection only has ${colCard.quantity}`,
        cards: [card.name],
      });
      allAvailable = false;
    }
  }

  return allAvailable;
}

function computeManaCurve(
  deck: DeckJson,
  collectionLookup: Map<string, CollectionCard>,
  warnings: ValidationEntry[]
): ManaCurve {
  const curve: ManaCurve = { "0": 0, "1": 0, "2": 0, "3": 0, "4": 0, "5": 0, "6+": 0 };

  for (const card of deck.mainboard) {
    const colCard = collectionLookup.get(card.name.toLowerCase());
    const cmc = colCard?.cmc ?? 0;

    const bucket = cmc >= 6 ? "6+" : (String(cmc) as keyof ManaCurve);
    curve[bucket] += card.quantity;
  }

  // Mana curve analysis
  const totalSpells = Object.values(curve).reduce((s, v) => s + v, 0);
  const highCost = curve["5"] + curve["6+"];
  const highCostPct = totalSpells > 0 ? Math.round((highCost / totalSpells) * 100) : 0;

  if (highCostPct >= 40) {
    warnings.push({
      type: "mana_curve",
      severity: "warning",
      message: `Mana curve is top-heavy: ${highCostPct}% of spells cost 5+ mana`,
      cards: [],
    });
  }

  const lowCost = curve["0"] + curve["1"] + curve["2"];
  const lowCostPct = totalSpells > 0 ? Math.round((lowCost / totalSpells) * 100) : 0;

  if (lowCostPct < 20 && totalSpells > 0) {
    warnings.push({
      type: "mana_curve",
      severity: "warning",
      message: `Mana curve is light on early plays: only ${lowCostPct}% of spells cost 0-2 mana`,
      cards: [],
    });
  }

  return curve;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error("Usage: npx tsx validate-deck.ts <deck.json> <collection.json> [output-path]");
    process.exit(1);
  }

  const deckPath = args[0];
  const collectionPath = args[1];
  const outputPath = args[2] ?? "validation-report.json";

  // Load inputs
  const deck: DeckJson = loadJson(deckPath);
  const collection: CollectionJson = loadJson(collectionPath);

  const format = deck.metadata.format.toLowerCase();
  const rules = FORMAT_RULES[format];

  if (!rules) {
    console.error(`Unknown format: ${deck.metadata.format}. Supported: ${Object.keys(FORMAT_RULES).join(", ")}`);
    process.exit(1);
  }

  const collectionLookup = buildCollectionLookup(collection.cards);
  const errors: ValidationEntry[] = [];
  const warnings: ValidationEntry[] = [];

  // 1. Deck size
  const totalCards = validateDeckSize(deck, rules, errors);

  // 2. Card legality
  validateCardLegality(deck, collectionLookup, errors);

  // 3. Quantity limits
  validateQuantityLimits(deck, rules, errors);

  // 4. Commander rules
  validateCommanderRules(deck, rules, collectionLookup, errors);

  // 5. Card availability
  const allAvailable = validateCardAvailability(deck, collectionLookup, errors);

  // 6. Mana curve
  const manaCurve = computeManaCurve(deck, collectionLookup, warnings);

  // Build report
  const uniqueCards = deck.mainboard.length;
  const hasErrors = errors.some((e) => e.severity === "error");

  const report: ValidationReport = {
    metadata: {
      deckFile: resolve(deckPath),
      collectionFile: resolve(collectionPath),
      format: deck.metadata.format,
      validatedAt: new Date().toISOString(),
    },
    valid: !hasErrors,
    errors,
    warnings,
    manaCurve,
    summary: {
      totalCards,
      uniqueCards,
      formatLegal: !hasErrors,
      availableInCollection: allAvailable,
    },
  };

  // Write output
  const absOutput = resolve(outputPath);
  writeFileSync(absOutput, JSON.stringify(report, null, 2), "utf-8");

  console.log(`Validation report written to ${absOutput}`);
  console.log(`Valid: ${report.valid}`);
  console.log(`Errors: ${errors.length}, Warnings: ${warnings.length}`);
  console.log(`Total cards: ${totalCards}, Unique: ${uniqueCards}`);

  if (!report.valid) {
    process.exit(1);
  }
}

main();
