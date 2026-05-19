import OpenAI from 'openai';
import type {
  CardInstance,
  GameAction,
  GameLogEntry,
  GameState,
  LegalActions,
  LLMActionRequest,
  LLMActionResponse,
  ManaPool,
  Target,
} from './types.js';
import {
  getPermanentsControlledBy,
  isCreature,
  isLand,
  getCommanderTax,
} from './game-state.js';

// === LLM Client ===

/**
 * Creates an OpenAI client based on the LLM_PROVIDER env var.
 * - 'openai' (default): Uses OpenAI API with OPENAI_API_KEY
 * - 'anthropic': Uses OpenAI client with Anthropic's base URL and ANTHROPIC_API_KEY
 */
export function getLLMClient(): OpenAI {
  const provider = process.env.LLM_PROVIDER?.toLowerCase() ?? 'openai';

  if (provider === 'anthropic') {
    return new OpenAI({
      apiKey: process.env.ANTHROPIC_API_KEY ?? '',
      baseURL: 'https://api.anthropic.com/v1/',
      defaultHeaders: {
        'anthropic-version': '2023-06-01',
      },
    });
  }

  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY ?? '',
  });
}

/**
 * Returns the default model based on LLM_MODEL env var or provider defaults.
 * - openai: 'gpt-4o'
 * - anthropic: 'claude-sonnet-4-20250514'
 */
export function getDefaultModel(): string {
  if (process.env.LLM_MODEL) {
    return process.env.LLM_MODEL;
  }

  const provider = process.env.LLM_PROVIDER?.toLowerCase() ?? 'openai';
  if (provider === 'anthropic') {
    return 'claude-sonnet-4-20250514';
  }

  return 'gpt-4o';
}

// === Formatting Helpers ===

/**
 * Formats a mana pool as a human-readable string.
 * Colored symbols first (e.g. "2W 1U"), then colorless number (e.g. "3").
 * Zero values are omitted.
 */
export function formatManaPool(pool: ManaPool): string {
  const parts: string[] = [];

  // Colored symbols with counts
  const colorMap: Array<{ key: keyof ManaPool; symbol: string }> = [
    { key: 'white', symbol: 'W' },
    { key: 'blue', symbol: 'U' },
    { key: 'black', symbol: 'B' },
    { key: 'red', symbol: 'R' },
    { key: 'green', symbol: 'G' },
  ];

  for (const { key, symbol } of colorMap) {
    const count = pool[key];
    if (count > 0) {
      parts.push(`${count}${symbol}`);
    }
  }

  // Colorless last
  if (pool.colorless > 0) {
    parts.push(`${pool.colorless}`);
  }

  return parts.length > 0 ? parts.join(' ') : '0';
}

/**
 * Formats a mana cost object as a human-readable string like "2W 1U 3".
 */
function formatManaCost(cost: { white: number; blue: number; black: number; red: number; green: number; colorless: number }): string {
  const parts: string[] = [];

  const colorMap: Array<{ key: keyof typeof cost; symbol: string }> = [
    { key: 'white', symbol: 'W' },
    { key: 'blue', symbol: 'U' },
    { key: 'black', symbol: 'B' },
    { key: 'red', symbol: 'R' },
    { key: 'green', symbol: 'G' },
  ];

  for (const { key, symbol } of colorMap) {
    const count = cost[key];
    if (count > 0) {
      parts.push(`${count}${symbol}`);
    }
  }

  if (cost.colorless > 0) {
    parts.push(`${cost.colorless}`);
  }

  return parts.length > 0 ? parts.join(' ') : '0';
}

// === Game Summary Builder ===

/**
 * Formats the game state as a text summary for the LLM prompt.
 * Provides the perspective of the given player index.
 */
