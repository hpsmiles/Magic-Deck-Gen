import type { GameState, Permanent, Target } from './types.js';
import { addLogEntry, hasKeyword } from './game-state.js';

// === Combat Types ===

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
  damageDealt: Record<string, number>;
  playerDamage: Record<number, number>;
}

// === Internal Helpers ===

/**
 * Computes the effective power of a permanent:
 * base power + +1/+1 counters - -1/-1 counters, minimum 0.
 */
function getEffectivePower(permanent: Permanent): number {
  const base = permanent.card.power ?? 0;
  const plusCounters = permanent.counters['+1/+1'] ?? 0;
  const minusCounters = permanent.counters['-1/-1'] ?? 0;
  return Math.max(0, base + plusCounters - minusCounters);
}

/**
 * Checks if a permanent is a commander by matching its scryfallId
 * against the command zone entries.
 */
function isCommander(state: GameState, permanent: Permanent): boolean {
  return state.commandZone.some(
    (cz) => cz.instance.card.scryfallId === permanent.card.scryfallId
  );
}

/**
 * Finds a permanent on the battlefield by its ID.
 */
function findPermanent(state: GameState, id: string): Permanent | undefined {
  return state.battlefield.find((p) => p.id === id);
}

/**
 * Processes damage for a set of attackers.
 * - Blocked attackers: damage split among blockers (last blocker gets remainder)
 * - Blockers in `blockersThatDealDamage` deal damage back to attackers
 * - Unblocked attackers: damage to target player
 * - Commander damage tracking
 *
 * @param attackerBlockers Map of attacker ID -> list of blocker IDs (determines if blocked + damage targets)
 * @param blockersThatDealDamage Set of blocker IDs that should deal damage back this step
 */
function dealDamage(
  state: GameState,
  attackers: CombatAssignment[],
  attackerBlockers: Map<string, string[]>,
  blockersThatDealDamage: Set<string>,
  damageDealt: Record<string, number>,
  playerDamage: Record<number, number>
): GameState {
  let currentState = state;

  for (const assignment of attackers) {
    const attacker = findPermanent(currentState, assignment.attackerId);
    if (!attacker) continue;

    const effectivePower = getEffectivePower(attacker);
    if (effectivePower === 0) continue;

    const blockers = attackerBlockers.get(assignment.attackerId) ?? [];

    if (blockers.length > 0) {
      // Blocked attacker: split damage among blockers
      const baseDamage = Math.floor(effectivePower / blockers.length);
      const remainder = effectivePower - baseDamage * blockers.length;

      for (let i = 0; i < blockers.length; i++) {
        const blockerId = blockers[i];
        const blocker = findPermanent(currentState, blockerId);
        if (!blocker) continue;

        // Last blocker gets the remainder
        const damage = i === blockers.length - 1 ? baseDamage + remainder : baseDamage;

        // Apply damage to blocker
        currentState = {
          ...currentState,
          battlefield: currentState.battlefield.map((p) =>
            p.id === blockerId ? { ...p, damage: p.damage + damage } : p
          ),
          timestamp: currentState.timestamp + 1,
        };

        damageDealt[blockerId] = (damageDealt[blockerId] ?? 0) + damage;

        // Blocker deals damage back to attacker only if it's in the set for this step
        if (blockersThatDealDamage.has(blockerId)) {
          const blockerPower = getEffectivePower(blocker);
          if (blockerPower > 0) {
            currentState = {
              ...currentState,
              battlefield: currentState.battlefield.map((p) =>
                p.id === assignment.attackerId ? { ...p, damage: p.damage + blockerPower } : p
              ),
              timestamp: currentState.timestamp + 1,
            };

            damageDealt[assignment.attackerId] = (damageDealt[assignment.attackerId] ?? 0) + blockerPower;
          }
        }
      }
    } else {
      // Unblocked attacker: damage to target player
      if (assignment.target.type === 'player') {
        const targetPlayerIndex = parseInt(assignment.target.id, 10);

        // Validate target player index
        if (isNaN(targetPlayerIndex) || targetPlayerIndex < 0 || targetPlayerIndex >= currentState.players.length) {
          console.warn(`Invalid target player index ${targetPlayerIndex} from target.id "${assignment.target.id}" — skipping damage`);
          continue;
        }

        // Reduce player life
        currentState = {
          ...currentState,
          players: currentState.players.map((p, idx) =>
            idx === targetPlayerIndex ? { ...p, life: p.life - effectivePower } : p
          ),
          timestamp: currentState.timestamp + 1,
        };

        damageDealt[assignment.attackerId] = (damageDealt[assignment.attackerId] ?? 0) + effectivePower;
        playerDamage[targetPlayerIndex] = (playerDamage[targetPlayerIndex] ?? 0) + effectivePower;

        // Commander damage tracking
        if (isCommander(currentState, attacker)) {
          const cmdName = attacker.card.name;
          const existingDmg = currentState.players[targetPlayerIndex].commanderDamage[cmdName] ?? 0;
          currentState = {
            ...currentState,
            players: currentState.players.map((p, idx) =>
              idx === targetPlayerIndex
                ? {
                    ...p,
                    commanderDamage: {
                      ...p.commanderDamage,
                      [cmdName]: existingDmg + effectivePower,
                    },
                  }
                : p
            ),
            timestamp: currentState.timestamp + 1,
          };
        }
      }
    }
  }

  return currentState;
}

