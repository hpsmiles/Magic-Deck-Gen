import type {
  CardInstance,
  CommandZoneCard,
  GameAction,
  GameState,
  LegalActions,
  ValidationResult,
} from './types.js';
import {
  getPermanentsControlledBy,
  isLand,
  isCreature,
  getCommanderTax,
} from './game-state.js';
import { canAffordSpell, getAvailableMana } from './mana-resolver.js';

/**
 * Checks if a card instance is a land by examining its type line.
 */
function isLandCard(card: CardInstance): boolean {
  return card.card.typeLine.toLowerCase().includes('land');
}

/**
 * Computes all legal actions for the active player.
 *
 * - castableSpells: Non-land cards in hand that can be afforded (with commander tax)
 * - playableLands: Land cards in hand when landPlaysRemaining > 0
 * - activatableAbilities: Untapped lands on battlefield (simplified — mana abilities only for v1)
 * - canAttack: Creatures that are untapped and don't have summoningSickness
 * - canBlock: Creatures that are untapped
 * - canPass: Always true
 * - canRespond: True when stack is non-empty
 */
export function getLegalActions(state: GameState): LegalActions {
  const activePlayer = state.players[state.activePlayerIndex];
  const controlledPermanents = getPermanentsControlledBy(
    state,
    state.activePlayerIndex
  );
  const commanderTax = getCommanderTax(state, state.activePlayerIndex);
  const availableManaAbilities = getAvailableMana(controlledPermanents);

  // Castable spells: non-land cards in hand that can be afforded
  // Commander tax only applies when casting the commander itself
  const castableSpells = activePlayer.hand.filter((card) => {
    if (isLandCard(card)) return false;
    const isCommander = state.commandZone.some(
      (cz) => cz.instance.owner === state.activePlayerIndex && cz.instance.card.scryfallId === card.card.scryfallId
    );
    const tax = isCommander ? commanderTax : 0;
    return canAffordSpell(
      card.card,
      activePlayer.manaPool,
      availableManaAbilities,
      tax
    );
  });

  // Castable commanders: commanders in the command zone that can be afforded (with tax)
  const castableCommanders = state.commandZone.filter((cz) => {
    if (cz.instance.owner !== state.activePlayerIndex) return false;
    if (isLandCard(cz.instance)) return false;
    const tax = getCommanderTax(state, state.activePlayerIndex);
    return canAffordSpell(
      cz.instance.card,
      activePlayer.manaPool,
      availableManaAbilities,
      tax
    );
  });

  // Playable lands: land cards in hand when land plays remaining
  const playableLands =
    activePlayer.landPlaysRemaining > 0
      ? activePlayer.hand.filter((card) => isLandCard(card))
      : [];

  // Activatable abilities: untapped lands on battlefield (simplified — mana abilities only for v1)
  const activatableAbilities = controlledPermanents.filter(
    (p) => isLand(p) && !p.tapped
  );

  // Can attack: creatures that are untapped and don't have summoning sickness
  const canAttack = controlledPermanents.filter(
    (p) => isCreature(p) && !p.tapped && !p.summoningSickness
  );

  // Can block: creatures that are untapped
  const canBlock = controlledPermanents.filter(
    (p) => isCreature(p) && !p.tapped
  );

  return {
    castableSpells,
    castableCommanders,
    playableLands,
    activatableAbilities,
    canAttack,
    canBlock,
    canPass: true,
    canRespond: state.stack.length > 0,
  };
}

/**
 * Validates a specific game action against the current game state.
 * Returns a ValidationResult indicating whether the action is legal and why not if it isn't.
 */