export function buildGameSummary(state: GameState, playerIndex: number): string {
  const player = state.players[playerIndex];
  const myPermanents = getPermanentsControlledBy(state, playerIndex);
  const myCreatures = myPermanents.filter((p) => isCreature(p));
  const myLands = myPermanents.filter((p) => isLand(p));
  const commanderTax = getCommanderTax(state, playerIndex);

  const lines: string[] = [];

  // Your hand
  lines.push('=== YOUR HAND ===');
  if (player.hand.length === 0) {
    lines.push('(empty)');
  } else {
    for (const card of player.hand) {
      const cost = formatManaCost(card.card.manaCost);
      lines.push(`  [${card.id}] ${card.card.name} (${cost}) — ${card.card.typeLine}`);
    }
  }

  // Your creatures on battlefield
  lines.push('');
  lines.push('=== YOUR CREATURES ===');
  if (myCreatures.length === 0) {
    lines.push('(none)');
  } else {
    for (const c of myCreatures) {
      const status = c.tapped ? 'TAPPED' : 'untapped';
      const sickness = c.summoningSickness ? ' (summoning sickness)' : '';
      const p = c.card.power ?? '?';
      const t = c.card.toughness ?? '?';
      const counters = Object.entries(c.counters).length > 0
        ? ` counters: {${Object.entries(c.counters).map(([k, v]) => `${k}:${v}`).join(', ')}}`
        : '';
      lines.push(`  [${c.id}] ${c.card.name} ${p}/${t} ${status}${sickness}${counters}`);
    }
  }

  // Your lands on battlefield
  lines.push('');
  lines.push('=== YOUR LANDS ===');
  if (myLands.length === 0) {
    lines.push('(none)');
  } else {
    for (const l of myLands) {
      const status = l.tapped ? 'TAPPED' : 'untapped';
      lines.push(`  [${l.id}] ${l.card.name} (${status})`);
    }
  }

  // Opponents
  lines.push('');
  lines.push('=== OPPONENTS ===');
  for (const opponent of state.players) {
    if (opponent.index === playerIndex) continue;
    const oppPermanents = getPermanentsControlledBy(state, opponent.index);
    const oppCreatures = oppPermanents.filter((p) => isCreature(p));
    const oppLands = oppPermanents.filter((p) => isLand(p));

    lines.push(`  Player ${opponent.index}: ${opponent.life} life, ${opponent.poisonCounters} poison`);
    lines.push(`    Creatures: ${oppCreatures.length}`);
    for (const c of oppCreatures) {
      const p = c.card.power ?? '?';
      const t = c.card.toughness ?? '?';
      const status = c.tapped ? 'TAPPED' : 'untapped';
      lines.push(`      [${c.id}] ${c.card.name} ${p}/${t} ${status}`);
    }
    lines.push(`    Lands: ${oppLands.length} (${oppLands.filter((l) => !l.tapped).length} untapped)`);
  }

  // Stack items
  lines.push('');
  lines.push('=== STACK ===');
  if (state.stack.length === 0) {
    lines.push('(empty)');
  } else {
    for (const item of state.stack) {
      const sourceName = item.source.card.name;
      lines.push(`  [${item.id}] ${item.type}: ${sourceName} (controller: Player ${item.controller})`);
    }
  }

  // Your mana pool
  lines.push('');
  lines.push('=== YOUR MANA POOL ===');
  lines.push(`  ${formatManaPool(player.manaPool)}`);

  // Commander tax
  lines.push('');
  lines.push('=== COMMANDER INFO ===');
  const commander = state.commandZone.find((cz) => cz.instance.owner === playerIndex);
  if (commander) {
    lines.push(`  Commander: ${commander.instance.card.name} [${commander.instance.id}]`);
    lines.push(`  Times cast: ${commander.castCount}`);
    lines.push(`  Commander tax: +${commanderTax} generic mana`);
    // Check if commander is on the battlefield
    const onBattlefield = state.battlefield.some(
      (p) => p.card.scryfallId === commander.instance.card.scryfallId && p.controller === playerIndex
    );
    if (onBattlefield) {
      lines.push('  Status: On the battlefield');
    } else {
      lines.push('  Status: In command zone (castable!)');
    }
  } else {
    lines.push('  (no commander in command zone)');
  }

  return lines.join('\n');
}

// === Legal Actions Formatter ===

/**
 * Formats legal actions with card IDs for the LLM prompt.
 */
