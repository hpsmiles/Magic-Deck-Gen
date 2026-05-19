import crypto from 'node:crypto';
import type {
  CardInstance,
  CommandZoneCard,
  DeckInput,
  GameAction,
  GameLogEntry,
  GameResult,
  GameStep,
  GameState,
  LegalActions,
  ManaPool,
  Permanent,
  PlayerResult,
  PlayerState,
  Target,
} from './types.js';
import {
  addLogEntry,
  canPayManaCost,
  cardToPermanent,
  createEmptyManaPool,
  createInitialGameState,
  drawCards,
  emptyManaPool,
  getCommanderTax,
  getPermanentsControlledBy,
  isCreature,
  isLand,
  moveCardToGraveyard,
  payManaCost,
  shuffleArray,
} from './game-state.js';
import { getLegalActions, validateAction, hasActionsAvailable } from './action-validator.js';
import { checkStateBasedActions } from './state-based-actions.js';
import type { CombatAssignment, BlockAssignment } from './combat-resolver.js';
import {
  declareAttackers,
  declareBlockers,
  resolveCombatDamage,
} from './combat-resolver.js';
import {
  getAgentDecision,
  getMulliganDecision,
  buildGameSummary,
  formatLegalActions,
} from './llm-agent.js';
import { getAvailableMana, calculateAvailableManaPool, getManaAbilities } from './mana-resolver.js';

// === Constants ===

/** Safety limit to prevent infinite games. */
const MAX_TURNS = 50;

/** Max LLM re-prompts on invalid actions before forcing a pass. */
const MAX_REPROMPTS = 3;

// === Main Entry Point ===

/**
 * Runs a complete Commander game from start to finish.
 *
 * 1. Creates initial game state from decks
 * 2. Runs mulligan phase (Vancouver mulligan rules)
 * 3. Main game loop: turns 1..MAX_TURNS
 * 4. Returns the GameResult
 */
export async function runGame(decks: DeckInput[]): Promise<GameResult> {
  const gameId = crypto.randomUUID();

  // 1. Create initial game state
  let state = createInitialGameState(decks);

  // 2. Mulligan phase
  state = await runMulliganPhase(state, decks);

  // 3. Main game loop
  while (!state.gameOver && state.turn <= MAX_TURNS) {
    state = await runTurn(state, decks);
  }

  // 4. Build result
  return buildGameResult(gameId, state, decks);
}

// === Mulligan Phase ===

/**
 * Runs the mulligan phase for all players.
 *
 * Vancouver mulligan rules:
 * - Each player draws 7 cards
 * - Each player decides whether to keep (max 3 mulligans)
 * - On mulligan: put hand back in library, shuffle, draw one fewer card
 * - Free mulligan on first mulligan in multiplayer (draw same number)
 */
async function runMulliganPhase(
  state: GameState,
  decks: DeckInput[]
): Promise<GameState> {
  let currentState = state;

  // Draw initial 7 for each player
  for (let i = 0; i < currentState.players.length; i++) {
    currentState = drawCards(currentState, i, 7);
  }

  // Each player decides whether to keep
  for (let i = 0; i < currentState.players.length; i++) {
    let mulligansTaken = 0;
    let kept = false;

    while (!kept && mulligansTaken < 3) {
      const player = currentState.players[i];
      const decision = await getMulliganDecision(
        player.hand,
        decks[i].name,
        decks[i].strategy,
        mulligansTaken
      );

      if (decision.keep) {
        kept = true;
        currentState = addLogEntry(currentState, {
          turn: 0,
          player: i,
          phase: 'untap',
          action: 'keep',
          details: `Player ${i} keeps hand (${player.hand.length} cards). ${decision.reasoning}`,
        });
      } else {
        // Mulligan: put hand back in library, shuffle, draw one fewer
        // Free mulligan on first mulligan in multiplayer (3+ players)
        const isFreeMulligan = mulligansTaken === 0 && currentState.players.length >= 3;
        const drawCount = isFreeMulligan ? 7 : 7 - (mulligansTaken + 1);

        // Put hand back in library
        const handCards = player.hand;
        const updatedLibrary = shuffleArray([...handCards, ...player.library]);

        // Update player state: empty hand, shuffled library
        const updatedPlayers = [...currentState.players];
        updatedPlayers[i] = {
          ...player,
          hand: [],
          library: updatedLibrary,
          mulligansTaken: mulligansTaken + 1,
        };
        currentState = {
          ...currentState,
          players: updatedPlayers,
          timestamp: currentState.timestamp + 1,
        };

        // Draw new hand
        currentState = drawCards(currentState, i, drawCount);

        mulligansTaken++;

        currentState = addLogEntry(currentState, {
          turn: 0,
          player: i,
          phase: 'untap',
          action: 'mulligan',
          details: `Player ${i} takes mulligan #${mulligansTaken}${isFreeMulligan ? ' (free)' : ''}, draws ${drawCount} cards. ${decision.reasoning}`,
        });
      }
    }

    // If player still hasn't kept after 3 mulligans, force keep
    if (!kept) {
      currentState = addLogEntry(currentState, {
        turn: 0,
        player: i,
        phase: 'untap',
        action: 'keep',
        details: `Player ${i} forced to keep after 3 mulligans`,
      });
    }
  }

  return currentState;
}

