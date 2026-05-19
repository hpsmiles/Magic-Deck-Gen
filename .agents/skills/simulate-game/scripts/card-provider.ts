import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CardData, ManaCost, ScryfallCard } from './types.js';

// === Constants ===

const RATE_LIMIT_MS = 550;
const SCRYFALL_API_BASE = 'https://api.scryfall.com';
const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'card-cache');

// === Rate Limiter State ===

let lastRequestTime = 0;

// === Utility ===

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeParseInt(value: string): number | null {
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? null : parsed;
}

// === Rate-Limited Fetch ===

async function rateLimitedFetch(url: string): Promise<unknown> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }
  lastRequestTime = Date.now();

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Scryfall API error: ${response.status} ${response.statusText} for ${url}`);
  }
  return response.json() as Promise<unknown>;
}

// === Disk Cache ===

async function ensureCacheDir(): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
}

function cacheFilePath(scryfallId: string): string {
  return join(CACHE_DIR, `${scryfallId}.json`);
}

async function readFromCache(scryfallId: string): Promise<CardData | null> {
  try {
    const filePath = cacheFilePath(scryfallId);
    const data = await readFile(filePath, 'utf-8');
    return JSON.parse(data) as CardData;
  } catch {
    return null;
  }
}

async function writeToCache(card: CardData): Promise<void> {
  await ensureCacheDir();
  const filePath = cacheFilePath(card.scryfallId);
  await writeFile(filePath, JSON.stringify(card, null, 2), 'utf-8');
}

// === Mana Cost Parser ===

/**
 * Parses a Scryfall mana cost string like "{2}{W}{U}" into a ManaCost object.
 * Handles: W, U, B, R, G, X, numeric, hybrid (takes first color).
 */
export function parseManaCost(costStr: string): ManaCost {
  const cost: ManaCost = {
    white: 0,
    blue: 0,
    black: 0,
    red: 0,
    green: 0,
    colorless: 0,
    x: 0,
  };

  if (!costStr) return cost;

  // Match each mana symbol within braces
  const symbolRegex = /\{([^}]+)\}/g;
  let match: RegExpExecArray | null;

  while ((match = symbolRegex.exec(costStr)) !== null) {
    const symbol = match[1].toUpperCase();

    // Hybrid mana: e.g. "W/U", "2/B", "R/W" — take the first color
    if (symbol.includes('/')) {
      const parts = symbol.split('/');
      const first = parts[0];

      if (/^\d+$/.test(first)) {
        cost.colorless += parseInt(first, 10);
      } else {
        applyColorSymbol(cost, first);
      }
      continue;
    }

    // Numeric generic mana
    if (/^\d+$/.test(symbol)) {
      cost.colorless += parseInt(symbol, 10);
      continue;
    }

    // X mana
    if (symbol === 'X') {
      cost.x += 1;
      continue;
    }

    // Colored mana symbols
    applyColorSymbol(cost, symbol);
  }

  return cost;
}

function applyColorSymbol(cost: ManaCost, symbol: string): void {
  switch (symbol) {
    case 'W': cost.white += 1; break;
    case 'U': cost.blue += 1; break;
    case 'B': cost.black += 1; break;
    case 'R': cost.red += 1; break;
    case 'G': cost.green += 1; break;
    default:
      // Unknown symbol — treat as colorless 1
      cost.colorless += 1;
      break;
  }
}

// === Scryfall Response → CardData ===

function scryfallToCardData(scryfall: ScryfallCard): CardData {
  return {
    name: scryfall.name,
    scryfallId: scryfall.id,
    manaCost: parseManaCost(scryfall.mana_cost ?? ''),
    typeLine: scryfall.type_line ?? '',
    oracleText: scryfall.oracle_text ?? '',
    power: scryfall.power !== null ? safeParseInt(scryfall.power) : null,
    toughness: scryfall.toughness !== null ? safeParseInt(scryfall.toughness) : null,
    loyalty: scryfall.loyalty !== null ? safeParseInt(scryfall.loyalty) : null,
    colorIdentity: scryfall.color_identity ?? [],
    keywords: scryfall.keywords ?? [],
  };
}

// === Public API ===

/**
 * Fetches card data from Scryfall by Scryfall ID, with disk cache.
 */
export async function fetchCardByScryfallId(scryfallId: string): Promise<CardData> {
  // Check cache first
  const cached = await readFromCache(scryfallId);
  if (cached) return cached;

  // Fetch from Scryfall
  const url = `${SCRYFALL_API_BASE}/cards/${scryfallId}`;
  const data = (await rateLimitedFetch(url)) as ScryfallCard;
  const card = scryfallToCardData(data);

  // Write to cache
  await writeToCache(card);

  return card;
}

/**
 * Fetches card data from Scryfall by name using fuzzy search.
 * Checks disk cache first by scanning all cached files.
 */
export async function fetchCardByName(name: string): Promise<CardData> {
  // Check cache by scanning all cached files
  const cached = await findCachedCardByName(name);
  if (cached) return cached;

  // Fetch from Scryfall using fuzzy search
  const url = `${SCRYFALL_API_BASE}/cards/named?fuzzy=${encodeURIComponent(name)}`;
  const data = (await rateLimitedFetch(url)) as ScryfallCard;
  const card = scryfallToCardData(data);

  // Write to cache
  await writeToCache(card);

  return card;
}

/**
 * Fetches all cards for a deck, using cache where possible.
 * Returns a Map from card name to CardData.
 */
export async function fetchCardsForDeck(
  deckCards: { name: string; scryfallId?: string; quantity: number }[]
): Promise<Map<string, CardData>> {
  const result = new Map<string, CardData>();

  for (const entry of deckCards) {
    let card: CardData;

    if (entry.scryfallId) {
      card = await fetchCardByScryfallId(entry.scryfallId);
    } else {
      card = await fetchCardByName(entry.name);
    }

    result.set(entry.name, card);
  }

  return result;
}

// === Cache Scan Helper ===

/**
 * Scans the card-cache directory for a card matching the given name.
 * Returns null if not found.
 */
async function findCachedCardByName(name: string): Promise<CardData | null> {
  try {
    const files = await readdir(CACHE_DIR);
    const normalizedName = name.toLowerCase();

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const filePath = join(CACHE_DIR, file);
        const data = await readFile(filePath, 'utf-8');
        const card = JSON.parse(data) as CardData;
        if (card.name.toLowerCase() === normalizedName) {
          return card;
        }
      } catch {
        // Skip malformed cache files
        continue;
      }
    }
  } catch {
    // Cache directory doesn't exist yet
    return null;
  }

  return null;
}