export function formatLegalActions(legal: LegalActions): string {
  const lines: string[] = [];

  lines.push('=== LEGAL ACTIONS ===');

  // Castable spells
  lines.push('');
  lines.push('Castable Spells:');
  if (legal.castableSpells.length === 0) {
    lines.push('  (none)');
  } else {
    for (const card of legal.castableSpells) {
      const cost = formatManaCost(card.card.manaCost);
      lines.push(`  [${card.id}] ${card.card.name} (${cost})`);
    }
  }

  // Castable commanders
  lines.push('');
  lines.push('Castable Commanders (from command zone):');
  if (legal.castableCommanders.length === 0) {
    lines.push('  (none)');
  } else {
    for (const cz of legal.castableCommanders) {
      const cost = formatManaCost(cz.instance.card.manaCost);
      const tax = cz.castCount * 2;
      lines.push(`  [${cz.instance.id}] ${cz.instance.card.name} (${cost} + ${tax} commander tax) — cast ${cz.castCount} time(s)`);
    }
  }

  // Playable lands
  lines.push('');
  lines.push('Playable Lands:');
  if (legal.playableLands.length === 0) {
    lines.push('  (none)');
  } else {
    for (const card of legal.playableLands) {
      lines.push(`  [${card.id}] ${card.card.name}`);
    }
  }

  // Activatable abilities
  lines.push('');
  lines.push('Activatable Abilities:');
  if (legal.activatableAbilities.length === 0) {
    lines.push('  (none)');
  } else {
    for (const perm of legal.activatableAbilities) {
      lines.push(`  [${perm.id}] ${perm.card.name} (mana ability)`);
    }
  }

  // Can attack
  lines.push('');
  lines.push('Available Attackers:');
  if (legal.canAttack.length === 0) {
    lines.push('  (none)');
  } else {
    for (const perm of legal.canAttack) {
      const p = perm.card.power ?? '?';
      const t = perm.card.toughness ?? '?';
      lines.push(`  [${perm.id}] ${perm.card.name} ${p}/${t}`);
    }
  }

  // Can block
  lines.push('');
  lines.push('Available Blockers:');
  if (legal.canBlock.length === 0) {
    lines.push('  (none)');
  } else {
    for (const perm of legal.canBlock) {
      const p = perm.card.power ?? '?';
      const t = perm.card.toughness ?? '?';
      lines.push(`  [${perm.id}] ${perm.card.name} ${p}/${t}`);
    }
  }

  // Pass / Respond
  lines.push('');
  lines.push(`Can Pass: ${legal.canPass ? 'Yes' : 'No'}`);
  lines.push(`Can Respond: ${legal.canRespond ? 'Yes' : 'No'}`);

  return lines.join('\n');
}

// === Agent Decision Functions ===

/**
 * Sends a game state and legal actions to the LLM and returns the agent's decision.
 * Falls back to a pass action on any error or parse failure.
 */
