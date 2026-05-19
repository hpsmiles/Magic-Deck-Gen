import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeckStats, GameResult, TournamentResult } from './types.js';
import { getLLMClient, getDefaultModel, llmCallWithRetry } from './llm-agent.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Generates a narrative markdown report from tournament results.
 *
 * 1. Builds a summary prompt with tournament statistics and key moments
 * 2. Calls the LLM to generate a creative narrative report
 * 3. Writes the report to simulation-report.md
 * 4. Falls back to a basic stats report if the LLM call fails
 */
export async function generateNarrativeReport(
  tournamentResult: TournamentResult,
  gameResults: GameResult[]
): Promise<void> {
  const systemPrompt = [
    'You are a Magic: The Gathering tournament commentator and analyst.',
    'Write an engaging narrative report about a Commander tournament.',
    '',
    'Your report MUST include these sections:',
    '',
    '## Overall Standings',
    'A markdown table with columns: Deck, Wins, Losses, Win Rate, Avg Turns Survived.',
    'Sort by win rate descending.',
    '',
    '## Deck Analysis',
    'For each deck, write 2-3 sentences about its performance, strengths, and weaknesses.',
    'Consider win rate, average turns survived, and overall consistency.',
    '',
    '## Notable Games',
    'Highlight 2-3 of the most interesting games. Focus on:',
    '- Closest games (most total turns)',
    '- Biggest comebacks (decks that won despite surviving fewer turns on average)',
    '- Any dramatic moments visible in the game logs',
    '',
    '## Commander Damage Breakdown',
    'Summarize how commander damage influenced games, if visible in the logs.',
    '',
    '## Recommendations',
    'For each deck, suggest 1-2 specific improvements based on performance.',
    '',
    'Write in an engaging, conversational tone. Use MTG terminology naturally.',
  ].join('\n');

  // Build user prompt with all tournament data
  const userPrompt = [
    '=== TOURNAMENT DATA ===',
    '',
    `Tournament ID: ${tournamentResult.tournamentId}`,
    `Decks: ${tournamentResult.decks.join(', ')}`,
    `Games Played: ${tournamentResult.gamesPlayed}`,
    '',
    '=== DECK STATISTICS ===',
    ...Object.entries(tournamentResult.results).map(
      ([name, stats]: [string, DeckStats]) =>
        `${name}: ${stats.wins}W/${stats.losses}L, Win Rate: ${(stats.winRate * 100).toFixed(1)}%, Avg Turns Survived: ${stats.avgTurnsSurvived.toFixed(1)}`
    ),
    '',
    '=== GAME RESULTS ===',
    ...gameResults.map((game, i) => {
      const winnerStr = game.winner
        ? `Winner: ${game.winner.deckName}`
        : 'No winner (draw/timeout)';
      const playersStr = game.players
        .map((p) => `${p.deckName} (${p.result}, survived ${p.turnsSurvived} turns)`)
        .join(', ');
      return `Game ${i + 1}: ${winnerStr} | Total Turns: ${game.totalTurns} | Players: ${playersStr}`;
    }),
    '',
    '=== KEY GAME LOGS (most interesting games, last 20 entries each) ===',
    ...selectInterestingGames(gameResults, 5).map(({ game, index }) => {
      const logEntries = game.log
        .slice(-20)
        .map((e) => `  T${e.turn} P${e.player} ${e.phase}: ${e.action}${e.card ? ` (${e.card})` : ''} — ${e.details}`)
        .join('\n');
      return `Game ${index + 1} (last 20 entries):\n${logEntries}`;
    }),
  ].join('\n');

  try {
    const client = getLLMClient();
    const model = getDefaultModel();

    const content = await llmCallWithRetry(client, model, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
    ]);

    if (content) {
      // Strip markdown code fences if the LLM wrapped its output
      const cleaned = content.replace(/^```(?:markdown)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
      const reportPath = join(__dirname, '..', 'simulation-report.md');
      writeFileSync(reportPath, cleaned, 'utf-8');
      return;
    }

    // Empty response — fall through to fallback
  } catch {
    // LLM call failed — fall through to fallback
  }

  // Fallback: generate a basic markdown report from raw stats
  const fallbackReport = buildFallbackReport(tournamentResult, gameResults);
  const reportPath = join(__dirname, '..', 'simulation-report.md');
  writeFileSync(reportPath, fallbackReport, 'utf-8');
}

/**
 * Selects the most interesting games for the LLM prompt.
 * Prioritizes: longest games (closest), games with comebacks, then fills with others.
 */
function selectInterestingGames(
  games: GameResult[],
  count: number
): Array<{ game: GameResult; index: number }> {
  if (games.length <= count) {
    return games.map((game, index) => ({ game, index }));
  }

  // Score each game by "interestingness" — longer games are more interesting
  const scored = games.map((game, index) => ({
    game,
    index,
    score: game.totalTurns + (game.log.length * 0.1),
  }));

  // Sort by score descending and take top N
  scored.sort((a, b) => b.score - a.score);
  const selected = scored.slice(0, count);

  // Return in original game order for readability
  selected.sort((a, b) => a.index - b.index);
  return selected.map(({ game, index }) => ({ game, index }));
}

/**
 * Builds a basic fallback markdown report from raw tournament statistics.
 */
function buildFallbackReport(
  tournamentResult: TournamentResult,
  gameResults: GameResult[]
): string {
  const lines: string[] = [];

  lines.push('# Tournament Report');
  lines.push('');
  lines.push(`**Tournament ID:** ${tournamentResult.tournamentId}`);
  lines.push(`**Games Played:** ${tournamentResult.gamesPlayed}`);
  lines.push('');

  // Overall Standings table
  lines.push('## Overall Standings');
  lines.push('');
  lines.push('| Deck | Wins | Losses | Win Rate | Avg Turns Survived |');
  lines.push('|------|------|--------|----------|---------------------|');

  const sortedDecks = Object.entries(tournamentResult.results).sort(
    (a, b) => b[1].winRate - a[1].winRate
  );

  for (const [name, stats] of sortedDecks) {
    lines.push(
      `| ${name} | ${stats.wins} | ${stats.losses} | ${(stats.winRate * 100).toFixed(1)}% | ${stats.avgTurnsSurvived.toFixed(1)} |`
    );
  }

  lines.push('');

  // Per-deck stats
  lines.push('## Deck Statistics');
  lines.push('');

  for (const [name, stats] of sortedDecks) {
    lines.push(`### ${name}`);
    lines.push(`- Wins: ${stats.wins}`);
    lines.push(`- Losses: ${stats.losses}`);
    lines.push(`- Win Rate: ${(stats.winRate * 100).toFixed(1)}%`);
    lines.push(`- Average Turns Survived: ${stats.avgTurnsSurvived.toFixed(1)}`);
    lines.push('');
  }

  // Game summary
  lines.push('## Game Summary');
  lines.push('');

  for (let i = 0; i < gameResults.length; i++) {
    const game = gameResults[i];
    const winnerStr = game.winner ? game.winner.deckName : 'No winner';
    lines.push(`**Game ${i + 1}:** Winner: ${winnerStr} | Total Turns: ${game.totalTurns}`);
    for (const p of game.players) {
      lines.push(`  - ${p.deckName}: ${p.result} (survived ${p.turnsSurvived} turns)`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
