import crypto from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DeckInput, DeckStats, GameResult, TournamentResult } from './types.js';
import { runGame } from './game-engine.js';
import { shuffleArray } from './game-state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Runs a tournament of Commander games across multiple decks.
 *
 * 1. Generates a tournament ID
 * 2. For each game, randomizes seat order and runs a game
 * 3. Saves per-game results to simulation-games/game-{NNN}.json
 * 4. Calculates aggregate statistics per deck
 * 5. Writes simulation-results.json with the full TournamentResult
 * 6. Returns the TournamentResult
 */
export async function runTournament(
  decks: DeckInput[],
  numGames: number
): Promise<TournamentResult> {
  const tournamentId = crypto.randomUUID();
  const deckNames = decks.map((d) => d.name);

  // Ensure output directory exists
  const outputDir = join(__dirname, '..', 'simulation-games');
  mkdirSync(outputDir, { recursive: true });

  // Stats tracking per deck name
  const statsMap = new Map<
    string,
    { wins: number; losses: number; totalTurnsSurvived: number; gamesPlayed: number }
  >();

  for (const name of deckNames) {
    statsMap.set(name, { wins: 0, losses: 0, totalTurnsSurvived: 0, gamesPlayed: 0 });
  }

  const gameLogs: string[] = [];

  for (let gameNum = 1; gameNum <= numGames; gameNum++) {
    // Randomize seat order by shuffling a copy of the deck array
    const seatOrder = shuffleArray(decks.map((d, i) => i));
    const shuffledDecks = seatOrder.map((i) => decks[i]);

    // Run the game
    const result: GameResult = await runGame(shuffledDecks);

    // Remap player results back to original deck names
    // seatOrder[seatIndex] gives the original deck index
    const remappedPlayers = result.players.map((pr) => ({
      ...pr,
      deckName: decks[seatOrder[pr.seatIndex]].name,
    }));

    const remappedWinner = result.winner
      ? {
          ...result.winner,
          deckName: decks[seatOrder[result.winner.seatIndex]].name,
        }
      : null;

    const remappedResult: GameResult = {
      ...result,
      players: remappedPlayers,
      winner: remappedWinner,
    };

    // Update stats
    for (const pr of remappedResult.players) {
      const stats = statsMap.get(pr.deckName)!;
      stats.gamesPlayed++;
      if (pr.result === 'win') {
        stats.wins++;
      } else {
        stats.losses++;
      }
      stats.totalTurnsSurvived += pr.turnsSurvived;
    }

    // Save per-game result
    const gameFileName = `game-${String(gameNum).padStart(3, '0')}.json`;
    const gameFilePath = join(outputDir, gameFileName);
    writeFileSync(gameFilePath, JSON.stringify(remappedResult, null, 2), 'utf-8');
    gameLogs.push(`simulation-games/${gameFileName}`);
  }

  // Calculate aggregate statistics
  const results: Record<string, DeckStats> = {};
  for (const [name, stats] of statsMap) {
    results[name] = {
      wins: stats.wins,
      losses: stats.losses,
      winRate: stats.gamesPlayed > 0 ? stats.wins / stats.gamesPlayed : 0,
      avgTurnsSurvived:
        stats.gamesPlayed > 0 ? stats.totalTurnsSurvived / stats.gamesPlayed : 0,
    };
  }

  const tournamentResult: TournamentResult = {
    tournamentId,
    decks: deckNames,
    gamesPlayed: numGames,
    results,
    gameLogs,
  };

  // Write aggregate results
  const resultsPath = join(__dirname, '..', 'simulation-results.json');
  writeFileSync(resultsPath, JSON.stringify(tournamentResult, null, 2), 'utf-8');

  return tournamentResult;
}
