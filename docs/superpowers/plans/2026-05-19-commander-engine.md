# Commander Game Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build a Commander-format MTG game engine that simulates games between 2-5 decks using deterministic rules enforcement, LLM-driven AI decisions, and LLM fallback rulings.

**Architecture:** Turn-loop engine with immutable game state. The Game Orchestrator drives the turn structure, calling the LLM Agent for decisions and the Action Validator before executing them. The Ruling Oracle provides LLM fallback for unresolvable interactions. Tournament mode runs multiple games and aggregates statistics.

**Tech Stack:** TypeScript (ES2022, Node16 modules), OpenAI SDK for LLM calls, Scryfall API for card data, Archidekt API for deck fetching.

---

## File Structure

```
.agents/skills/simulate-game/
├── SKILL.md
├── scripts/
│   ├── package.json
│   ├── tsconfig.json
│   ├── .gitignore
│   ├── types.ts
│   ├── card-provider.ts
│   ├── archidekt-fetcher.ts
│   ├── game-state.ts
│   ├── mana-resolver.ts
│   ├── state-based-actions.ts
│   ├── action-validator.ts
│   ├── combat-resolver.ts
│   ├── llm-agent.ts
│   ├── ruling-oracle.ts
│   ├── game-engine.ts
│   ├── tournament-runner.ts
│   ├── narrative-generator.ts
│   └── simulate.ts
```

---


### Task 1: Project Scaffold & Types

**Files:**
- Create: .agents/skills/simulate-game/SKILL.md
- Create: .agents/skills/simulate-game/scripts/package.json
- Create: .agents/skills/simulate-game/scripts/tsconfig.json
- Create: .agents/skills/simulate-game/scripts/.gitignore
- Create: .agents/skills/simulate-game/scripts/types.ts

- [ ] **Step 1: Create skill directory structure**

```
mkdir -p .agents/skills/simulate-game/scripts
```

- [ ] **Step 2: Create SKILL.md**

```markdown
---
name: simulate-game
description: "Use when the user wants to simulate MTG Commander games between decks. Triggers include requests to 'simulate games', 'test my deck', 'run a tournament', 'play decks against each other', or 'battle test decks'."
---

# Simulate Game

Simulate Commander-format MTG games between 2-5 decks using AI-driven gameplay.

## Prerequisites

- At least 2 deck files (local JSON, Archidekt URL, or Archidekt CSV)
- ```OPENAI_API_KEY``` or ```ANTHROPIC_API_KEY``` environment variable set

## Workflow

1. Identify the decks to simulate:
   - Local deck JSON files (e.g., ```omnath-locus-of-rage-deck.json```)
   - Archidekt URLs (e.g., ```https://archidekt.com/decks/1234567```)
   - Archidekt CSV exports

2. Run the simulation:
   ````bash
   cd .agents/skills/simulate-game/scripts && npx tsx simulate.ts --decks <deck1> <deck2> [<deck3>...] --games <N>
   ````
   - ```--decks```: Space-separated list of deck sources (local paths or Archidekt URLs)
   - ```--games```: Number of games to simulate (default: 10)

3. Review the output:
   - ```simulation-results.json``` — Tournament aggregate statistics
   - ```simulation-games/``` — Per-game JSON logs
   - ```simulation-report.md``` — Narrative summary

4. Present results to the user with key insights

## Environment Variables

- ```LLM_PROVIDER```: ```openai``` (default) or ```anthropic``
- ```LLM_MODEL```: Model name (default: ```gpt-4o``` or ```claude-sonnet-4-20250514```)
- ```OPENAI_API_KEY```: Required if using OpenAI
- ```ANTHROPIC_API_KEY```: Required if using Anthropic
```

- [ ] **Step 3: Create package.json**

```json
{
  "name": "simulate-game-scripts",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "openai": "^4.70.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 4: Create tsconfig.json**

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

- [ ] **Step 5: Create .gitignore**

```
node_modules/
dist/
simulation-results.json
simulation-games/
simulation-report.md
card-cache/
ruling-cache.json
```

- [ ] **Step 6: Create types.ts**

```typescript
// === Core Game Types ===

export type GamePhase = 'beginning' | 'precombat_main' | 'combat' | 'postcombat_main' | 'ending';

export type GameStep =
  | 'untap' | 'upkeep' | 'draw'
  | 'main_precombat'
  | 'begin_combat' | 'declare_attackers' | 'declare_blockers' | 'combat_damage' | 'end_combat'
  | 'main_postcombat'
  | 'end_step' | 'cleanup';

export interface ManaPool {
  white: number;
  blue: number;
  black: number;
  red: number;
  green: number;
  colorless: number;
}

export interface ManaCost {
  white: number;
  blue: number;
  black: number;
  red: number;
  green: number;
  colorless: number;
  x: boolean;
}

export interface CardData {
  name: string;
  scryfallId: string;
  manaCost: ManaCost;
  typeLine: string;
  oracleText: string;
  power: number | null;
  toughness: number | null;
  loyalty: number | null;
  colorIdentity: string[];
  keywords: string[];
}

export interface CardInstance {
  id: string;
  card: CardData;
  owner: number;
  zone: 'hand' | 'library' | 'graveyard' | 'exile' | 'battlefield' | 'command' | 'stack';
}

export interface Permanent {
  id: string;
  card: CardData;
  owner: number;
  controller: number;
  tapped: boolean;
  summoningSickness: boolean;
  damage: number;
  counters: Map<string, number>;
  attachments: string[];
  attachedTo: string | null;
  copyOf: string | null;
}

export interface Target {
  type: 'player' | 'permanent' | 'stackItem';
  id: string;
}

export interface StackItem {
  id: string;
  type: 'spell' | 'ability' | 'trigger';
  source: CardInstance | Permanent;
  controller: number;
  targets: Target[];
  manaCostPaid: ManaCost;
}

export interface PlayerState {
  index: number;
  life: number;
  poisonCounters: number;
  commanderDamage: Map<string, number>;
  manaPool: ManaPool;
  hand: CardInstance[];
  library: CardInstance[];
  graveyard: CardInstance[];
  exile: CardInstance[];
  mulligansTaken: number;
  hasDrawnThisTurn: boolean;
  landPlaysRemaining: number;
}

export interface GameLogEntry {
  turn: number;
  player: number;
  phase: GameStep;
  action: string;
  card?: string;
  details: string;
  timestamp: number;
}

export interface CommandZoneCard {
  instance: CardInstance;
  castCount: number;
}

export interface GameState {
  turn: number;
  activePlayerIndex: number;
  phase: GamePhase;
  step: GameStep;
  stack: StackItem[];
  players: PlayerState[];
  battlefield: Permanent[];
  commandZone: CommandZoneCard[];
  timestamp: number;
  gameLog: GameLogEntry[];
  gameOver: boolean;
  winner: number | null;
}

// === Action Types ===

export type ActionType = 'cast' | 'activate' | 'attack' | 'block' | 'pass' | 'play_land' | 'mulligan' | 'keep' | 'respond' | 'order_triggers';

