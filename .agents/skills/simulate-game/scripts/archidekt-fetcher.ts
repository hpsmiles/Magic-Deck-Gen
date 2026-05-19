import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { CardData, CardInstance, DeckInput, ArchidektDeck } from './types.js';
import { fetchCardsForDeck } from './card-provider.js';

// === Instance ID Generator ===

let instanceCounter = 0;

function generateInstanceId(): string {
  return `card-${instanceCounter++}`;
}

// === Archidekt URL Parsing ===

/**
 * Checks if the input string is an Archidekt deck URL.
 */
export function isArchidektUrl(input: string): boolean {
  return input.includes('archidekt.com/decks/');
}

/**
 * Extracts the deck ID from an Archidekt URL.
 * Returns null if the URL doesn't contain a valid deck ID.
 */
function parseArchidektUrl(url: string): number | null {
  const match = url.match(/archidekt\.com\/decks\/(\d+)/);
  if (!match) return null;
  return parseInt(match[1], 10);
}

// === Archidekt API ===

/**
 * Fetches a deck from the Archidekt API by deck ID.
 */
async function fetchArchidektDeck(deckId: number): Promise<ArchidektDeck> {
  const url = `https://archidekt.com/api/decks/${deckId}/`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Archidekt API error: ${response.status} ${response.statusText} for deck ${deckId}`);
  }

  return (await response.json()) as ArchidektDeck;
}

// === Card Instance Creation ===

/**
 * Creates CardInstance objects for each card in the deck, respecting quantity.
 * Commander cards are placed in the 'command' zone; others in 'library'.
 */
function createCardInstances(
  cardDataMap: Map<string, CardData>,
  deckCards: { name: string; quantity: number; category: string }[],
  commanderName: string
): CardInstance[] {
  const instances: CardInstance[] = [];

  for (const entry of deckCards) {
    const card = cardDataMap.get(entry.name);
    if (!card) {
      throw new Error(`Card data not found for: ${entry.name}`);
    }

    for (let i = 0; i < entry.quantity; i++) {
      instances.push({
        id: generateInstanceId(),
        card,
        owner: 0, // Will be assigned by game engine
        zone: entry.name === commanderName ? 'command' : 'library',
      });
    }
  }

  return instances;
}

// === Public API ===

/**
 * Fetches a deck from an Archidekt URL.
 * Parses the deck ID, fetches from the API, enriches card data via Scryfall,
 * and returns a DeckInput ready for the game engine.
 */
export async function fetchDeckFromArchidekt(url: string): Promise<DeckInput> {
  const deckId = parseArchidektUrl(url);
  if (deckId === null) {
    throw new Error(`Invalid Archidekt URL: ${url}`);
  }

  const deck = await fetchArchidektDeck(deckId);

  // Find the commander card
  const commanderEntry = deck.cards.find(
    (c) => c.category === 'commander' || c.category === 'commanders'
  );
  if (!commanderEntry) {
    throw new Error(`No commander found in Archidekt deck ${deckId}`);
  }
  const commanderName = commanderEntry.card.oracleCard.name;

  // Build the list for card fetching
  const deckCards = deck.cards.map((c) => ({
    name: c.card.oracleCard.name,
    quantity: c.quantity,
    category: c.category,
  }));

  // Fetch all card data from Scryfall (with cache)
  const cardDataMap = await fetchCardsForDeck(
    deckCards.map((c) => ({ name: c.name, quantity: c.quantity }))
  );

  // Create card instances
  const cards = createCardInstances(cardDataMap, deckCards, commanderName);

  // Get commander CardData
  const commander = cardDataMap.get(commanderName);
  if (!commander) {
    throw new Error(`Commander card data not found for: ${commanderName}`);
  }

  // Derive colors from commander's color identity
  const colors = [...commander.colorIdentity];

  return {
    name: deck.name,
    commander,
    cards,
    strategy: '',
    colors,
  };
}

/**
 * Loads a deck from a local JSON file.
 * Expected format:
 * {
 *   mainboard: [{ name, scryfallId?, quantity, category? }],
 *   metadata: { commander?, strategy?, colors? }
 * }
 */
export async function loadDeckFromLocalFile(filePath: string): Promise<DeckInput> {
  const raw = await readFile(filePath, 'utf-8');
  const data = JSON.parse(raw) as {
    mainboard: { name: string; scryfallId?: string; quantity: number; category?: string }[];
    metadata?: { name?: string; commander?: string; strategy?: string; colors?: string[] };
  };

  if (!data.mainboard || !Array.isArray(data.mainboard)) {
    throw new Error(`Invalid deck file format: missing mainboard array in ${filePath}`);
  }

  // Find the commander from mainboard (category === 'commander') or metadata
  const commanderEntry = data.mainboard.find((c) => c.category === 'commander');
  const commanderName = commanderEntry?.name ?? data.metadata?.commander;
  if (!commanderName) {
    throw new Error(`No commander found in deck file: ${filePath}`);
  }

  // Build the list for card fetching
  const deckCards = data.mainboard.map((c) => ({
    name: c.name,
    scryfallId: c.scryfallId,
    quantity: c.quantity,
    category: c.category ?? '',
  }));

  // Fetch all card data from Scryfall (with cache)
  const cardDataMap = await fetchCardsForDeck(
    deckCards.map((c) => ({ name: c.name, scryfallId: c.scryfallId, quantity: c.quantity }))
  );

  // Create card instances
  const cards = createCardInstances(cardDataMap, deckCards, commanderName);

  // Get commander CardData
  const commander = cardDataMap.get(commanderName);
  if (!commander) {
    throw new Error(`Commander card data not found for: ${commanderName}`);
  }

  // Use metadata colors or derive from commander
  const colors = data.metadata?.colors ?? [...commander.colorIdentity];

  // Use metadata name, or fall back to file basename
  const deckName = data.metadata?.name ?? basename(filePath, '.json');

  return {
    name: deckName,
    commander,
    cards,
    strategy: data.metadata?.strategy ?? '',
    colors,
  };
}