// === Turn Execution ===

/**
 * Runs a single turn for the active player.
 *
 * Steps: Untap → Upkeep → Draw → Precombat Main → Combat → Postcombat Main → End
 */
async function runTurn(
  state: GameState,
  decks: DeckInput[]
): Promise<GameState> {
  let currentState = state;
  const activePlayer = currentState.activePlayerIndex;

  // === Untap Step ===
  currentState = runUntapStep(currentState);

  // === Upkeep Step ===
  currentState = { ...currentState, step: 'upkeep' };
  let sbaResult = checkStateBasedActions(currentState);
  currentState = sbaResult.state;
  if (sbaResult.gameEnded) return currentState;

  // === Draw Step ===
  currentState = { ...currentState, step: 'draw' };
  currentState = drawCards(currentState, activePlayer, 1);
  currentState = {
    ...currentState,
    players: currentState.players.map((p, idx) =>
      idx === activePlayer ? { ...p, hasDrawnThisTurn: true } : p
    ),
  };

  sbaResult = checkStateBasedActions(currentState);
  currentState = sbaResult.state;
  if (sbaResult.gameEnded) return currentState;

  // === Precombat Main Phase ===
  currentState = { ...currentState, phase: 'precombat_main', step: 'main_precombat' };
  currentState = await runMainPhase(currentState, decks);

  sbaResult = checkStateBasedActions(currentState);
  currentState = sbaResult.state;
  if (sbaResult.gameEnded) return currentState;

  // === Combat Phase ===
  currentState = { ...currentState, phase: 'combat', step: 'begin_combat' };
  currentState = await runCombatPhase(currentState, decks);

  sbaResult = checkStateBasedActions(currentState);
  currentState = sbaResult.state;
  if (sbaResult.gameEnded) return currentState;

  // === Postcombat Main Phase ===
  currentState = { ...currentState, phase: 'postcombat_main', step: 'main_postcombat' };
  currentState = await runMainPhase(currentState, decks);

  sbaResult = checkStateBasedActions(currentState);
  currentState = sbaResult.state;
  if (sbaResult.gameEnded) return currentState;

  // === End Step ===
  currentState = runEndStep(currentState);

  // Advance to next player
  currentState = advanceToNextPlayer(currentState);

  return currentState;
}

// === Untap Step ===

/**
 * Untap step: Untap all permanents controlled by active player,
 * reset landPlaysRemaining to 1, clear summoningSickness.
 */
function runUntapStep(state: GameState): GameState {
  const activePlayer = state.activePlayerIndex;

  // Untap all permanents controlled by active player
  const updatedBattlefield = state.battlefield.map((p) =>
    p.controller === activePlayer
      ? { ...p, tapped: false, summoningSickness: false }
      : p
  );

  // Reset landPlaysRemaining and hasDrawnThisTurn
  const updatedPlayers = state.players.map((p, idx) =>
    idx === activePlayer
      ? { ...p, landPlaysRemaining: 1, hasDrawnThisTurn: false }
      : p
  );

  return {
    ...state,
    step: 'untap',
    battlefield: updatedBattlefield,
    players: updatedPlayers,
    timestamp: state.timestamp + 1,
  };
}

// === Main Phase ===

/**
 * Runs a main phase where the active player can cast spells, play lands,
 * and activate abilities via the LLM decision loop.
 */