export interface GameAction {
  type: ActionType;
  cardId?: string;
  permanentId?: string;
  targets?: Target[];
  attackers?: Record<string, Target>;
  blockers?: Record<string, string[]>;
  reasoning?: string;
}

export interface ValidationResult {
  legal: boolean;
  reason?: string;
}

export interface LegalActions {
  castableSpells: CardInstance[];
  playableLands: CardInstance[];
  activatableAbilities: Permanent[];
  canAttack: Permanent[];
  canBlock: Permanent[];
  canPass: boolean;
  canRespond: boolean;
}

// === LLM Types ===

export interface LLMActionRequest {
  playerIndex: number;
  deckName: string;
  deckStrategy: string;
  gameSummary: string;
  legalActions: LegalActions;
  recentActions: GameLogEntry[];
  phase: GameStep;
  turn: number;
}

export interface LLMActionResponse {
  actions: GameAction[];
  reasoning: string;
}

export interface RulingRequest {
  interaction: string;
  cards: CardData[];
  gameState: string;
  rulesQuestion: string;
}

export interface RulingResponse {
  ruling: string;
  explanation: string;
}

// === Deck & Tournament Types ===

export interface DeckInput {
  name: string;
  commander: CardData;
  cards: CardInstance[];
  strategy: string;
  colors: string[];
}

export interface GameResult {
  gameId: string;
  players: PlayerResult[];
  winner: PlayerResult | null;
  totalTurns: number;
  log: GameLogEntry[];
}

export interface PlayerResult {
  deckName: string;
  seatIndex: number;
  result: 'win' | 'loss';
  turnsSurvived: number;
}

export interface TournamentResult {
  tournamentId: string;
  decks: string[];
  gamesPlayed: number;
  results: Record<string, DeckStats>;
  gameLogs: string[];
}

export interface DeckStats {
  wins: number;
  losses: number;
  winRate: number;
  avgTurnsSurvived: number;
}

// === Scryfall Types ===

export interface ScryfallCard {
  id: string;
  name: string;
  mana_cost: string;
  type_line: string;
  oracle_text: string;
  power: string | null;
  toughness: string | null;
  loyalty: string | null;
  color_identity: string[];
  keywords: string[];
  legalities: Record<string, string>;
}

// === Archidekt Types ===

export interface ArchidektDeck {
  id: number;
  name: string;
  cards: ArchidektCard[];
}

export interface ArchidektCard {
  card: {
    oracleCard: {
      name: string;
    };
  };
  quantity: number;
  category: string;
}
```

- [ ] **Step 7: Install dependencies**

```
cd .agents/skills/simulate-game/scripts && npm install
```

- [ ] **Step 8: Verify TypeScript compiles**

```
cd .agents/skills/simulate-game/scripts && npx tsc --noEmit
```

Expected: No errors

- [ ] **Step 9: Commit**

```
git add .agents/skills/simulate-game/
git commit -m "feat(simulate-game): scaffold skill structure and type definitions"
```


### Task 2: Card Provider (Scryfall API + Cache)

**Files:**
- Create: .agents/skills/simulate-game/scripts/card-provider.ts

- [ ] **Step 1: Create card-provider.ts**

```typescript
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CardData, ManaCost, ScryfallCard } from './types.js';

const SCRYFALL_API = 'https://api.scryfall.com';
const RATE_LIMIT_MS = 550;
const CACHE_DIR = 'card-cache';

let lastRequestTime = 0;

async function rateLimitedFetch(url: string): Promise<unknown> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }
  lastRequestTime = Date.now();
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(Scryfall API error:   for );
  }
  return response.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function parseManaCost(costStr: string): ManaCost {
  const cost: ManaCost = { white: 0, blue: 0, black: 0, red: 0, green: 0, colorless: 0, x: false };
  if (!costStr) return cost;

  const symbols = costStr.match(/\{[^}]+\}/g) || [];
  for (const sym of symbols) {
    const inner = sym.slice(1, -1).toLowerCase();
    if (inner === 'w') cost.white++;
    else if (inner === 'u') cost.blue++;
    else if (inner === 'b') cost.black++;
    else if (inner === 'r') cost.red++;
    else if (inner === 'g') cost.green++;
    else if (inner === 'x') cost.x = true;
    else {
      const num = parseInt(inner, 10);
      if (!isNaN(num)) cost.colorless += num;
      else if (inner.includes('/')) {
        const first = inner.split('/')[0];
        if (first === 'w') cost.white++;
        else if (first === 'u') cost.blue++;
        else if (first === 'b') cost.black++;
        else if (first === 'r') cost.red++;
        else if (first === 'g') cost.green++;
        else {
          const n = parseInt(first, 10);
          if (!isNaN(n)) cost.colorless += n;
        }
      }
    }
  }
  return cost;
}

function scryfallToCardData(scryfall: ScryfallCard): CardData {
  return {
    name: scryfall.name,
    scryfallId: scryfall.id,
    manaCost: parseManaCost(scryfall.mana_cost || ''),
    typeLine: scryfall.type_line,
    oracleText: scryfall.oracle_text || '',
    power: scryfall.power !== null ? parseInt(scryfall.power, 10) : null,
    toughness: scryfall.toughness !== null ? parseInt(scryfall.toughness, 10) : null,
    loyalty: scryfall.loyalty !== null ? parseInt(scryfall.loyalty, 10) : null,
    colorIdentity: scryfall.color_identity,
    keywords: scryfall.keywords,
  };
}

function getCachePath(scryfallId: string): string {
  return join(CACHE_DIR, ${scryfallId}.json);
}

function readFromCache(scryfallId: string): CardData | null {
  const path = getCachePath(scryfallId);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as CardData;
  } catch {
    return null;
  }
}

function writeToCache(card: CardData): void {
  if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
  }
  writeFileSync(getCachePath(card.scryfallId), JSON.stringify(card, null, 2));
}

export async function fetchCardByScryfallId(scryfallId: string): Promise<CardData> {
  const cached = readFromCache(scryfallId);
  if (cached) return cached;

  const data = await rateLimitedFetch(${SCRYFALL_API}/cards/) as ScryfallCard;
  const card = scryfallToCardData(data);
  writeToCache(card);
  return card;
}

export async function fetchCardByName(name: string): Promise<CardData> {
  if (existsSync(CACHE_DIR)) {
    const files = readdirSync(CACHE_DIR);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = readFileSync(join(CACHE_DIR, file), 'utf-8');
        const card = JSON.parse(raw) as CardData;
        if (card.name.toLowerCase() === name.toLowerCase()) return card;
      } catch { continue; }
    }
  }

  const encoded = encodeURIComponent(name);
  const data = await rateLimitedFetch(${SCRYFALL_API}/cards/named?fuzzy=) as ScryfallCard;
  const card = scryfallToCardData(data);
  writeToCache(card);
  return card;
}

