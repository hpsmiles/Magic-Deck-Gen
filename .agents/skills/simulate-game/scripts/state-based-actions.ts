import type { GameState, Permanent } from './types.js';
import { isCreature, isPlaneswalker, addLogEntry } from './game-state.js';

/**
 * Result of running all state-based actions.
 */
export interface SBAResult {
  state: GameState;
  creaturesDied: Permanent[];
  playersLost: number[];
  gameEnded: boolean;
}

/**
 * Moves a permanent from the battlefield to the appropriate zone.
 * If the permanent is a commander (present in the command zone),
 * it returns to the command zone instead of the graveyard.
 */
function movePermanentToGraveyard(
  state: GameState,
  permanent: Permanent
): GameState {
  // Remove from battlefield
  const newBattlefield = state.battlefield.filter(
    (p) => p.id !== permanent.id
  );

  // Check if this permanent is a commander
  const commanderEntry = state.commandZone.find(
    (cz) => cz.instance.card.scryfallId === permanent.card.scryfallId
  );

  if (commanderEntry) {
    // Commander returns to command zone instead of graveyard
    const updatedCommandZone = state.commandZone.map((cz) =>
      cz.instance.card.scryfallId === permanent.card.scryfallId
        ? { ...cz, instance: { ...cz.instance, zone: 'command' as const } }
        : cz
    );

    return {
      ...state,
      battlefield: newBattlefield,
      commandZone: updatedCommandZone,
      timestamp: state.timestamp + 1,
    };
  }

  // Non-commander: move to owner's graveyard
  const owner = permanent.owner;
  const updatedPlayers = [...state.players];
  const player = updatedPlayers[owner];

  const graveyardCard = {
    id: permanent.id,
    card: permanent.card,
    owner: permanent.owner,
    zone: 'graveyard' as const,
  };

  updatedPlayers[owner] = {
    ...player,
    graveyard: [...player.graveyard, graveyardCard],
  };

  return {
    ...state,
    battlefield: newBattlefield,
    players: updatedPlayers,
    timestamp: state.timestamp + 1,
  };
}

/**
 * Computes the effective toughness of a creature permanent.
 * Effective toughness = base toughness + +1/+1 counters - -1/-1 counters.
 */
function getEffectiveToughness(permanent: Permanent): number {
  const baseToughness = permanent.card.toughness ?? 0;
  const plusCounters = permanent.counters['+1/+1'] ?? 0;
  const minusCounters = permanent.counters['-1/-1'] ?? 0;
  return baseToughness + plusCounters - minusCounters;
}

/**
 * Gets the current loyalty of a planeswalker permanent.
 * Loyalty = counters['loyalty'] ?? card.loyalty.
 */
function getLoyalty(permanent: Permanent): number {
  return permanent.counters['loyalty'] ?? permanent.card.loyalty ?? 0;
}

/**
 * Checks and enforces all state-based actions in a loop until no changes occur.
 * SBAs run repeatedly because one SBA can trigger another (e.g., a creature dying
 * can cause another creature's toughness to drop below 0).
 */
export function checkStateBasedActions(state: GameState): SBAResult {
  let currentState = state;
  const creaturesDied: Permanent[] = [];
  const playersLost: number[] = [];
  let gameEnded = false;

  let changed = true;
  while (changed) {
    changed = false;

    // === Creature death ===
    // Creatures with effective toughness <= 0 die
    // Creatures with damage >= effective toughness die
    for (const permanent of currentState.battlefield) {
      if (!isCreature(permanent)) continue;

      const effectiveToughness = getEffectiveToughness(permanent);

      if (effectiveToughness <= 0) {
        creaturesDied.push(permanent);
        currentState = movePermanentToGraveyard(currentState, permanent);
        currentState = addLogEntry(currentState, {
          turn: currentState.turn,
          player: permanent.controller,
          phase: currentState.step,
          action: 'state_based_action',
          card: permanent.card.name,
          details: `${permanent.card.name} dies — toughness is ${effectiveToughness} (<= 0)`,
        });
        changed = true;
        continue; // Skip damage check, already dead
      }

      if (permanent.damage >= effectiveToughness) {
        creaturesDied.push(permanent);
        currentState = movePermanentToGraveyard(currentState, permanent);
        currentState = addLogEntry(currentState, {
          turn: currentState.turn,
          player: permanent.controller,
          phase: currentState.step,
          action: 'state_based_action',
          card: permanent.card.name,
          details: `${permanent.card.name} dies — lethal damage (${permanent.damage} damage vs ${effectiveToughness} toughness)`,
        });
        changed = true;
      }
    }

    // === Planeswalker death ===
    // Planeswalkers with loyalty <= 0 die
    for (const permanent of currentState.battlefield) {
      if (!isPlaneswalker(permanent)) continue;

      const loyalty = getLoyalty(permanent);

      if (loyalty <= 0) {
        currentState = movePermanentToGraveyard(currentState, permanent);
        currentState = addLogEntry(currentState, {
          turn: currentState.turn,
          player: permanent.controller,
          phase: currentState.step,
          action: 'state_based_action',
          card: permanent.card.name,
          details: `${permanent.card.name} dies — loyalty is ${loyalty} (<= 0)`,
        });
        changed = true;
      }
    }

    // === Player loss conditions ===
    for (const player of currentState.players) {
      // Skip already-lost players (they won't be in the active check below
      // but we need to avoid double-counting)
      if (playersLost.includes(player.index)) continue;

      // 0 life
      if (player.life <= 0) {
        playersLost.push(player.index);
        currentState = addLogEntry(currentState, {
          turn: currentState.turn,
          player: player.index,
          phase: currentState.step,
          action: 'state_based_action',
          details: `Player ${player.index} loses — life is ${player.life} (<= 0)`,
        });
        changed = true;
        continue;
      }

      // Commander damage >= 21
      for (const cmdName in player.commanderDamage) {
        if (player.commanderDamage[cmdName] >= 21) {
          playersLost.push(player.index);
          currentState = addLogEntry(currentState, {
            turn: currentState.turn,
            player: player.index,
            phase: currentState.step,
            action: 'state_based_action',
            details: `Player ${player.index} loses — commander damage from ${cmdName} is ${player.commanderDamage[cmdName]} (>= 21)`,
          });
          changed = true;
          break; // No need to check other commanders
        }
      }

      if (playersLost.includes(player.index)) continue;

      // Poison counters >= 10
      if (player.poisonCounters >= 10) {
        playersLost.push(player.index);
        currentState = addLogEntry(currentState, {
          turn: currentState.turn,
          player: player.index,
          phase: currentState.step,
          action: 'state_based_action',
          details: `Player ${player.index} loses — poison counters is ${player.poisonCounters} (>= 10)`,
        });
        changed = true;
      }
    }

    // === Game end check ===
    // If only 1 player (or 0) remains, game ends
    const activePlayers = currentState.players.filter(
      (p) => !playersLost.includes(p.index)
    );

    if (activePlayers.length <= 1) {
      gameEnded = true;
      const winner = activePlayers.length === 1 ? activePlayers[0].index : null;
      currentState = {
        ...currentState,
        gameOver: true,
        winner,
        timestamp: currentState.timestamp + 1,
      };
      currentState = addLogEntry(currentState, {
        turn: currentState.turn,
        player: winner ?? 0,
        phase: currentState.step,
        action: 'game_end',
        details:
          winner !== null
            ? `Player ${winner} wins the game!`
            : 'Game ends in a draw!',
      });
      // No need to continue the loop if the game is over
      break;
    }
  }

  return {
    state: currentState,
    creaturesDied,
    playersLost,
    gameEnded,
  };
}
