import type { CardData, ManaCost, ManaPool, Permanent } from './types.js';
import { isLand } from './game-state.js';

/**
 * Represents a single mana ability on a permanent.
 * Each ability produces exactly one unit of a specific mana type.
 */
export interface ManaAbility {
  produces: keyof ManaPool;
  source: Permanent;
}

/** Map from basic land type (lowercased substring) to the mana color it produces. */
const BASIC_LAND_MAP: Record<string, keyof ManaPool> = {
  plains: 'white',
  island: 'blue',
  swamp: 'black',
  mountain: 'red',
  forest: 'green',
};

/** Color letter to ManaPool key mapping for color identity. */
const COLOR_MAP: Record<string, keyof ManaPool> = {
  W: 'white',
  U: 'blue',
  B: 'black',
  R: 'red',
  G: 'green',
};

/**
 * Returns the mana abilities for a single permanent.
 *
 * Rules:
 * - Must be an untapped land (for land-based mana) or a recognized mana artifact
 * - Basic lands produce their corresponding color
 * - Sol Ring produces 2 colorless (two separate ManaAbility entries)
 * - Command Tower produces one of each color in its colorIdentity
 * - Arcane Signet produces 1 colorless
 * - Other lands produce 1 colorless (fallback)
 */
export function getManaAbilities(permanent: Permanent): ManaAbility[] {
  const abilities: ManaAbility[] = [];
  const name = permanent.card.name;
  const typeLine = permanent.card.typeLine.toLowerCase();

  // Check if it's a recognized mana artifact (not a land)
  if (name === 'Sol Ring') {
    if (!permanent.tapped) {
      // Sol Ring produces 2 colorless — two separate abilities
      abilities.push({ produces: 'colorless', source: permanent });
      abilities.push({ produces: 'colorless', source: permanent });
    }
    return abilities;
  }

  if (name === 'Arcane Signet') {
    if (!permanent.tapped) {
      abilities.push({ produces: 'colorless', source: permanent });
    }
    return abilities;
  }

  // Must be an untapped land for all remaining cases
  if (!isLand(permanent) || permanent.tapped) {
    return abilities;
  }

  // Command Tower — produces one of each color in colorIdentity
  if (name === 'Command Tower') {
    for (const color of permanent.card.colorIdentity) {
      const poolKey = COLOR_MAP[color];
      if (poolKey) {
        abilities.push({ produces: poolKey, source: permanent });
      }
    }
    return abilities;
  }

  // Basic lands — check type line for basic land subtypes
  for (const [landType, manaColor] of Object.entries(BASIC_LAND_MAP)) {
    if (typeLine.includes(landType) && typeLine.includes('basic')) {
      abilities.push({ produces: manaColor, source: permanent });
      return abilities;
    }
  }

  // Fallback: other lands produce 1 colorless
  abilities.push({ produces: 'colorless', source: permanent });
  return abilities;
}

/**
 * Returns all available mana abilities from a set of permanents.
 * Flat-maps getManaAbilities over all permanents.
 */
export function getAvailableMana(permanents: Permanent[]): ManaAbility[] {
  return permanents.flatMap((p) => getManaAbilities(p));
}

/**
 * Sums up mana abilities into a mana pool.
 */
export function calculateAvailableManaPool(abilities: ManaAbility[]): ManaPool {
  const pool: ManaPool = {
    white: 0,
    blue: 0,
    black: 0,
    red: 0,
    green: 0,
    colorless: 0,
  };

  for (const ability of abilities) {
    pool[ability.produces]++;
  }

  return pool;
}

/**
 * Sums all mana cost components into a total mana value.
 */
export function getTotalManaCost(cost: ManaCost): number {
  return cost.white + cost.blue + cost.black + cost.red + cost.green + cost.colorless + cost.x;
}

/**
 * Checks if a spell can be cast given the current mana pool,
 * available mana abilities, and commander tax.
 *
 * Algorithm:
 * 1. Add commander tax to the colorless cost
 * 2. Combine current mana pool + available mana abilities into a total pool
 * 3. Check colored requirements first
 * 4. Check total mana available >= total cost
 */
export function canAffordSpell(
  card: CardData,
  manaPool: ManaPool,
  availableManaAbilities: ManaAbility[],
  commanderTax: number
): boolean {
  // Step 1: Compute total cost with commander tax added to colorless
  const totalCost: ManaCost = {
    ...card.manaCost,
    colorless: card.manaCost.colorless + commanderTax,
  };

  // Step 2: Combine current mana pool + available mana abilities
  const abilityPool = calculateAvailableManaPool(availableManaAbilities);
  const totalPool: ManaPool = {
    white: manaPool.white + abilityPool.white,
    blue: manaPool.blue + abilityPool.blue,
    black: manaPool.black + abilityPool.black,
    red: manaPool.red + abilityPool.red,
    green: manaPool.green + abilityPool.green,
    colorless: manaPool.colorless + abilityPool.colorless,
  };

  // Step 3: Check colored requirements first
  const colors: (keyof ManaPool)[] = ['white', 'blue', 'black', 'red', 'green'];
  let remainingColorless = totalCost.colorless;
  let poolCopy = { ...totalPool };

  for (const color of colors) {
    const needed = totalCost[color];
    const available = poolCopy[color];

    if (available < needed) {
      return false;
    }
    poolCopy[color] -= needed;
    // Excess colored mana can pay for colorless
    remainingColorless -= poolCopy[color];
  }

  // Step 4: Check total mana available >= total cost
  // Pay remaining colorless with colorless mana
  remainingColorless -= poolCopy.colorless;

  return remainingColorless <= 0;
}