export async function fetchCardsForDeck(
  deckCards: { name: string; scryfallId?: string; quantity: number }[]
): Promise<Map<string, CardData>> {
  const cardMap = new Map<string, CardData>();
  for (const entry of deckCards) {
    let card: CardData;
    if (entry.scryfallId) {
      card = await fetchCardByScryfallId(entry.scryfallId);
    } else {
      card = await fetchCardByName(entry.name);
    }
    cardMap.set(entry.name, card);
  }
  return cardMap;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```
cd .agents/skills/simulate-game/scripts && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```
git add .agents/skills/simulate-game/scripts/card-provider.ts
git commit -m "feat(simulate-game): add Scryfall card provider with disk cache"
```

---

### Task 3: Archidekt Fetcher

**Files:**
- Create: .agents/skills/simulate-game/scripts/archidekt-fetcher.ts

- [ ] **Step 1: Create archidekt-fetcher.ts**

```typescript
import type { ArchidektDeck, CardData, CardInstance, DeckInput } from './types.js';
import { fetchCardsForDeck } from './card-provider.js';

let nextInstanceId = 0;
function generateInstanceId(): string {
  return card--;
}

function parseArchidektUrl(url: string): number | null {
  const match = url.match(/archidekt\.com\/decks\/(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

async function fetchArchidektDeck(deckId: number): Promise<ArchidektDeck> {
  const response = await fetch(https://archidekt.com/api/decks//);
  if (!response.ok) {
    throw new Error(Archidekt API error:  for deck );
  }
  return response.json() as Promise<ArchidektDeck>;
}

export function isArchidektUrl(input: string): boolean {
  return input.includes('archidekt.com/decks/');
}

export async function fetchDeckFromArchidekt(url: string): Promise<DeckInput> {
  const deckId = parseArchidektUrl(url);
  if (!deckId) {
    throw new Error(Invalid Archidekt URL: );
  }

  const deck = await fetchArchidektDeck(deckId);

  const cardEntries = deck.cards.map(c => ({
    name: c.card.oracleCard.name,
    quantity: c.quantity,
  }));

  const cardDataMap = await fetchCardsForDeck(cardEntries);

  const commanderEntry = deck.cards.find(c =>
    c.category?.toLowerCase() === 'commander' ||
    c.category?.toLowerCase() === 'commanders'
  );

  let commander: CardData;
  if (commanderEntry) {
    commander = cardDataMap.get(commanderEntry.card.oracleCard.name)!;
  } else {
    commander = cardDataMap.values().next().value;
  }

  const cards: CardInstance[] = [];
  for (const entry of deck.cards) {
    const cardData = cardDataMap.get(entry.card.oracleCard.name);
    if (!cardData) continue;
    for (let i = 0; i < entry.quantity; i++) {
      cards.push({
        id: generateInstanceId(),
        card: cardData,
        owner: 0,
        zone: 'library',
      });
    }
  }

  return {
    name: deck.name,
    commander,
    cards,
    strategy: Commander deck led by ,
    colors: commander.colorIdentity,
  };
}

export async function loadDeckFromLocalFile(filePath: string): Promise<DeckInput> {
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync(filePath, 'utf-8');
  const deckJson = JSON.parse(raw);

  const commanderEntry = deckJson.mainboard?.find(
    (c: { category: string }) => c.category === 'commander'
  );

  const cardEntries = (deckJson.mainboard || []).map(
    (c: { name: string; scryfallId?: string; quantity: number }) => ({
      name: c.name,
      scryfallId: c.scryfallId,
      quantity: c.quantity,
    })
  );

  const cardDataMap = await fetchCardsForDeck(cardEntries);

  let commander: CardData;
  if (commanderEntry) {
    commander = cardDataMap.get(commanderEntry.name)!;
  } else {
    commander = cardDataMap.values().next().value;
  }

  const cards: CardInstance[] = [];
  for (const entry of cardEntries) {
    const cardData = cardDataMap.get(entry.name);
    if (!cardData) continue;
    for (let i = 0; i < entry.quantity; i++) {
      cards.push({
        id: generateInstanceId(),
        card: cardData,
        owner: 0,
        zone: 'library',
      });
    }
  }

  return {
    name: deckJson.metadata?.commander || 'Unknown Deck',
    commander,
    cards,
    strategy: deckJson.metadata?.strategy || Commander deck led by ,
    colors: deckJson.metadata?.colors || commander.colorIdentity,
  };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```
cd .agents/skills/simulate-game/scripts && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```
git add .agents/skills/simulate-game/scripts/archidekt-fetcher.ts
git commit -m "feat(simulate-game): add Archidekt URL fetcher and local deck loader"
```


### Task 4: Game State (Creation & Immutable Operations)

**Files:**
- Create: .agents/skills/simulate-game/scripts/game-state.ts

- [ ] **Step 1: Create game-state.ts**

```typescript
import type {
  GameState, PlayerState, Permanent, CardInstance, CommandZoneCard,
  ManaPool, GameLogEntry, DeckInput
} from './types.js';

let nextPermanentId = 0;
function generatePermanentId(): string {
  return perm--;
}

export function createEmptyManaPool(): ManaPool {
  return { white: 0, blue: 0, black: 0, red: 0, green: 0, colorless: 0 };
}

export function createInitialGameState(decks: DeckInput[]): GameState {
  const players: PlayerState[] = decks.map((deck, index) => {
    const cards = deck.cards.map(c => ({ ...c, owner: index, zone: 'library' as const }));
    const commanderCard = cards.find(c => c.card.scryfallId === deck.commander.scryfallId);
    const library = commanderCard
      ? cards.filter(c => c.id !== commanderCard.id)
      : cards;

    return {
      index,
      life: 40,
      poisonCounters: 0,
      commanderDamage: new Map<string, number>(),
      manaPool: createEmptyManaPool(),
      hand: [],
      library: shuffleArray([...library]),
      graveyard: [],
      exile: [],
      mulligansTaken: 0,
      hasDrawnThisTurn: false,
      landPlaysRemaining: 1,
    };
  });

  const commandZone: CommandZoneCard[] = decks.map((deck, index) => {
    const commanderCard = deck.cards.find(c => c.card.scryfallId === deck.commander.scryfallId);
    return {
      instance: commanderCard || {
        id: cmd-,
        card: deck.commander,
        owner: index,
        zone: 'command' as const,
      },
      castCount: 0,
    };
  });

  return {
    turn: 1,
    activePlayerIndex: 0,
    phase: 'beginning',
    step: 'untap',
    stack: [],
    players,
    battlefield: [],
    commandZone,
    timestamp: 0,
    gameLog: [],
    gameOver: false,
    winner: null,
  };
}

export function shuffleArray<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function drawCards(state: GameState, playerIndex: number, count: number): GameState {
  const player = state.players[playerIndex];
  const toDraw = Math.min(count, player.library.length);
  const drawn = player.library.slice(0, toDraw);
  const remaining = player.library.slice(toDraw);

  const newPlayer: PlayerState = {
    ...player,
    hand: [...player.hand, ...drawn.map(c => ({ ...c, zone: 'hand' as const }))],
    library: remaining,
  };

  const newPlayers = [...state.players];
  newPlayers[playerIndex] = newPlayer;

  return { ...state, players: newPlayers, timestamp: state.timestamp + 1 };
}

export function moveCardToGraveyard(state: GameState, playerIndex: number, cardId: string): GameState {
  const player = state.players[playerIndex];
  const cardIdx = player.hand.findIndex(c => c.id === cardId);
  if (cardIdx === -1) return state;

  const card = { ...player.hand[cardIdx], zone: 'graveyard' as const };
  const newHand = [...player.hand.slice(0, cardIdx), ...player.hand.slice(cardIdx + 1)];

  const newPlayer = { ...player, hand: newHand, graveyard: [...player.graveyard, card] };
  const newPlayers = [...state.players];
  newPlayers[playerIndex] = newPlayer;

  return { ...state, players: newPlayers, timestamp: state.timestamp + 1 };
}

export function addManaToPool(pool: ManaPool, color: keyof ManaPool, amount: number): ManaPool {
  return { ...pool, [color]: pool[color] + amount };
}

export function emptyManaPool(pool: ManaPool): ManaPool {
  return createEmptyManaPool();
}

export function canPayManaCost(pool: ManaPool, cost: { white: number; blue: number; black: number; red: number; green: number; colorless: number }): boolean {
  if (pool.white < cost.white) return false;
  if (pool.blue < cost.blue) return false;
  if (pool.black < cost.black) return false;
  if (pool.red < cost.red) return false;
  if (pool.green < cost.green) return false;

  const remainingColored = (pool.white - cost.white) + (pool.blue - cost.blue) +
    (pool.black - cost.black) + (pool.red - cost.red) + (pool.green - cost.green);
  if (pool.colorless + remainingColored < cost.colorless) return false;

  return true;
}

export function payManaCost(pool: ManaPool, cost: { white: number; blue: number; black: number; red: number; green: number; colorless: number }): ManaPool | null {
  if (!canPayManaCost(pool, cost)) return null;

  let newPool = { ...pool };
  newPool.white -= cost.white;
  newPool.blue -= cost.blue;
  newPool.black -= cost.black;
  newPool.red -= cost.red;
  newPool.green -= cost.green;

  let colorlessRemaining = cost.colorless;
  const colorlessFromPool = Math.min(newPool.colorless, colorlessRemaining);
  newPool.colorless -= colorlessFromPool;
  colorlessRemaining -= colorlessFromPool;

  if (colorlessRemaining > 0) {
    const colors: (keyof ManaPool)[] = ['white', 'blue', 'black', 'red', 'green'];
    for (const color of colors) {
      if (colorlessRemaining <= 0) break;
      const available = newPool[color];
      const use = Math.min(available, colorlessRemaining);
      (newPool as Record<string, number>)[color] -= use;
      colorlessRemaining -= use;
    }
  }

  return newPool;
}

export function cardToPermanent(card: CardInstance, controller: number): Permanent {
  return {
    id: generatePermanentId(),
    card: card.card,
    owner: card.owner,
    controller,
    tapped: false,
    summoningSickness: true,
    damage: 0,
    counters: new Map<string, number>(),
    attachments: [],
    attachedTo: null,
    copyOf: null,
  };
}

export function addLogEntry(state: GameState, entry: Omit<GameLogEntry, 'timestamp'>): GameState {
  const logEntry: GameLogEntry = { ...entry, timestamp: state.timestamp };
  return {
    ...state,
    gameLog: [...state.gameLog, logEntry],
    timestamp: state.timestamp + 1,
  };
}

export function getPermanentsControlledBy(state: GameState, playerIndex: number): Permanent[] {
  return state.battlefield.filter(p => p.controller === playerIndex);
}

export function isCreature(permanent: Permanent): boolean {
  return permanent.card.typeLine.toLowerCase().includes('creature');
}

export function isLand(permanent: Permanent): boolean {
  return permanent.card.typeLine.toLowerCase().includes('land');
}

export function isPlaneswalker(permanent: Permanent): boolean {
  return permanent.card.typeLine.toLowerCase().includes('planeswalker');
}

export function hasKeyword(permanent: Permanent, keyword: string): boolean {
  return permanent.card.keywords.some(k => k.toLowerCase() === keyword.toLowerCase());
}

export function getCommanderTax(state: GameState, playerIndex: number): number {
  const cmd = state.commandZone.find(c => c.instance.owner === playerIndex);
  return cmd ? cmd.castCount * 2 : 0;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```
cd .agents/skills/simulate-game/scripts && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```
git add .agents/skills/simulate-game/scripts/game-state.ts
git commit -m "feat(simulate-game): add game state creation and immutable operations"
```


### Task 5: Mana Resolver

**Files:**
- Create: .agents/skills/simulate-game/scripts/mana-resolver.ts

- [ ] **Step 1: Create mana-resolver.ts**

```typescript
import type { CardData, ManaCost, ManaPool, Permanent } from './types.js';
import { isLand } from './game-state.js';

export interface ManaAbility {
  produces: keyof ManaPool;
  source: Permanent;
}

export function getManaAbilities(permanent: Permanent): ManaAbility[] {
  if (!isLand(permanent)) return [];
  if (permanent.tapped) return [];

  const name = permanent.card.name;
  const typeLine = permanent.card.typeLine.toLowerCase();

  if (typeLine.includes('basic')) {
    if (typeLine.includes('plains')) return [{ produces: 'white', source: permanent }];
    if (typeLine.includes('island')) return [{ produces: 'blue', source: permanent }];
    if (typeLine.includes('swamp')) return [{ produces: 'black', source: permanent }];
    if (typeLine.includes('mountain')) return [{ produces: 'red', source: permanent }];
    if (typeLine.includes('forest')) return [{ produces: 'green', source: permanent }];
  }

  if (name === 'Sol Ring') {
    return [
      { produces: 'colorless', source: permanent },
      { produces: 'colorless', source: permanent },
    ];
  }

  if (name === 'Command Tower') {
    const colors = permanent.card.colorIdentity;
    if (colors.length > 0) {
      const colorMap: Record<string, keyof ManaPool> = {
        W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green',
      };
      return colors.map(c => ({ produces: colorMap[c] || 'colorless', source: permanent }));
    }
    return [{ produces: 'colorless', source: permanent }];
  }

  if (name === 'Arcane Signet') {
    return [{ produces: 'colorless', source: permanent }];
  }

  if (typeLine.includes('land')) {
    return [{ produces: 'colorless', source: permanent }];
  }

  return [];
}

export function getAvailableMana(permanents: Permanent[]): ManaAbility[] {
  return permanents.flatMap(p => getManaAbilities(p));
}

export function calculateAvailableManaPool(abilities: ManaAbility[]): ManaPool {
  const pool: ManaPool = { white: 0, blue: 0, black: 0, red: 0, green: 0, colorless: 0 };
  for (const ability of abilities) {
    pool[ability.produces]++;
  }
  return pool;
}

export function getTotalManaCost(cost: ManaCost): number {
  return cost.white + cost.blue + cost.black + cost.red + cost.green + cost.colorless;
}

export function canAffordSpell(
  card: CardData,
  manaPool: ManaPool,
  availableManaAbilities: ManaAbility[],
  commanderTax: number
): boolean {
  const totalCost = { ...card.manaCost };
  totalCost.colorless += commanderTax;

  const availablePool = calculateAvailableManaPool(availableManaAbilities);
  const combined: ManaPool = {
    white: manaPool.white + availablePool.white,
    blue: manaPool.blue + availablePool.blue,
    black: manaPool.black + availablePool.black,
    red: manaPool.red + availablePool.red,
    green: manaPool.green + availablePool.green,
    colorless: manaPool.colorless + availablePool.colorless,
  };

  if (combined.white < totalCost.white) return false;
  if (combined.blue < totalCost.blue) return false;
  if (combined.black < totalCost.black) return false;
  if (combined.red < totalCost.red) return false;
  if (combined.green < totalCost.green) return false;

  const totalNeeded = getTotalManaCost(totalCost);
  const totalAvailable = combined.white + combined.blue + combined.black +
    combined.red + combined.green + combined.colorless;

  return totalAvailable >= totalNeeded;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```
cd .agents/skills/simulate-game/scripts && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```
git add .agents/skills/simulate-game/scripts/mana-resolver.ts
git commit -m "feat(simulate-game): add mana resolver with ability parsing and cost checking"
```

---

### Task 6: State-Based Actions

**Files:**
- Create: .agents/skills/simulate-game/scripts/state-based-actions.ts

- [ ] **Step 1: Create state-based-actions.ts**

```typescript
import type { GameState, Permanent } from './types.js';
import { isCreature, isPlaneswalker, addLogEntry } from './game-state.js';

export interface SBAResult {
  state: GameState;
  creaturesDied: Permanent[];
  playersLost: number[];
  gameEnded: boolean;
}

export function checkStateBasedActions(state: GameState): SBAResult {
  let currentState = state;
  const creaturesDied: Permanent[] = [];
  const playersLost: number[] = [];
  let gameEnded = false;

  let changed = true;
  while (changed) {
    changed = false;

    // Creatures with toughness <= 0 or damage >= toughness die
    for (const permanent of [...currentState.battlefield]) {
      if (!isCreature(permanent)) continue;
      const toughness = permanent.card.toughness;
      if (toughness === null) continue;

      const plusCounters = permanent.counters.get('+1/+1') || 0;
      const minusCounters = permanent.counters.get('-1/-1') || 0;
      const effectiveToughness = toughness + plusCounters - minusCounters;

      if (effectiveToughness <= 0 || permanent.damage >= effectiveToughness) {
        creaturesDied.push(permanent);
        currentState = movePermanentToGraveyard(currentState, permanent);
        currentState = addLogEntry(currentState, {
          turn: currentState.turn,
          player: permanent.controller,
          phase: currentState.step,
          action: 'dies',
          card: permanent.card.name,
          details: ${permanent.card.name} dies (toughness: , damage: ),
        });
        changed = true;
      }
    }

    // Planeswalkers with 0 loyalty die
    for (const permanent of [...currentState.battlefield]) {
      if (!isPlaneswalker(permanent)) continue;
      const loyalty = permanent.counters.get('loyalty') ?? permanent.card.loyalty;
      if (loyalty !== null && loyalty <= 0) {
        creaturesDied.push(permanent);
        currentState = movePermanentToGraveyard(currentState, permanent);
        currentState = addLogEntry(currentState, {
          turn: currentState.turn,
          player: permanent.controller,
          phase: currentState.step,
          action: 'dies',
          card: permanent.card.name,
          details: ${permanent.card.name} dies (0 loyalty),
        });
        changed = true;
      }
    }

    // Players with 0 life lose
    for (const player of currentState.players) {
      if (player.life <= 0 && !playersLost.includes(player.index)) {
        playersLost.push(player.index);
        currentState = addLogEntry(currentState, {
          turn: currentState.turn,
          player: player.index,
          phase: currentState.step,
          action: 'loses',
          details: Player  loses (0 life),
        });
        changed = true;
      }
    }

    // Commander damage >= 21 = loss
    for (const player of currentState.players) {
      if (playersLost.includes(player.index)) continue;
      for (const [cmdName, damage] of player.commanderDamage) {
        if (damage >= 21) {
          playersLost.push(player.index);
          currentState = addLogEntry(currentState, {
            turn: currentState.turn,
            player: player.index,
            phase: currentState.step,
            action: 'loses',
            details: Player  loses (commander damage from : ),
          });
          changed = true;
        }
      }
    }

    // Poison counters >= 10 = loss
    for (const player of currentState.players) {
      if (playersLost.includes(player.index)) continue;
      if (player.poisonCounters >= 10) {
        playersLost.push(player.index);
        currentState = addLogEntry(currentState, {
          turn: currentState.turn,
          player: player.index,
          phase: currentState.step,
          action: 'loses',
          details: Player  loses (poison counters: ),
        });
        changed = true;
      }
    }
  }

  const alivePlayers = currentState.players.filter(p => !playersLost.includes(p.index));
  if (alivePlayers.length <= 1) {
    gameEnded = true;
    currentState = {
      ...currentState,
      gameOver: true,
      winner: alivePlayers.length === 1 ? alivePlayers[0].index : null,
    };
  }

  return { state: currentState, creaturesDied, playersLost, gameEnded };
}

function movePermanentToGraveyard(state: GameState, permanent: Permanent): GameState {
  const newBattlefield = state.battlefield.filter(p => p.id !== permanent.id);

  const isCommander = state.commandZone.some(
    c => c.instance.card.scryfallId === permanent.card.scryfallId
  );

  if (isCommander) {
    // Commander returns to command zone
    return { ...state, battlefield: newBattlefield, timestamp: state.timestamp + 1 };
  }

  const cardInstance = {
    id: permanent.id,
    card: permanent.card,
    owner: permanent.owner,
    zone: 'graveyard' as const,
  };

  const player = state.players[permanent.owner];
  const newPlayer = {
    ...player,
    graveyard: [...player.graveyard, cardInstance],
  };

  const newPlayers = [...state.players];
  newPlayers[permanent.owner] = newPlayer;

  return { ...state, battlefield: newBattlefield, players: newPlayers, timestamp: state.timestamp + 1 };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```
cd .agents/skills/simulate-game/scripts && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```
git add .agents/skills/simulate-game/scripts/state-based-actions.ts
git commit -m "feat(simulate-game): add state-based actions checker"
```


### Task 7: Action Validator

**Files:**
- Create: .agents/skills/simulate-game/scripts/action-validator.ts

- [ ] **Step 1: Create action-validator.ts**

```typescript
import type { GameState, CardInstance, LegalActions, GameAction, ValidationResult } from './types.js';
import { getPermanentsControlledBy, isLand, isCreature, getCommanderTax } from './game-state.js';
import { canAffordSpell, getAvailableMana } from './mana-resolver.js';

export function getLegalActions(state: GameState): LegalActions {
  const player = state.players[state.activePlayerIndex];
  const controlledPermanents = getPermanentsControlledBy(state, state.activePlayerIndex);
  const untappedLands = controlledPermanents.filter(p => isLand(p) && !p.tapped);
  const manaAbilities = getAvailableMana(untappedLands);

  const castableSpells = player.hand.filter(card => {
    if (isLandCard(card)) return false;
    return canAffordSpell(
      card.card,
      player.manaPool,
      manaAbilities,
      getCommanderTax(state, state.activePlayerIndex)
    );
  });

  const playableLands = player.landPlaysRemaining > 0
    ? player.hand.filter(card => isLandCard(card))
    : [];

  const activatableAbilities = untappedLands;

  const canAttack = controlledPermanents.filter(
    p => isCreature(p) && !p.tapped && !p.summoningSickness
  );

  const canBlock = controlledPermanents.filter(
    p => isCreature(p) && !p.tapped
  );

  return {
    castableSpells,
    playableLands,
    activatableAbilities,
    canAttack,
    canBlock,
    canPass: true,
    canRespond: state.stack.length > 0,
  };
}

function isLandCard(card: CardInstance): boolean {
  return card.card.typeLine.toLowerCase().includes('land');
}

export function validateAction(state: GameState, action: GameAction): ValidationResult {
  const legal = getLegalActions(state);
  const player = state.players[state.activePlayerIndex];

  switch (action.type) {
    case 'cast': {
      if (!action.cardId) return { legal: false, reason: 'No card ID specified for cast action' };
      const card = player.hand.find(c => c.id === action.cardId);
      if (!card) return { legal: false, reason: Card  not in hand };
      if (!legal.castableSpells.some(c => c.id === action.cardId)) {
        return { legal: false, reason: Cannot cast  - insufficient mana or restrictions };
      }
      return { legal: true };
    }

    case 'play_land': {
      if (!action.cardId) return { legal: false, reason: 'No card ID specified for play_land action' };
      const card = player.hand.find(c => c.id === action.cardId);
      if (!card) return { legal: false, reason: Card  not in hand };
      if (!isLandCard(card)) return { legal: false, reason: ${card.card.name} is not a land };
      if (player.landPlaysRemaining <= 0) return { legal: false, reason: 'No land plays remaining this turn' };
      return { legal: true };
    }

    case 'activate': {
      if (!action.permanentId) return { legal: false, reason: 'No permanent ID specified for activate action' };
      const permanent = state.battlefield.find(p => p.id === action.permanentId);
      if (!permanent) return { legal: false, reason: Permanent  not on battlefield };
      if (permanent.tapped) return { legal: false, reason: ${permanent.card.name} is tapped };
      if (!legal.activatableAbilities.some(p => p.id === action.permanentId)) {
        return { legal: false, reason: Cannot activate  };
      }
      return { legal: true };
    }

    case 'attack': {
      if (!action.attackers || Object.keys(action.attackers).length === 0) {
        return { legal: false, reason: 'No attackers specified' };
      }
      for (const attackerId of Object.keys(action.attackers)) {
        const attacker = state.battlefield.find(p => p.id === attackerId);
        if (!attacker) return { legal: false, reason: Attacker  not on battlefield };
        if (!legal.canAttack.some(p => p.id === attackerId)) {
          return { legal: false, reason: ${attacker.card.name} cannot attack };
        }
      }
      return { legal: true };
    }

    case 'block': {
      if (!action.blockers || Object.keys(action.blockers).length === 0) {
        return { legal: false, reason: 'No blockers specified' };
      }
      for (const blockerId of Object.keys(action.blockers)) {
        const blocker = state.battlefield.find(p => p.id === blockerId);
        if (!blocker) return { legal: false, reason: Blocker  not on battlefield };
        if (!legal.canBlock.some(p => p.id === blockerId)) {
          return { legal: false, reason: ${blocker.card.name} cannot block };
        }
      }
      return { legal: true };
    }

    case 'pass':
      return { legal: true };

    case 'respond':
      if (state.stack.length === 0) return { legal: false, reason: 'Nothing on the stack to respond to' };
      return { legal: true };

    default:
      return { legal: false, reason: Unknown action type:  };
  }
}

export function hasActionsAvailable(state: GameState): boolean {
  const legal = getLegalActions(state);
  return legal.castableSpells.length > 0 ||
    legal.playableLands.length > 0 ||
    legal.activatableAbilities.length > 0 ||
    legal.canAttack.length > 0 ||
    legal.canBlock.length > 0;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```
cd .agents/skills/simulate-game/scripts && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```
git add .agents/skills/simulate-game/scripts/action-validator.ts
git commit -m "feat(simulate-game): add action validator with legal action computation"
```

---

### Task 8: Combat Resolver

**Files:**
- Create: .agents/skills/simulate-game/scripts/combat-resolver.ts

- [ ] **Step 1: Create combat-resolver.ts**

```typescript
import type { GameState, Target } from './types.js';
import { addLogEntry, hasKeyword } from './game-state.js';

export interface CombatAssignment {
  attackerId: string;
  target: Target;
}

export interface BlockAssignment {
  blockerId: string;
  attackerId: string;
}

export interface CombatResult {
  state: GameState;
  damageDealt: Map<string, number>;
  playerDamage: Map<number, number>;
}

export function declareAttackers(
  state: GameState,
  assignments: CombatAssignment[]
): GameState {
  let currentState = state;

  for (const assignment of assignments) {
    const attacker = currentState.battlefield.find(p => p.id === assignment.attackerId);
    if (!attacker) continue;

    if (!hasKeyword(attacker, 'Vigilance')) {
      const newBattlefield = currentState.battlefield.map(p =>
        p.id === assignment.attackerId ? { ...p, tapped: true } : p
      );
      currentState = { ...currentState, battlefield: newBattlefield, timestamp: currentState.timestamp + 1 };
    }

    currentState = addLogEntry(currentState, {
      turn: currentState.turn,
      player: currentState.activePlayerIndex,
      phase: 'declare_attackers',
      action: 'attacks',
      card: attacker.card.name,
      details: ${attacker.card.name} attacks  ,
    });
  }

  return currentState;
}

export function declareBlockers(
  state: GameState,
  blocks: BlockAssignment[]
): GameState {
  let currentState = state;

  for (const block of blocks) {
    const blocker = currentState.battlefield.find(p => p.id === block.blockerId);
    if (!blocker) continue;

    currentState = addLogEntry(currentState, {
      turn: currentState.turn,
      player: blocker.controller,
      phase: 'declare_blockers',
      action: 'blocks',
      card: blocker.card.name,
      details: ${blocker.card.name} blocks,
    });
  }

  return currentState;
}

export function resolveCombatDamage(
  state: GameState,
  attackers: CombatAssignment[],
  blocks: BlockAssignment[]
): CombatResult {
  let currentState = state;
  const damageDealt = new Map<string, number>();
  const playerDamage = new Map<number, number>();

  const attackerBlockers = new Map<string, string[]>();
  for (const block of blocks) {
    const existing = attackerBlockers.get(block.attackerId) || [];
    existing.push(block.blockerId);
    attackerBlockers.set(block.attackerId, existing);
  }

  // First strike damage
  const firstStrikers = attackers.filter(a => {
    const attacker = currentState.battlefield.find(p => p.id === a.attackerId);
    return attacker && hasKeyword(attacker, 'First Strike');
  });

  if (firstStrikers.length > 0) {
    currentState = dealDamage(currentState, firstStrikers, attackerBlockers, damageDealt, playerDamage);
  }

  // Regular damage (non-first-strikers)
  const regularAttackers = attackers.filter(a => {
    const attacker = currentState.battlefield.find(p => p.id === a.attackerId);
    return attacker && !hasKeyword(attacker, 'First Strike');
  });

  if (regularAttackers.length > 0) {
    currentState = dealDamage(currentState, regularAttackers, attackerBlockers, damageDealt, playerDamage);
  }

  return { state: currentState, damageDealt, playerDamage };
}

function dealDamage(
  state: GameState,
  attackers: CombatAssignment[],
  attackerBlockers: Map<string, string[]>,
  damageDealt: Map<string, number>,
  playerDamage: Map<number, number>
): GameState {
  let currentState = state;

  for (const assignment of attackers) {
    const attacker = currentState.battlefield.find(p => p.id === assignment.attackerId);
    if (!attacker) continue;

    const power = attacker.card.power ?? 0;
    const plusCounters = attacker.counters.get('+1/+1') || 0;
    const minusCounters = attacker.counters.get('-1/-1') || 0;
    const effectivePower = Math.max(0, power + plusCounters - minusCounters);

    const blockerIds = attackerBlockers.get(assignment.attackerId) || [];

    if (blockerIds.length > 0) {
      const damagePerBlocker = Math.floor(effectivePower / blockerIds.length);
      let remainingDamage = effectivePower;

      for (let i = 0; i < blockerIds.length; i++) {
        const blocker = currentState.battlefield.find(p => p.id === blockerIds[i]);
        if (!blocker) continue;

        const dmg = i === blockerIds.length - 1 ? remainingDamage : damagePerBlocker;
        remainingDamage -= dmg;

        // Apply damage to blocker
        const newBattlefield = currentState.battlefield.map(p =>
          p.id === blockerIds[i] ? { ...p, damage: p.damage + dmg } : p
        );
        currentState = { ...currentState, battlefield: newBattlefield, timestamp: currentState.timestamp + 1 };

        // Apply damage to attacker from blocker
        const blockerPower = Math.max(0, (blocker.card.power ?? 0) + (blocker.counters.get('+1/+1') || 0) - (blocker.counters.get('-1/-1') || 0));

        const newBattlefield2 = currentState.battlefield.map(p =>
          p.id === assignment.attackerId ? { ...p, damage: p.damage + blockerPower } : p
        );
        currentState = { ...currentState, battlefield: newBattlefield2, timestamp: currentState.timestamp + 1 };

        damageDealt.set(attacker.id, (damageDealt.get(attacker.id) || 0) + dmg);
        damageDealt.set(blocker.id, (damageDealt.get(blocker.id) || 0) + blockerPower);

        currentState = addLogEntry(currentState, {
          turn: currentState.turn,
          player: attacker.controller,
          phase: 'combat_damage',
          action: 'deals_damage',
          card: attacker.card.name,
          details: ${attacker.card.name} deals  damage to , takes  damage back,
        });
      }
    } else {
      // Unblocked - damage to target
      if (assignment.target.type === 'player') {
        const targetIndex = parseInt(assignment.target.id, 10);
        const newPlayers = [...currentState.players];
        newPlayers[targetIndex] = {
          ...newPlayers[targetIndex],
          life: newPlayers[targetIndex].life - effectivePower,
        };
        currentState = { ...currentState, players: newPlayers, timestamp: currentState.timestamp + 1 };

        playerDamage.set(targetIndex, (playerDamage.get(targetIndex) || 0) + effectivePower);

        // Track commander damage
        const isCommander = currentState.commandZone.some(
          c => c.instance.card.scryfallId === attacker.card.scryfallId
        );
        if (isCommander) {
          const newPlayers2 = [...currentState.players];
          const existingDmg = newPlayers2[targetIndex].commanderDamage.get(attacker.card.name) || 0;
          newPlayers2[targetIndex] = {
            ...newPlayers2[targetIndex],
            commanderDamage: new Map(newPlayers2[targetIndex].commanderDamage).set(
              attacker.card.name, existingDmg + effectivePower
            ),
          };
          currentState = { ...currentState, players: newPlayers2, timestamp: currentState.timestamp + 1 };
        }

        currentState = addLogEntry(currentState, {
          turn: currentState.turn,
          player: attacker.controller,
          phase: 'combat_damage',
          action: 'deals_damage',
          card: attacker.card.name,
          details: ${attacker.card.name} deals  combat damage to player ,
        });
      }
    }
  }

  return currentState;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```
cd .agents/skills/simulate-game/scripts && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```
git add .agents/skills/simulate-game/scripts/combat-resolver.ts
git commit -m "feat(simulate-game): add combat resolver with damage, blocking, and commander damage"
```

### Task 9: LLM Agent

**Files:**
- Create: .agents/skills/simulate-game/scripts/llm-agent.ts

- [ ] **Step 1: Create llm-agent.ts**

See the full code in the spec at docs/superpowers/specs/2026-05-19-commander-engine-design.md section "LLM Agent & Decision-Making". The implementation must include:

- getLLMClient() — Creates OpenAI client, supports LLM_PROVIDER env var (openai/anthropic)
- getDefaultModel() — Returns model from LLM_MODEL env var or defaults (gpt-4o / claude-sonnet-4-20250514)
- uildGameSummary(state, playerIndex) — Formats game state as text for LLM: hand, creatures, lands, opponents, stack, mana pool
- ormatManaPool(pool) — Formats ManaPool as "2W 1U" style string
- ormatLegalActions(legal) — Formats LegalActions with card IDs for LLM prompt
- getAgentDecision(request) — Sends LLM prompt with system instructions + game state + legal actions, parses JSON response as LLMActionResponse. Max 3 re-prompts on invalid actions.
- getMulliganDecision(hand, deckName, deckStrategy, mulligansTaken) — LLM decides keep/mulligan, returns {keep, reasoning}

Key implementation details:
- System prompt instructs LLM to respond with JSON: { "actions": [...], "reasoning": "..." }
- Action format uses card IDs (not names) for precision
- Temperature 0.7 for gameplay decisions, 0.3 for mulligan decisions
- esponse_format: { type: 'json_object' } for structured output
- Fallback on parse failure: return pass action or default keep

- [ ] **Step 2: Verify TypeScript compiles**

```
cd .agents/skills/simulate-game/scripts && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```
git add .agents/skills/simulate-game/scripts/llm-agent.ts
git commit -m "feat(simulate-game): add LLM agent for gameplay decisions and mulligan"
```

---

### Task 10: Ruling Oracle

**Files:**
- Create: .agents/skills/simulate-game/scripts/ruling-oracle.ts

- [ ] **Step 1: Create ruling-oracle.ts**

The ruling oracle provides LLM fallback for unresolvable MTG interactions. Implementation must include:

- hashInteraction(request) — Creates cache key from card names + rules question
- loadCache() / saveCache(cache) — Read/write uling-cache.json
- getRuling(request) — Checks cache first, then calls LLM with judge system prompt, caches result

Key implementation details:
- Cache file: uling-cache.json in scripts directory
- System prompt: "You are a Magic: The Gathering judge..."
- Response format: { "ruling": "brief ruling", "explanation": "detailed with CR references" }
- Temperature 0.2 for precise rulings
- Same LLM client setup as llm-agent.ts (provider/model from env vars)
- Fallback on parse failure: { ruling: "unable to determine", explanation: "..." }

- [ ] **Step 2: Verify TypeScript compiles**

```
cd .agents/skills/simulate-game/scripts && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```
git add .agents/skills/simulate-game/scripts/ruling-oracle.ts
git commit -m "feat(simulate-game): add ruling oracle with LLM fallback and caching"
```

### Task 11: Game Engine (Core Game Loop)

**Files:**
- Create: .agents/skills/simulate-game/scripts/game-engine.ts

- [ ] **Step 1: Create game-engine.ts**

The core game engine orchestrates the entire game. Implementation must include:

**Constants:**
- MAX_TURNS = 50 — Safety limit to prevent infinite games
- MAX_REPROMPTS = 3 — Max LLM re-prompts on invalid actions

**Main function: unGame(decks: DeckInput[]): Promise<GameResult>**
1. Create initial game state from decks
2. Run mulligan phase (each player draws 7, LLM decides keep/mulligan, Vancouver mulligan rules)
3. Main game loop: while not gameOver and turn <= MAX_TURNS, run turns
4. Build and return GameResult

**Mulligan phase: unMulliganPhase(state, decks)**
- Draw 7 cards for each player
- For each player, ask LLM if they keep (max 3 mulligans)
- On mulligan: put hand back in library, shuffle, draw one fewer card
- Free mulligan on first mulligan in multiplayer (draw same number)

**Turn execution: unTurn(state, decks)**
- Untap step: Untap all permanents controlled by active player, reset landPlaysRemaining to 1, clear summoningSickness
- Upkeep step: Check SBAs
- Draw step: Active player draws 1 card
- Precombat main phase: LLM agent makes decisions (cast spells, play lands, activate abilities), validate each action, execute, check SBAs after each
- Combat phase: LLM chooses attackers, opponents choose blockers, resolve combat damage, check SBAs
- Postcombat main phase: Same as precombat main
- End step: Empty mana pools, check SBAs
- Advance to next player

**Action execution: executeAction(state, action, decks)**
- cast: Remove card from hand, pay mana cost, put spell on stack, resolve immediately for sorceries/instants (v1 simplification), put permanent on battlefield
- play_land: Remove card from hand, put on battlefield as Permanent, decrement landPlaysRemaining
- ctivate: Tap the permanent, add mana to pool (for mana abilities)
- ttack: Call combat-resolver declareAttackers
- lock: Call combat-resolver declareBlockers + resolveCombatDamage
- pass: Do nothing

**LLM decision loop:**
1. Get legal actions
2. Build game summary
3. Call getAgentDecision
4. Validate each action
5. If invalid, re-prompt with error (max MAX_REPROMPTS, then pass)
6. Execute valid actions
7. Check SBAs after each action

- [ ] **Step 2: Verify TypeScript compiles**

```
cd .agents/skills/simulate-game/scripts && npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```
git add .agents/skills/simulate-game/scripts/game-engine.ts
git commit -m "feat(simulate-game): add core game engine with turn loop and action execution"
```

---

### Task 12: Tournament Runner & Narrative Generator

**Files:**
- Create: .agents/skills/simulate-game/scripts/tournament-runner.ts
- Create: .agents/skills/simulate-game/scripts/narrative-generator.ts

- [ ] **Step 1: Create tournament-runner.ts**

The tournament runner orchestrates multiple games and aggregates statistics. Implementation must include:

**Main function: unTournament(decks: DeckInput[], numGames: number): Promise<TournamentResult>**
1. Generate tournament ID (UUID)
2. For each game (1 to numGames):
   - Randomize seat order (shuffle deck array)
   - Call unGame(decks) 
   - Save per-game result to simulation-games/game-{NNN}.json
   - Track stats per deck (wins, losses, turns survived)
3. Calculate aggregate statistics (winRate, avgTurnsSurvived)
4. Write simulation-results.json with TournamentResult
5. Return TournamentResult

**File output:**
- Create simulation-games/ directory
- Write each game result as JSON
- Write aggregate results as simulation-results.json

- [ ] **Step 2: Create narrative-generator.ts**

The narrative generator creates a human-readable markdown report. Implementation must include:

**Main function: generateNarrativeReport(tournamentResult: TournamentResult, gameResults: GameResult[]): Promise<void>**
1. Build a summary prompt for the LLM with:
   - Tournament statistics (win rates, average turns)
   - Key moments from notable games (closest games, biggest comebacks)
   - Deck performance analysis
2. Call LLM to generate narrative markdown
3. Write to simulation-report.md

**Report structure:**
- Overall standings table
- Per-deck analysis (strengths, weaknesses)
- Notable games highlights
- Commander damage breakdown
- Recommendations for deck improvement

- [ ] **Step 3: Verify TypeScript compiles**

```
cd .agents/skills/simulate-game/scripts && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```
git add .agents/skills/simulate-game/scripts/tournament-runner.ts .agents/skills/simulate-game/scripts/narrative-generator.ts
git commit -m "feat(simulate-game): add tournament runner and narrative generator"
```

---

### Task 13: CLI Entry Point

**Files:**
- Create: .agents/skills/simulate-game/scripts/simulate.ts

- [ ] **Step 1: Create simulate.ts**

The CLI entry point parses arguments and runs the tournament. Implementation must include:

**Argument parsing:**
- --decks <path1> <path2> [<path3>...] — Deck sources (local files or Archidekt URLs)
- --games <N> — Number of games (default: 10)

**Main flow:**
1. Parse CLI arguments
2. For each deck source:
   - If Archidekt URL: call etchDeckFromArchidekt(url)
   - If local file: call loadDeckFromLocalFile(path)
3. Validate at least 2 decks loaded
4. Call unTournament(decks, numGames)
5. Call generateNarrativeReport(tournamentResult, gameResults)
6. Print summary to console

**Console output:**
- Tournament ID
- Games played
- Per-deck win rate
- Report file locations

- [ ] **Step 2: Verify TypeScript compiles**

```
cd .agents/skills/simulate-game/scripts && npx tsc --noEmit
```

- [ ] **Step 3: Test with a dry run (no API keys)**

```
cd .agents/skills/simulate-game/scripts && npx tsx simulate.ts --help
```

Expected: Shows usage information or error about missing decks (proves CLI parsing works)

- [ ] **Step 4: Commit**

```
git add .agents/skills/simulate-game/scripts/simulate.ts
git commit -m "feat(simulate-game): add CLI entry point for tournament simulation"
```