// === Public API ===

/**
 * Declares attackers: taps each attacker (unless it has Vigilance),
 * and logs each attack declaration.
 */
export function declareAttackers(
  state: GameState,
  assignments: CombatAssignment[]
): GameState {
  let currentState = state;

  for (const assignment of assignments) {
    const attacker = findPermanent(currentState, assignment.attackerId);
    if (!attacker) continue;

    // Tap the attacker unless it has Vigilance
    const shouldTap = !hasKeyword(attacker, 'Vigilance');
    if (shouldTap) {
      currentState = {
        ...currentState,
        battlefield: currentState.battlefield.map((p) =>
          p.id === assignment.attackerId ? { ...p, tapped: true } : p
        ),
        timestamp: currentState.timestamp + 1,
      };
    }

    // Log the attack
    const targetDesc =
      assignment.target.type === 'player'
        ? `player ${assignment.target.id}`
        : assignment.target.id;

    currentState = addLogEntry(currentState, {
      turn: currentState.turn,
      player: attacker.controller,
      phase: 'declare_attackers',
      action: 'attack',
      card: attacker.card.name,
      details: `${attacker.card.name} attacks ${targetDesc}`,
    });
  }

  return currentState;
}

/**
 * Declares blockers: logs each block declaration.
 */
export function declareBlockers(
  state: GameState,
  blocks: BlockAssignment[]
): GameState {
  let currentState = state;

  for (const block of blocks) {
    const blocker = findPermanent(currentState, block.blockerId);
    const attacker = findPermanent(currentState, block.attackerId);
    if (!blocker || !attacker) continue;

    currentState = addLogEntry(currentState, {
      turn: currentState.turn,
      player: blocker.controller,
      phase: 'declare_blockers',
      action: 'block',
      card: blocker.card.name,
      details: `${blocker.card.name} blocks ${attacker.card.name}`,
    });
  }

  return currentState;
}

/**
 * Resolves combat damage in two steps:
 * 1. First strike damage (creatures with First Strike keyword)
 * 2. Regular damage (non-first-strike creatures)
 *
 * Handles blocked/unblocked attackers, blocker damage back,
 * and commander damage tracking.
 */
export function resolveCombatDamage(
  state: GameState,
  attackers: CombatAssignment[],
  blocks: BlockAssignment[]
): CombatResult {
  const damageDealt: Record<string, number> = {};
  const playerDamage: Record<number, number> = {};

  // Build attacker -> blockers map
  const attackerBlockers = new Map<string, string[]>();
  for (const block of blocks) {
    const existing = attackerBlockers.get(block.attackerId) ?? [];
    existing.push(block.blockerId);
    attackerBlockers.set(block.attackerId, existing);
  }

  // Separate first-strike/double-strike attackers from regular attackers
  const firstStrikeAttackers: CombatAssignment[] = [];
  const regularAttackers: CombatAssignment[] = [];

  for (const assignment of attackers) {
    const attacker = findPermanent(state, assignment.attackerId);
    if (!attacker) continue;

    if (hasKeyword(attacker, 'First Strike') || hasKeyword(attacker, 'Double Strike')) {
      firstStrikeAttackers.push(assignment);
    }
    if (!hasKeyword(attacker, 'First Strike') || hasKeyword(attacker, 'Double Strike')) {
      regularAttackers.push(assignment);
    }
  }

  // Identify which blockers have first strike or double strike
  const firstStrikeBlockerIds = new Set<string>();
  for (const block of blocks) {
    const blocker = findPermanent(state, block.blockerId);
    if (blocker && (hasKeyword(blocker, 'First Strike') || hasKeyword(blocker, 'Double Strike'))) {
      firstStrikeBlockerIds.add(block.blockerId);
    }
  }

  // All blocker IDs (for regular damage step)
  const allBlockerIds = new Set(blocks.map((b) => b.blockerId));

  let currentState = state;

  // Step 1: First strike damage
  // First-strike attackers deal damage to their blockers.
  // Only first-strike blockers deal damage back.
  if (firstStrikeAttackers.length > 0) {
    currentState = dealDamage(
      currentState,
      firstStrikeAttackers,
      attackerBlockers,
      firstStrikeBlockerIds,
      damageDealt,
      playerDamage
    );
  }

  // Step 2: Regular damage (non-first-strike creatures)
  // Non-first-strike attackers deal damage to their blockers.
  // Non-first-strike blockers deal damage back.
  if (regularAttackers.length > 0) {
    // Build set of blockers that deal damage in regular step
    // (all blockers except those with first strike, since they already dealt damage)
    const regularBlockerIds = new Set(
      [...allBlockerIds].filter((id) => !firstStrikeBlockerIds.has(id))
    );

    currentState = dealDamage(
      currentState,
      regularAttackers,
      attackerBlockers,
      regularBlockerIds,
      damageDealt,
      playerDamage
    );
  }

  return {
    state: currentState,
    damageDealt,
    playerDamage,
  };
}
