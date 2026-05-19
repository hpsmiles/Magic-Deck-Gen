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
  x: number;
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
  counters: Record<string, number>;
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
  commanderDamage: Record<string, number>;
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
