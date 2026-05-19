import type {
  CardInstance,
  CommandZoneCard,
  DeckInput,
  GameLogEntry,
  GameState,
  ManaPool,
  Permanent,
  PlayerState,
} from './types.js';

// Module-level counter for generating unique permanent IDs
let nextPermanentId = 0;

/**
 * Creates an empty mana pool with all values set to 0.
 */
export function createEmptyManaPool(): ManaPool {
  return { white: 0, blue: 0, black: 0, red: 0, green: 0, colorless: 0 };
}

/**
 * Fisher-Yates shuffle — returns a new shuffled array.
 */
export function shuffleArray<T>(array: T[]): T[] {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Creates the initial game state from an array of deck inputs.
 * Each player starts with 40 life, an empty mana pool, and a shuffled library.
 * The commander is placed in the command zone.
 */
export function createInitialGameState(decks: DeckInput[]): GameState {
  const players: PlayerState[] = decks.map((deck, index) => {
    // Separate commander from the rest of the cards
    const commander = deck.commander;
    const libraryCards = deck.cards.filter(
      (c) => c.card.scryfallId !== commander.scryfallId
    );

    // Assign owner index and set zone
    const library: CardInstance[] = shuffleArray(
      libraryCards.map((c) => ({
        ...c,
        owner: index,
        zone: 'library' as const,
      }))
    );

    return {
      index,
      life: 40,
      poisonCounters: 0,
      commanderDamage: {},
      manaPool: createEmptyManaPool(),
      hand: [],
      library,
      graveyard: [],
      exile: [],
      mulligansTaken: 0,
      hasDrawnThisTurn: false,
      landPlaysRemaining: 1,
    };
  });

  // Place commanders in the command zone
  const commandZone: CommandZoneCard[] = decks.map((deck, index) => {
    const commanderInstance: CardInstance = {
      id: `commander-${index}`,
      card: deck.commander,
      owner: index,
      zone: 'command',
    };
    return {
      instance: commanderInstance,
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

/**
 * Draws cards from a player's library to their hand.
 * Returns a new GameState (immutable).
 */
export function drawCards(
  state: GameState,
  playerIndex: number,
  count: number
): GameState {
  const player = state.players[playerIndex];
  const actualCount = Math.min(count, player.library.length);
  if (actualCount === 0) return state;

  const drawn = player.library.slice(0, actualCount);
  const remainingLibrary = player.library.slice(actualCount);

  const updatedHand: CardInstance[] = [
    ...player.hand,
    ...drawn.map((c) => ({ ...c, zone: 'hand' as const })),
  ];

  const updatedPlayer: PlayerState = {
    ...player,
    hand: updatedHand,
    library: remainingLibrary,
  };

  const updatedPlayers = [...state.players];
  updatedPlayers[playerIndex] = updatedPlayer;

  return {
    ...state,
    players: updatedPlayers,
    timestamp: state.timestamp + 1,
  };
}

/**
 * Moves a card from a player's hand to their graveyard.
 * Returns a new GameState (immutable).
 */
export function moveCardToGraveyard(
  state: GameState,
  playerIndex: number,
  cardId: string
): GameState {
  const player = state.players[playerIndex];
  const cardIndex = player.hand.findIndex((c) => c.id === cardId);

  if (cardIndex === -1) return state;

  const card = player.hand[cardIndex];
  const updatedHand = [
    ...player.hand.slice(0, cardIndex),
    ...player.hand.slice(cardIndex + 1),
  ];

  const graveyardCard: CardInstance = { ...card, zone: 'graveyard' };
  const updatedGraveyard = [...player.graveyard, graveyardCard];

  const updatedPlayer: PlayerState = {
    ...player,
    hand: updatedHand,
    graveyard: updatedGraveyard,
  };

  const updatedPlayers = [...state.players];
  updatedPlayers[playerIndex] = updatedPlayer;

  return {
    ...state,
    players: updatedPlayers,
    timestamp: state.timestamp + 1,
  };
}

/**
 * Adds mana of a specific color to a mana pool.
 * Returns a new ManaPool (immutable).
 */
export function addManaToPool(
  pool: ManaPool,
  color: keyof ManaPool,
  amount: number
): ManaPool {
  return { ...pool, [color]: pool[color] + amount };
}

/**
 * Returns an empty mana pool (drains the given pool, returning a fresh empty one).
 */
export function emptyManaPool(_pool: ManaPool): ManaPool {
  return createEmptyManaPool();
}

/**
 * Checks if a mana pool can pay a given cost.
 * Excess colored mana can be used to pay for colorless costs.
 */
export function canPayManaCost(
  pool: ManaPool,
  cost: { white: number; blue: number; black: number; red: number; green: number; colorless: number }
): boolean {
  const colors: (keyof ManaPool)[] = ['white', 'blue', 'black', 'red', 'green'];

  let remainingColorless = cost.colorless;
  let poolCopy = { ...pool };

  // Pay colored costs first
  for (const color of colors) {
    const needed = cost[color];
    const available = poolCopy[color];

    if (available < needed) {
      return false;
    }
    poolCopy[color] -= needed;
    // Excess colored mana can pay for colorless
    remainingColorless -= poolCopy[color];
  }

  // Pay remaining colorless with colorless mana
  remainingColorless -= poolCopy.colorless;

  return remainingColorless <= 0;
}

/**
 * Pays a mana cost from a pool. Returns the new pool, or null if the cost cannot be paid.
 * Excess colored mana is used for colorless costs when needed.
 */
export function payManaCost(
  pool: ManaPool,
  cost: { white: number; blue: number; black: number; red: number; green: number; colorless: number }
): ManaPool | null {
  if (!canPayManaCost(pool, cost)) {
    return null;
  }

  const colors: (keyof ManaPool)[] = ['white', 'blue', 'black', 'red', 'green'];
  const result = { ...pool };
  let remainingColorless = cost.colorless;

  // Pay colored costs first, track excess for colorless
  for (const color of colors) {
    const needed = cost[color];
    result[color] -= needed;
    // Excess colored mana can pay for colorless
    const excess = result[color];
    const appliedToColorless = Math.min(excess, remainingColorless);
    result[color] -= appliedToColorless;
    remainingColorless -= appliedToColorless;
  }

  // Pay remaining colorless with generic/colorless mana
  result.colorless -= remainingColorless;

  return result;
}

/**
 * Converts a CardInstance to a Permanent on the battlefield.
 * Summoning sickness is true, counters is an empty Record, no attachments.
 */
export function cardToPermanent(card: CardInstance, controller: number): Permanent {
  const id = `perm-${nextPermanentId++}`;
  return {
    id,
    card: card.card,
    owner: card.owner,
    controller,
    tapped: false,
    summoningSickness: true,
    damage: 0,
    counters: {},
    attachments: [],
    attachedTo: null,
    copyOf: null,
  };
}

/**
 * Adds a log entry to the game state with the current timestamp.
 * Returns a new GameState (immutable).
 */
export function addLogEntry(
  state: GameState,
  entry: Omit<GameLogEntry, 'timestamp'>
): GameState {
  const logEntry: GameLogEntry = {
    ...entry,
    timestamp: state.timestamp,
  };

  return {
    ...state,
    gameLog: [...state.gameLog, logEntry],
    timestamp: state.timestamp + 1,
  };
}

/**
 * Returns all permanents on the battlefield controlled by a specific player.
 */
export function getPermanentsControlledBy(
  state: GameState,
  playerIndex: number
): Permanent[] {
  return state.battlefield.filter((p) => p.controller === playerIndex);
}

/**
 * Checks if a permanent is a creature by examining its type line.
 */
export function isCreature(permanent: Permanent): boolean {
  const typeLine = permanent.card.typeLine.toLowerCase();
  return typeLine.includes('creature');
}

/**
 * Checks if a permanent is a land by examining its type line.
 */
export function isLand(permanent: Permanent): boolean {
  const typeLine = permanent.card.typeLine.toLowerCase();
  return typeLine.includes('land');
}

/**
 * Checks if a permanent is a planeswalker by examining its type line.
 */
export function isPlaneswalker(permanent: Permanent): boolean {
  const typeLine = permanent.card.typeLine.toLowerCase();
  return typeLine.includes('planeswalker');
}

/**
 * Checks if a permanent has a specific keyword.
 */
export function hasKeyword(permanent: Permanent, keyword: string): boolean {
  return permanent.card.keywords.some(
    (k) => k.toLowerCase() === keyword.toLowerCase()
  );
}

/**
 * Returns the commander tax for a player's commander.
 * Commander tax is castCount * 2.
 */
export function getCommanderTax(state: GameState, playerIndex: number): number {
  const commander = state.commandZone.find(
    (cz) => cz.instance.owner === playerIndex
  );
  if (!commander) return 0;
  return commander.castCount * 2;
}