async function runMainPhase(
  state: GameState,
  decks: DeckInput[]
): Promise<GameState> {
  let currentState = state;
  let passed = false;
  let repromptCount = 0;

  while (!passed && !currentState.gameOver) {
    // Check if there are any actions available
    if (!hasActionsAvailable(currentState)) {
      break;
    }

    // Get LLM decision
    const legalActions = getLegalActions(currentState);
    const activePlayer = currentState.activePlayerIndex;
    const deck = decks[activePlayer];

    const recentActions = currentState.gameLog.slice(-10);

    const request = {
      playerIndex: activePlayer,
      deckName: deck.name,
      deckStrategy: deck.strategy,
      gameSummary: buildGameSummary(currentState, activePlayer),
      legalActions,
      recentActions,
      phase: currentState.step,
      turn: currentState.turn,
    };

    const response = await getAgentDecision(request);

    // Process each action from the LLM response
    let allActionsInvalid = true;

    for (const action of response.actions) {
      if (action.type === 'pass') {
        passed = true;
        allActionsInvalid = false;
        currentState = addLogEntry(currentState, {
          turn: currentState.turn,
          player: activePlayer,
          phase: currentState.step,
          action: 'pass',
          details: `Player ${activePlayer} passes. ${response.reasoning}`,
        });
        break;
      }

      // Validate the action
      const validation = validateAction(currentState, action);

      if (!validation.legal) {
        // Log invalid action and continue to next action
        currentState = addLogEntry(currentState, {
          turn: currentState.turn,
          player: activePlayer,
          phase: currentState.step,
          action: 'invalid_action',
          details: `Invalid action: ${validation.reason}.`,
        });
        continue;
      }

      allActionsInvalid = false;

      // Execute the valid action
      currentState = executeAction(currentState, action, decks);

      // Check SBAs after each action
      const sbaResult = checkStateBasedActions(currentState);
      currentState = sbaResult.state;
      if (sbaResult.gameEnded) return currentState;
    }

    // If all actions were invalid, re-prompt up to MAX_REPROMPTS times
    if (allActionsInvalid && !passed) {
      repromptCount++;
      if (repromptCount >= MAX_REPROMPTS) {
        // Force pass after exhausting re-prompts
        passed = true;
        currentState = addLogEntry(currentState, {
          turn: currentState.turn,
          player: activePlayer,
          phase: currentState.step,
          action: 'pass',
          details: `Player ${activePlayer} forced to pass (all actions invalid after ${MAX_REPROMPTS} re-prompts).`,
        });
      } else {
        currentState = addLogEntry(currentState, {
          turn: currentState.turn,
          player: activePlayer,
          phase: currentState.step,
          action: 'reprompt',
          details: `Re-prompting player ${activePlayer} (attempt ${repromptCount}/${MAX_REPROMPTS}).`,
        });
      }
    } else {
      // Reset reprompt counter on successful action or pass
      repromptCount = 0;
    }
  }

  return currentState;
}

// === Combat Phase ===

/**
 * Runs the combat phase: declare attackers → declare blockers → resolve damage.
 */