export async function getAgentDecision(
  request: LLMActionRequest
): Promise<LLMActionResponse> {
  try {
    const client = getLLMClient();
    const model = getDefaultModel();

    // Build user prompt
    const recentActionsText = request.recentActions.length > 0
      ? request.recentActions
          .map((a: GameLogEntry) => `  Turn ${a.turn} P${a.player} ${a.phase}: ${a.action}${a.card ? ` (${a.card})` : ''} — ${a.details}`)
          .join('\n')
      : '  (none)';

    const userPrompt = [
      `Turn ${request.turn}, Phase: ${request.phase}`,
      `Deck: ${request.deckName} (${request.deckStrategy})`,
      '',
      request.gameSummary,
      '',
      formatLegalActions(request.legalActions),
      '',
      '=== RECENT ACTIONS ===',
      recentActionsText,
      '',
      'Choose your actions. Respond with JSON: { "actions": [...], "reasoning": "..." }',
      'Each action should have a "type" field (cast, activate, attack, block, pass, play_land, respond).',
      'For cast/play_land: include "cardId". For activate: include "permanentId".',
      'Commanders can be cast from the command zone using their command zone ID (e.g. "commander-0").',
      'For attack: include "attackers" as { "permanentId": { "type": "player", "id": "targetId" } }.',
      'For block: include "blockers" as { "blockerId": ["attackerId"] }.',
    ].join('\n');

    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are an expert Magic: The Gathering Commander player. Analyze the game state and choose the best actions. Respond with JSON: { "actions": [...], "reasoning": "..." }',
        },
        {
          role: 'user',
          content: userPrompt,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.7,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return {
        actions: [{ type: 'pass' }],
        reasoning: 'LLM returned empty response',
      };
    }

    const parsed = JSON.parse(content) as {
      actions?: unknown[];
      reasoning?: string;
    };

    if (!Array.isArray(parsed.actions)) {
      return {
        actions: [{ type: 'pass' }],
        reasoning: 'LLM response missing actions array',
      };
    }

    // Validate each action has a type
    const validActions: GameAction[] = parsed.actions
      .filter((a): a is Record<string, unknown> => typeof a === 'object' && a !== null && 'type' in a)
      .map((a) => {
        const action: GameAction = { type: a.type as GameAction['type'] };
        if (typeof a.cardId === 'string') action.cardId = a.cardId;
        if (typeof a.permanentId === 'string') action.permanentId = a.permanentId;
        if (Array.isArray(a.targets)) action.targets = a.targets as GameAction['targets'];
        if (a.attackers && typeof a.attackers === 'object') action.attackers = a.attackers as Record<string, Target>;
        if (a.blockers && typeof a.blockers === 'object') action.blockers = a.blockers as Record<string, string[]>;
        if (typeof a.reasoning === 'string') action.reasoning = a.reasoning;
        return action;
      });

    if (validActions.length === 0) {
      return {
        actions: [{ type: 'pass' }],
        reasoning: 'No valid actions parsed from LLM response',
      };
    }

    return {
      actions: validActions,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    };
  } catch (error) {
    return {
      actions: [{ type: 'pass' }],
      reasoning: `Failed to parse LLM response: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Sends the opening hand to the LLM and returns a mulligan decision.
 * Falls back to keeping the hand on any error or parse failure.
 */
export async function getMulliganDecision(
  hand: CardInstance[],
  deckName: string,
  deckStrategy: string,
  mulligansTaken: number
): Promise<{ keep: boolean; reasoning: string }> {
  try {
    const client = getLLMClient();
    const model = getDefaultModel();

    const handDescription = hand.length > 0
      ? hand
          .map((card) => {
            const cost = formatManaCost(card.card.manaCost);
            return `  [${card.id}] ${card.card.name} (${cost}) — ${card.card.typeLine}`;
          })
          .join('\n')
      : '  (empty hand)';

    const userPrompt = [
      `Deck: ${deckName}`,
      `Strategy: ${deckStrategy}`,
      `Mulligans taken so far: ${mulligansTaken}`,
      '',
      '=== YOUR HAND ===',
      handDescription,
      '',
      'Should you keep this hand or mulligan? Respond with JSON: { "keep": boolean, "reasoning": string }',
      'Consider: land count, mana curve, color requirements, early plays, synergy with deck strategy.',
      `Remember: you have ${hand.length} cards and will draw to ${7 - mulligansTaken} cards if you mulligan (bottom ${mulligansTaken} after scry).`,
    ].join('\n');

    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are a Magic: The Gathering player deciding whether to keep your opening hand. Analyze the hand quality considering land count, mana curve, color requirements, and synergy. Respond with JSON: { "keep": boolean, "reasoning": string }',
        },
        {
          role: 'user',
          content: userPrompt,
        },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return { keep: true, reasoning: 'Failed to parse mulligan decision' };
    }

    const parsed = JSON.parse(content) as {
      keep?: unknown;
      reasoning?: unknown;
    };

    if (typeof parsed.keep !== 'boolean') {
      return { keep: true, reasoning: 'Mulligan decision missing boolean "keep" field' };
    }

    return {
      keep: parsed.keep,
      reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    };
  } catch (error) {
    return {
      keep: true,
      reasoning: `Failed to parse mulligan decision: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
