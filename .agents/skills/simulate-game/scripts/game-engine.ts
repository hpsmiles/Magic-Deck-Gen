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

  // 2. Mulligan phase (parallel — all players decide simultaneously)
  state = await runMulliganPhase(state, decks);

  // 3. Main game loop
  while (!state.gameOver && state.turn <= MAX_TURNS) {
    const lifeStr = state.players.map((p) => p.life).join(',');
    const landStr = state.players.map((_, i) => getPermanentsControlledBy(state, i).filter((p) => isLand(p)).length).join(',');
    const handStr = state.players.map((p) => p.hand.length).join(',');
    console.log(`  Turn ${state.turn}: P${state.activePlayerIndex} (${decks[state.activePlayerIndex].name}) — Life:[${lifeStr}] Lands:[${landStr}] Hand:[${handStr}]`);
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
 *
 * Optimization: All mulligan decisions run in parallel.
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

  // Each player decides whether to keep — run all decisions in parallel per round
  for (let mulliganRound = 0; mulliganRound < 3; mulliganRound++) {
    // Collect decisions for all players who haven't kept yet
    const pendingPlayers: number[] = [];
    for (let i = 0; i < currentState.players.length; i++) {
      if (currentState.players[i].mulligansTaken === mulliganRound) {
        // Player hasn't decided yet this round
        pendingPlayers.push(i);
      }
    }

    if (pendingPlayers.length === 0) break;

    // Run all mulligan decisions in parallel
    const decisions = await Promise.all(
      pendingPlayers.map((i) =>
        getMulliganDecision(
          currentState.players[i].hand,
          decks[i].name,
          decks[i].strategy,
          mulliganRound
        )
      )
    );

    // Apply decisions sequentially (state is threaded)
    for (let j = 0; j < pendingPlayers.length; j++) {
      const i = pendingPlayers[j];
      const decision = decisions[j];
      const player = currentState.players[i];

      if (decision.keep) {
        currentState = addLogEntry(currentState, {
          turn: 0,
          player: i,
          phase: 'untap',
          action: 'keep',
          details: `Player ${i} keeps hand (${player.hand.length} cards). ${decision.reasoning}`,
        });
      } else {
        // Mulligan: put hand back in library, shuffle, draw one fewer
        const isFreeMulligan = mulliganRound === 0 && currentState.players.length >= 3;
        const drawCount = isFreeMulligan ? 7 : 7 - (mulliganRound + 1);

        const handCards = player.hand;
        const updatedLibrary = shuffleArray([...handCards, ...player.library]);

        const updatedPlayers = [...currentState.players];
        updatedPlayers[i] = {
          ...player,
          hand: [],
          library: updatedLibrary,
          mulligansTaken: mulliganRound + 1,
        };
        currentState = {
          ...currentState,
          players: updatedPlayers,
          timestamp: currentState.timestamp + 1,
        };

        currentState = drawCards(currentState, i, drawCount);

        currentState = addLogEntry(currentState, {
          turn: 0,
          player: i,
          phase: 'untap',
          action: 'mulligan',
          details: `Player ${i} takes mulligan #${mulliganRound + 1}${isFreeMulligan ? ' (free)' : ''}, draws ${drawCount} cards. ${decision.reasoning}`,
        });
      }
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
  // Draw step: Active player draws 1 card
  // In Commander, drawing from an empty library causes that player to lose
  const libraryBeforeDraw = currentState.players[activePlayer].library.length;
  currentState = drawCards(currentState, activePlayer, 1);
  if (libraryBeforeDraw === 0) {
    // Player attempted to draw from empty library — they lose
    currentState = addLogEntry(currentState, {
      turn: currentState.turn,
      player: activePlayer,
      phase: 'draw',
      action: 'state_based_action',
      details: `Player ${activePlayer} loses — attempted to draw from an empty library`,
    });
    // Mark player as eliminated by setting life to 0
    currentState = {
      ...currentState,
      players: currentState.players.map((p, idx) =>
        idx === activePlayer ? { ...p, life: 0 } : p
      ),
    };
  }
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
  // Optimization: Skip if player has no hand and no castable commanders
  currentState = { ...currentState, phase: 'postcombat_main', step: 'main_postcombat' };
  const postCombatLegal = getLegalActions(currentState);
  const hasPostCombatActions = postCombatLegal.castableSpells.length > 0
    || postCombatLegal.castableCommanders.length > 0
    || postCombatLegal.playableLands.length > 0;

  if (hasPostCombatActions) {
    currentState = await runMainPhase(currentState, decks);
  }

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
 *
 * Optimization: Heuristic shortcuts for obvious decisions:
 * - Auto-play a land if available (no LLM call needed)
 * - Auto-tap lands for mana when casting a spell (combined into one LLM call)
 * - Skip phase if only action is to pass
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

    const legalActions = getLegalActions(currentState);
    const activePlayer = currentState.activePlayerIndex;
    const player = currentState.players[activePlayer];

    // === Heuristic: Auto-play land if available ===
    if (legalActions.playableLands.length > 0 && player.landPlaysRemaining > 0) {
      const land = legalActions.playableLands[0];
      currentState = executeAction(currentState, { type: 'play_land', cardId: land.id }, decks);

      currentState = addLogEntry(currentState, {
        turn: currentState.turn,
        player: activePlayer,
        phase: currentState.step,
        action: 'play_land',
        card: land.card.name,
        details: `Player ${activePlayer} plays ${land.card.name} (auto)`,
      });

      // Check SBAs after land play
      const sbaResult = checkStateBasedActions(currentState);
      currentState = sbaResult.state;
      if (sbaResult.gameEnded) return currentState;
      continue; // Re-evaluate legal actions after land play
    }

    // === Heuristic: If only pass is available, auto-pass ===
    const hasNonPassActions = legalActions.castableSpells.length > 0
      || legalActions.castableCommanders.length > 0
      || legalActions.activatableAbilities.length > 0
      || legalActions.canAttack.length > 0;

    if (!hasNonPassActions) {
      passed = true;
      break;
    }

    // === LLM decision for non-trivial choices ===
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

    // Log LLM decision for debugging
    console.log(`    [LLM P${activePlayer} ${currentState.step}] ${response.reasoning.slice(0, 120)}`);
    const actionSummary = response.actions.map((a: GameAction) =>
      a.type === 'cast' ? `cast(${a.cardId})` :
      a.type === 'play_land' ? `land(${a.cardId})` :
      a.type === 'activate' ? `tap(${a.permanentId})` :
      a.type === 'attack' ? `attack(${Object.keys(a.attackers ?? {}).length} creatures)` :
      a.type === 'block' ? `block(${Object.keys(a.blockers ?? {}).length} creatures)` :
      a.type
    ).join(', ');
    console.log(`    [LLM Actions] ${actionSummary}`);

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

      // === Heuristic: Auto-tap lands for mana after casting ===
      // If the player cast a spell but can't afford it from pool, auto-activate lands
      // This is handled by the LLM returning an 'activate' action, but as a fallback:
      // (The LLM should handle this, but we don't need a separate LLM call for it)

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

  let combatAssignments: CombatAssignment[] = [];
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

    // Log combat decision
    console.log(`    [COMBAT P${activePlayer}] ${response.reasoning.slice(0, 120)}`);
    const combatActions = response.actions.map((a: GameAction) =>
      a.type === 'attack' ? `attack(${Object.keys(a.attackers ?? {}).length} -> ${JSON.stringify(a.attackers)})` :
      a.type === 'pass' ? 'pass' : a.type
    ).join(', ');
    console.log(`    [COMBAT Actions] ${combatActions}`);

    for (const action of response.actions) {
      if (action.type === 'attack' && action.attackers) {
        const validation = validateAction(currentState, action);
        if (validation.legal) {
          // Convert attackers map to CombatAssignment[]
          combatAssignments = Object.entries(action.attackers).map(
            ([attackerId, target]) => ({
              attackerId,
              target,
            })
          );

          currentState = declareAttackers(currentState, combatAssignments);
        }
      } else if (action.type === 'pass') {
        // No attacks this turn
        break;
      }
    }
  }

  // If no attackers were declared, skip the rest of combat
  if (combatAssignments.length === 0) {
    currentState = addLogEntry(currentState, {
      turn: currentState.turn,
      player: activePlayer,
      phase: 'declare_attackers',
      action: 'pass',
      details: `Player ${activePlayer} declines to attack.`,
    });
    return currentState;
  }

  // === Declare Blockers ===
  currentState = { ...currentState, step: 'declare_blockers' };

  // Collect all attacker IDs that are attacking (tapped creatures that attacked this turn)
  // We need to track which creatures attacked. For v1, we use the tapped+creature heuristic.
  // A more robust approach would track combat assignments in state, but this works for v1.

  // For each non-active player, ask for block decisions — run in parallel
  const allBlocks: BlockAssignment[] = [];

  // Collect defender indices that have blockers available
  const defenderIndices: number[] = [];
  const defenderLegalActionsMap: Map<number, LegalActions> = new Map();

  for (let i = 0; i < currentState.players.length; i++) {
    if (i === activePlayer) continue;

    const defenderLegalActions = getLegalActions({
      ...currentState,
      activePlayerIndex: i,
    });

    if (defenderLegalActions.canBlock.length === 0) continue;

    defenderIndices.push(i);
    defenderLegalActionsMap.set(i, defenderLegalActions);
  }

  // Run all blocker decisions in parallel
  if (defenderIndices.length > 0) {
    const blockerResponses = await Promise.all(
      defenderIndices.map((i) => {
        const deck = decks[i];
        const recentActions = currentState.gameLog.slice(-10);
        const defenderLegalActions = defenderLegalActionsMap.get(i)!;

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

        return getAgentDecision(request);
      })
    );

    // Collect all block assignments
    for (const response of blockerResponses) {
      for (const action of response.actions) {
        if (action.type === 'block' && action.blockers) {
          for (const [blockerId, attackerIds] of Object.entries(action.blockers)) {
            // Handle both array format ["attackerId"] and single string "attackerId"
            const ids = Array.isArray(attackerIds) ? attackerIds : [attackerIds];
            for (const attackerId of ids) {
              allBlocks.push({ blockerId, attackerId });
            }
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

  const combatResult = resolveCombatDamage(currentState, combatAssignments, allBlocks);
  currentState = combatResult.state;

  // Check SBAs after combat damage
  const sbaResult = checkStateBasedActions(currentState);
  currentState = sbaResult.state;

  // === End Combat ===
  currentState = { ...currentState, step: 'end_combat' };

  return currentState;
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
 * Skips eliminated players (0 life, commander damage >= 21, or poison >= 10).
 * Wraps back to player 0 and increments the turn counter.
 */
function advanceToNextPlayer(state: GameState): GameState {
  const totalPlayers = state.players.length;
  let nextPlayer = state.activePlayerIndex;

  // Find next living player
  for (let i = 0; i < totalPlayers; i++) {
    nextPlayer = (nextPlayer + 1) % totalPlayers;
    const candidate = state.players[nextPlayer];
    // Check if this player is still alive
    if (candidate.life > 0 && candidate.poisonCounters < 10) {
      const hasCommanderLethal = Object.values(candidate.commanderDamage).some(
        (dmg) => dmg >= 21
      );
      if (!hasCommanderLethal) {
        break;
      }
    }
    // Player is eliminated, continue to next
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
 * 1. Remove card from hand OR command zone
 * 2. Pay mana cost (including commander tax for commanders)
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

  // Check if casting from hand or command zone
  const cardIndex = player.hand.findIndex((c) => c.id === action.cardId);
  const commanderEntry = state.commandZone.find(
    (cz) => cz.instance.id === action.cardId && cz.instance.owner === activePlayer
  );

  let card: CardInstance;
  let currentState: GameState;

  if (cardIndex !== -1) {
    // Casting from hand
    card = player.hand[cardIndex];

    // Calculate total mana cost — only apply commander tax when casting the commander
    const isCommanderCast = state.commandZone.some(
      (cz) => cz.instance.owner === activePlayer && cz.instance.card.scryfallId === card.card.scryfallId
    );
    const commanderTax = isCommanderCast ? getCommanderTax(state, activePlayer) : 0;
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

    currentState = {
      ...state,
      players: state.players.map((p, idx) =>
        idx === activePlayer
          ? { ...p, hand: updatedHand, manaPool: newPool }
          : p
      ),
      timestamp: state.timestamp + 1,
    };

    // If casting the commander, increment castCount
    if (isCommanderCast) {
      currentState = {
        ...currentState,
        commandZone: currentState.commandZone.map((cz) =>
          cz.instance.owner === activePlayer && cz.instance.card.scryfallId === card.card.scryfallId
            ? { ...cz, castCount: cz.castCount + 1 }
            : cz
        ),
      };
    }
  } else if (commanderEntry) {
    // Casting from command zone
    card = commanderEntry.instance;

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
    if (newPool === null) return state;

    // Remove commander from command zone (it will be on the battlefield or graveyard)
    currentState = {
      ...state,
      players: state.players.map((p, idx) =>
        idx === activePlayer ? { ...p, manaPool: newPool } : p
      ),
      commandZone: state.commandZone.map((cz) =>
        cz.instance.id === action.cardId
          ? { ...cz, castCount: cz.castCount + 1 }
          : cz
      ),
      timestamp: state.timestamp + 1,
    };
  } else {
    return state; // Card not found in hand or command zone
  }

  const typeLine = card.card.typeLine.toLowerCase();

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
      details: `Player ${activePlayer} casts ${card.card.name}${commanderEntry ? ' from command zone' : ''}`,
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
      details: `Player ${activePlayer} casts ${card.card.name} (resolved immediately)${commanderEntry ? ' from command zone' : ''}`,
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