async function runCombatPhase(
  state: GameState,
  decks: DeckInput[]
): Promise<GameState> {
  let currentState = state;
  const activePlayer = currentState.activePlayerIndex;

  // === Declare Attackers ===
  currentState = { ...currentState, step: 'declare_attackers' };

  const legalActions = getLegalActions(currentState);

  if (legalActions.canAttack.length > 0) {
    // Ask LLM for attack decisions
    const deck = decks[activePlayer];
    const recentActions = currentState.gameLog.slice(-10);

    const request = {
      playerIndex: activePlayer,
      deckName: deck.name,
      deckStrategy: deck.strategy,
      gameSummary: buildGameSummary(currentState, activePlayer),
      legalActions,
      recentActions,
      phase: 'declare_attackers' as GameStep,
      turn: currentState.turn,
    };

    const response = await getAgentDecision(request);

    for (const action of response.actions) {
      if (action.type === 'attack' && action.attackers) {
        const validation = validateAction(currentState, action);
        if (validation.legal) {
          // Convert attackers map to CombatAssignment[]
          const assignments: CombatAssignment[] = Object.entries(action.attackers).map(
            ([attackerId, target]) => ({
              attackerId,
              target,
            })
          );

          currentState = declareAttackers(currentState, assignments);
        }
      } else if (action.type === 'pass') {
        // No attacks this turn
        break;
      }
    }
  }

  // Check if any attackers were declared
  const attackingPermanents = currentState.battlefield.filter(
    (p) => p.controller === activePlayer && p.tapped && isCreature(p)
  );

  // If no attackers, skip the rest of combat
  if (attackingPermanents.length === 0) {
    return currentState;
  }

  // === Declare Blockers ===
  currentState = { ...currentState, step: 'declare_blockers' };

  // Collect all attacker IDs that are attacking (tapped creatures that attacked this turn)
  // We need to track which creatures attacked. For v1, we use the tapped+creature heuristic.
  // A more robust approach would track combat assignments in state, but this works for v1.

  // For each non-active player, ask for block decisions
  const allBlocks: BlockAssignment[] = [];

  for (let i = 0; i < currentState.players.length; i++) {
    if (i === activePlayer) continue;

    // Check if this player has blockers available
    const defenderLegalActions = getLegalActions({
      ...currentState,
      activePlayerIndex: i, // Temporarily set for legal action computation
    });

    if (defenderLegalActions.canBlock.length === 0) continue;

    const deck = decks[i];
    const recentActions = currentState.gameLog.slice(-10);

    const request = {
      playerIndex: i,
      deckName: deck.name,
      deckStrategy: deck.strategy,
      gameSummary: buildGameSummary(currentState, i),
      legalActions: defenderLegalActions,
      recentActions,
      phase: 'declare_blockers' as GameStep,
      turn: currentState.turn,
    };

    const response = await getAgentDecision(request);

    for (const action of response.actions) {
      if (action.type === 'block' && action.blockers) {
        // Convert blockers map to BlockAssignment[]
        // blockers format: { blockerId: attackerId[] }
        for (const [blockerId, attackerIds] of Object.entries(action.blockers)) {
          for (const attackerId of attackerIds) {
            allBlocks.push({ blockerId, attackerId });
          }
        }
      }
    }
  }

  // Apply block declarations
  if (allBlocks.length > 0) {
    currentState = declareBlockers(currentState, allBlocks);
  }

  // === Resolve Combat Damage ===
  currentState = { ...currentState, step: 'combat_damage' };

  // Reconstruct combat assignments for damage resolution
  // We need to know which attackers attacked which targets
  // For v1, we reconstruct from the game log
  const combatAssignments = reconstructCombatAssignments(currentState, activePlayer);

  const combatResult = resolveCombatDamage(currentState, combatAssignments, allBlocks);
  currentState = combatResult.state;

  // Check SBAs after combat damage
  const sbaResult = checkStateBasedActions(currentState);
  currentState = sbaResult.state;

  // === End Combat ===
  currentState = { ...currentState, step: 'end_combat' };

  return currentState;
}

/**
 * Reconstructs combat assignments from the current game state.
 * For v1, we assume all tapped creatures of the active player attacked
 * and they attacked the next player (round-robin).
 */
function reconstructCombatAssignments(
  state: GameState,
  activePlayer: number
): CombatAssignment[] {
  const assignments: CombatAssignment[] = [];
  const tappedCreatures = state.battlefield.filter(
    (p) => p.controller === activePlayer && p.tapped && isCreature(p)
  );

  // Determine default attack target (next player)
  const opponentIndices = state.players
    .map((p) => p.index)
    .filter((idx) => idx !== activePlayer);

  for (const creature of tappedCreatures) {
    // Default target: first opponent
    const targetPlayer = opponentIndices[0] ?? 0;
    const target: Target = { type: 'player', id: String(targetPlayer) };
    assignments.push({ attackerId: creature.id, target });
  }

  return assignments;
}

// === End Step ===

/**
 * End step: Empty mana pools, check SBAs.
 */
function runEndStep(state: GameState): GameState {
  let currentState: GameState = { ...state, phase: 'ending', step: 'end_step' };

  // Empty all mana pools
  const updatedPlayers = currentState.players.map((p) => ({
    ...p,
    manaPool: emptyManaPool(p.manaPool),
  }));

  currentState = {
    ...currentState,
    players: updatedPlayers,
    timestamp: currentState.timestamp + 1,
  };

  // Check SBAs
  const sbaResult = checkStateBasedActions(currentState);
  currentState = sbaResult.state;

  // Cleanup step
  currentState = { ...currentState, step: 'cleanup' } as GameState;

  return currentState;
}