export function validateAction(
  state: GameState,
  action: GameAction
): ValidationResult {
  const legalActions = getLegalActions(state);
  const activePlayer = state.players[state.activePlayerIndex];

  switch (action.type) {
    case 'cast': {
      if (!action.cardId) {
        return { legal: false, reason: 'No cardId provided for cast action' };
      }
      // Check hand first
      const cardInHand = activePlayer.hand.find((c) => c.id === action.cardId);
      if (cardInHand) {
        const isCastable = legalActions.castableSpells.some(
          (c) => c.id === action.cardId
        );
        if (!isCastable) {
          return {
            legal: false,
            reason: `Card ${action.cardId} is not castable (insufficient mana or is a land)`,
          };
        }
        return { legal: true };
      }
      // Check command zone (commander cast)
      const commanderInZone = state.commandZone.find(
        (cz) => cz.instance.id === action.cardId && cz.instance.owner === state.activePlayerIndex
      );
      if (commanderInZone) {
        const isCastable = legalActions.castableCommanders.some(
          (cz) => cz.instance.id === action.cardId
        );
        if (!isCastable) {
          return {
            legal: false,
            reason: `Commander ${action.cardId} is not castable (insufficient mana including commander tax)`,
          };
        }
        return { legal: true };
      }
      return {
        legal: false,
        reason: `Card ${action.cardId} is not in active player's hand or command zone`,
      };
    }

    case 'play_land': {
      if (!action.cardId) {
        return {
          legal: false,
          reason: 'No cardId provided for play_land action',
        };
      }
      const cardInHand = activePlayer.hand.find((c) => c.id === action.cardId);
      if (!cardInHand) {
        return {
          legal: false,
          reason: `Card ${action.cardId} is not in active player's hand`,
        };
      }
      if (!isLandCard(cardInHand)) {
        return {
          legal: false,
          reason: `Card ${action.cardId} is not a land`,
        };
      }
      if (activePlayer.landPlaysRemaining <= 0) {
        return {
          legal: false,
          reason: 'No land plays remaining this turn',
        };
      }
      return { legal: true };
    }

    case 'activate': {
      if (!action.permanentId) {
        return {
          legal: false,
          reason: 'No permanentId provided for activate action',
        };
      }
      const permanent = state.battlefield.find(
        (p) => p.id === action.permanentId
      );
      if (!permanent) {
        return {
          legal: false,
          reason: `Permanent ${action.permanentId} is not on the battlefield`,
        };
      }
      if (permanent.tapped) {
        return {
          legal: false,
          reason: `Permanent ${action.permanentId} is tapped`,
        };
      }
      const isActivatable = legalActions.activatableAbilities.some(
        (p) => p.id === action.permanentId
      );
      if (!isActivatable) {
        return {
          legal: false,
          reason: `Permanent ${action.permanentId} has no activatable abilities`,
        };
      }
      return { legal: true };
    }

    case 'attack': {
      if (state.step !== 'declare_attackers') {
        return { legal: false, reason: 'Can only attack during declare attackers step' };
      }
      if (!action.attackers || Object.keys(action.attackers).length === 0) {
        return {
          legal: false,
          reason: 'No attackers specified',
        };
      }
      for (const attackerId of Object.keys(action.attackers!)) {
        const permanent = state.battlefield.find((p) => p.id === attackerId);
        if (!permanent) {
          return {
            legal: false,
            reason: `Attacker ${attackerId} is not on the battlefield`,
          };
        }
        const canAttackThis = legalActions.canAttack.some(
          (p) => p.id === attackerId
        );
        if (!canAttackThis) {
          return {
            legal: false,
            reason: `Attacker ${attackerId} cannot attack (tapped or summoning sickness)`,
          };
        }
      }
      return { legal: true };
    }

    case 'block': {
      if (state.step !== 'declare_blockers') {
        return { legal: false, reason: 'Can only block during declare blockers step' };
      }
      if (!action.blockers || Object.keys(action.blockers).length === 0) {
        return {
          legal: false,
          reason: 'No blockers specified',
        };
      }
      for (const blockerId of Object.keys(action.blockers!)) {
        const permanent = state.battlefield.find((p) => p.id === blockerId);
        if (!permanent) {
          return {
            legal: false,
            reason: `Blocker ${blockerId} is not on the battlefield`,
          };
        }
        const canBlockThis = legalActions.canBlock.some(
          (p) => p.id === blockerId
        );
        if (!canBlockThis) {
          return {
            legal: false,
            reason: `Blocker ${blockerId} cannot block (tapped)`,
          };
        }
      }
      return { legal: true };
    }

    case 'pass': {
      return { legal: true };
    }

    case 'respond': {
      if (state.stack.length === 0) {
        return {
          legal: false,
          reason: 'Cannot respond — stack is empty',
        };
      }
      return { legal: true };
    }

    default: {
      return {
        legal: false,
        reason: `Unknown action type: ${(action as GameAction).type}`,
      };
    }
  }
}

/**
 * Returns true if any non-pass action is available to the active player.
 * Phase-sensitive: attack/block only count during their respective steps.
 */
export function hasActionsAvailable(state: GameState): boolean {
  const legal = getLegalActions(state);
  return (
    legal.castableSpells.length > 0 ||
    legal.castableCommanders.length > 0 ||
    legal.playableLands.length > 0 ||
    legal.activatableAbilities.length > 0 ||
    (state.step === 'declare_attackers' && legal.canAttack.length > 0) ||
    (state.step === 'declare_blockers' && legal.canBlock.length > 0) ||
    (state.stack.length > 0 && legal.canRespond)
  );
}
