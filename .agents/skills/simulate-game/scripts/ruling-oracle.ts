import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RulingRequest, RulingResponse } from './types.js';
import { getLLMClient, getDefaultModel } from './llm-agent.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CACHE_FILE = join(__dirname, 'ruling-cache.json');

const SYSTEM_PROMPT = `You are a Magic: The Gathering judge. Provide accurate rulings based on the Comprehensive Rules. Respond with JSON: { "ruling": "brief ruling", "explanation": "detailed explanation with CR references" }`;

/**
 * Creates a cache key from sorted card names + rules question.
 */
export function hashInteraction(request: RulingRequest): string {
  const sortedNames = request.cards
    .map((c) => c.name)
    .sort()
    .join('|');
  const raw = `${sortedNames}::${request.rulesQuestion}`;
  // Simple hash using base64 of the concatenated string
  return Buffer.from(raw).toString('base64');
}

/**
 * Reads the ruling cache from disk. Returns empty object on file not found or parse error.
 */
export function loadCache(): Record<string, RulingResponse> {
  try {
    const data = readFileSync(CACHE_FILE, 'utf-8');
    return JSON.parse(data) as Record<string, RulingResponse>;
  } catch {
    return {};
  }
}

/**
 * Writes the ruling cache to disk.
 */
export function saveCache(cache: Record<string, RulingResponse>): void {
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
}

/**
 * Gets a ruling for an MTG interaction. Checks cache first, then calls LLM.
 * On parse failure or LLM error, returns a fallback response.
 */
export async function getRuling(request: RulingRequest): Promise<RulingResponse> {
  const key = hashInteraction(request);

  // Check cache
  const cache = loadCache();
  if (cache[key]) {
    return cache[key];
  }

  // Build user prompt
  const cardDetails = request.cards
    .map((c) => `- ${c.name}: ${c.oracleText}`)
    .join('\n');

  const userPrompt = [
    `Interaction: ${request.interaction}`,
    '',
    'Cards involved:',
    cardDetails,
    '',
    `Game state context: ${request.gameState}`,
    '',
    `Rules question: ${request.rulesQuestion}`,
  ].join('\n');

  try {
    const client = getLLMClient();
    const model = getDefaultModel();

    const response = await client.chat.completions.create({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      return {
        ruling: 'unable to determine',
        explanation: 'Failed to parse ruling response',
      };
    }

    const parsed = JSON.parse(content) as RulingResponse;

    if (typeof parsed.ruling !== 'string' || typeof parsed.explanation !== 'string') {
      return {
        ruling: 'unable to determine',
        explanation: 'Failed to parse ruling response',
      };
    }

    // Cache the result
    cache[key] = parsed;
    saveCache(cache);

    return parsed;
  } catch {
    return {
      ruling: 'unable to determine',
      explanation: 'Failed to parse ruling response',
    };
  }
}