// === Turn Advancement ===

/**
 * Advances to the next player's turn.
 * Wraps back to player 0 and increments the turn counter.
 */
function advanceToNextPlayer(state: GameState): GameState {
  const totalPlayers = state.players.length;
  let nextPlayer = state.activePlayerIndex;

  // Find next living player
  for (let i = 0; i < totalPlayers; i++) {
    nextPlayer = (nextPlayer + 1) % totalPlayers;
    // In v1, all players are considered alive unless gameEnded
    break;
  }

  const newTurn = nextPlayer === 0 ? state.turn + 1 : state.turn;

  return {
    ...state,
    turn: newTurn,
    activePlayerIndex: nextPlayer,
    phase: 'beginning',
    step: 'untap',
    timestamp: state.timestamp + 1,
  };
}

// === Action Execution ===

/**
 * Executes a validated game action and returns the new state.
 */
function executeAction(
  state: GameState,
  action: GameAction,
  decks: DeckInput[]
): GameState {
  switch (action.type) {
    case 'cast':
      return executeCast(state, action, decks);
    case 'play_land':
      return executePlayLand(state, action);
    case 'activate':
      return executeActivate(state, action);
    case 'attack':
      // Attack is handled in the combat phase, not here
      return state;
    case 'block':
      // Block is handled in the combat phase, not here
      return state;
    case 'pass':
      return state;
    default:
      return state;
  }
}

/**
 * Executes a cast action:
 * 1. Remove card from hand
 * 2. Pay mana cost (including commander tax)
 * 3. For sorceries/instants: resolve immediately, move to graveyard
 * 4. For permanents: put on battlefield
 */
function executeCast(
  state: GameState,
  action: GameAction,
  decks: DeckInput[]
): GameState {
  if (!action.cardId) return state;

  const activePlayer = state.activePlayerIndex;
  const player = state.players[activePlayer];
  const cardIndex = player.hand.findIndex((c) => c.id === action.cardId);
  if (cardIndex === -1) return state;

  const card = player.hand[cardIndex];
  const typeLine = card.card.typeLine.toLowerCase();

  // Calculate total mana cost including commander tax
  const commanderTax = getCommanderTax(state, activePlayer);
  const totalCost = {
    white: card.card.manaCost.white,
    blue: card.card.manaCost.blue,
    black: card.card.manaCost.black,
    red: card.card.manaCost.red,
    green: card.card.manaCost.green,
    colorless: card.card.manaCost.colorless + commanderTax,
  };

  // Pay mana cost
  const newPool = payManaCost(player.manaPool, totalCost);
  if (newPool === null) return state; // Should not happen if validation passed

  // Remove card from hand
  const updatedHand = [
    ...player.hand.slice(0, cardIndex),
    ...player.hand.slice(cardIndex + 1),
  ];

  // Update player's mana pool
  let currentState: GameState = {
    ...state,
    players: state.players.map((p, idx) =>
      idx === activePlayer
        ? { ...p, hand: updatedHand, manaPool: newPool }
        : p
    ),
    timestamp: state.timestamp + 1,
  };

  // If casting from command zone, increment castCount
  const commanderEntry = currentState.commandZone.find(
    (cz) => cz.instance.owner === activePlayer && cz.instance.card.scryfallId === card.card.scryfallId
  );
  if (commanderEntry) {
    currentState = {
      ...currentState,
      commandZone: currentState.commandZone.map((cz) =>
        cz.instance.owner === activePlayer && cz.instance.card.scryfallId === card.card.scryfallId
          ? { ...cz, castCount: cz.castCount + 1 }
          : cz
      ),
    };
  }

  // Determine card type and resolve
  if (typeLine.includes('creature') || typeLine.includes('artifact') ||
      typeLine.includes('enchantment') || typeLine.includes('planeswalker') ||
      typeLine.includes('land')) {
    // Permanent spell: put on battlefield
    const permanent = cardToPermanent(card, activePlayer);
    currentState = {
      ...currentState,
      battlefield: [...currentState.battlefield, permanent],
    };

    currentState = addLogEntry(currentState, {
      turn: currentState.turn,
      player: activePlayer,
      phase: currentState.step,
      action: 'cast',
      card: card.card.name,
      details: `Player ${activePlayer} casts ${card.card.name}`,
    });
  } else {
    // Sorcery/Instant: resolve immediately (v1 simplification), move to graveyard
    currentState = {
      ...currentState,
      players: currentState.players.map((p, idx) =>
        idx === activePlayer
          ? {
              ...p,
              graveyard: [...p.graveyard, { ...card, zone: 'graveyard' as const }],
            }
          : p
      ),
    };

    currentState = addLogEntry(currentState, {
      turn: currentState.turn,
      player: activePlayer,
      phase: currentState.step,
      action: 'cast',
      card: card.card.name,
      details: `Player ${activePlayer} casts ${card.card.name} (resolved immediately)`,
    });
  }

  return currentState;
}

/**
 * Executes a play_land action:
 * 1. Remove card from hand
 * 2. Put on battlefield as Permanent
 * 3. Decrement landPlaysRemaining
 */
function executePlayLand(state: GameState, action: GameAction): GameState {
  if (!action.cardId) return state;

  const activePlayer = state.activePlayerIndex;
  const player = state.players[activePlayer];
  const cardIndex = player.hand.findIndex((c) => c.id === action.cardId);
  if (cardIndex === -1) return state;

  const card = player.hand[cardIndex];

  // Remove card from hand
  const updatedHand = [
    ...player.hand.slice(0, cardIndex),
    ...player.hand.slice(cardIndex + 1),
  ];

  // Create permanent
  const permanent = cardToPermanent(card, activePlayer);
  // Lands don't have summoning sickness
  const landPermanent = { ...permanent, summoningSickness: false };

  // Update state
  let currentState: GameState = {
    ...state,
    players: state.players.map((p, idx) =>
      idx === activePlayer
        ? {
            ...p,
            hand: updatedHand,
            landPlaysRemaining: p.landPlaysRemaining - 1,
          }
        : p
    ),
    battlefield: [...state.battlefield, landPermanent],
    timestamp: state.timestamp + 1,
  };

  currentState = addLogEntry(currentState, {
    turn: currentState.turn,
    player: activePlayer,
    phase: currentState.step,
    action: 'play_land',
    card: card.card.name,
    details: `Player ${activePlayer} plays ${card.card.name}`,
  });

  return currentState;
}

/**
 * Executes an activate action (mana ability):
 * 1. Tap the permanent
 * 2. Add mana to pool
 */
function executeActivate(state: GameState, action: GameAction): GameState {
  if (!action.permanentId) return state;

  const activePlayer = state.activePlayerIndex;
  const permanent = state.battlefield.find((p) => p.id === action.permanentId);
  if (!permanent) return state;

  // Tap the permanent
  let currentState: GameState = {
    ...state,
    battlefield: state.battlefield.map((p) =>
      p.id === action.permanentId ? { ...p, tapped: true } : p
    ),
    timestamp: state.timestamp + 1,
  };

  // Get mana abilities and add to pool
  const abilities = getManaAbilities(permanent);

  let updatedPool = { ...currentState.players[activePlayer].manaPool };
  for (const ability of abilities) {
    updatedPool = {
      ...updatedPool,
      [ability.produces]: updatedPool[ability.produces] + 1,
    };
  }

  currentState = {
    ...currentState,
    players: currentState.players.map((p, idx) =>
      idx === activePlayer ? { ...p, manaPool: updatedPool } : p
    ),
  };

  currentState = addLogEntry(currentState, {
    turn: currentState.turn,
    player: activePlayer,
    phase: currentState.step,
    action: 'activate',
    card: permanent.card.name,
    details: `Player ${activePlayer} activates ${permanent.card.name} mana ability`,
  });

  return currentState;
}

// === Game Result ===

/**
 * Builds the final GameResult from the game state.
 */
function buildGameResult(
  gameId: string,
  state: GameState,
  decks: DeckInput[]
): GameResult {
  const players: PlayerResult[] = state.players.map((player, idx) => ({
    deckName: decks[idx].name,
    seatIndex: idx,
    result: state.winner === idx ? 'win' : 'loss',
    turnsSurvived: state.turn,
  }));

  const winner = state.winner !== null
    ? {
        deckName: decks[state.winner].name,
        seatIndex: state.winner,
        result: 'win' as const,
        turnsSurvived: state.turn,
      }
    : null;

  return {
    gameId,
    players,
    winner,
    totalTurns: state.turn,
    log: state.gameLog,
  };
}
