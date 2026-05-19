import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isArchidektUrl, fetchDeckFromArchidekt, loadDeckFromLocalFile } from './archidekt-fetcher.js';
import { runTournament } from './tournament-runner.js';
import { generateNarrativeReport } from './narrative-generator.js';
import type { DeckInput, TournamentResult, GameResult } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// === Usage ===

function printUsage(): void {
  console.log(`Usage: simulate.ts --decks <path1> <path2> [<path3>...] [--games <N>]

Options:
  --decks <paths...>  Deck sources (local JSON files or Archidekt URLs, min 2)
  --games <N>         Number of games to simulate (default: 10)
  --help, -h          Show this help message

Examples:
  npx tsx simulate.ts --decks deck1.json deck2.json --games 5
  npx tsx simulate.ts --decks https://archidekt.com/decks/12345 deck2.json`);
}

// === Argument Parsing ===

interface ParsedArgs {
  deckSources: string[];
  numGames: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let deckSources: string[] = [];
  let numGames = 10;
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    if (arg === '--decks') {
      i++;
      // Collect all subsequent args until another -- flag
      while (i < args.length && !args[i].startsWith('--')) {
        deckSources.push(args[i]);
        i++;
      }
      continue;
    }

    if (arg === '--games') {
      i++;
      if (i >= args.length) {
        console.error('Error: --games requires a number argument');
        process.exit(1);
      }
      const parsed = parseInt(args[i], 10);
      if (isNaN(parsed) || parsed < 1) {
        console.error(`Error: --games must be a positive integer, got: ${args[i]}`);
        process.exit(1);
      }
      numGames = parsed;
      i++;
      continue;
    }

    console.error(`Error: Unknown argument: ${arg}`);
    printUsage();
    process.exit(1);
  }

  if (deckSources.length < 2) {
    console.error('Error: At least 2 deck sources are required (--decks <path1> <path2> ...)');
    printUsage();
    process.exit(1);
  }

  return { deckSources, numGames };
}

// === Deck Loading ===

async function loadDecks(sources: string[]): Promise<DeckInput[]> {
  const decks: DeckInput[] = [];

  for (const source of sources) {
    try {
      let deck: DeckInput;

      if (isArchidektUrl(source)) {
        console.log(`Fetching deck from Archidekt: ${source}`);
        deck = await fetchDeckFromArchidekt(source);
      } else {
        console.log(`Loading deck from file: ${source}`);
        deck = await loadDeckFromLocalFile(source);
      }

      decks.push(deck);
      console.log(`  Loaded: ${deck.name} (${deck.cards.length} cards, commander: ${deck.commander.name})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  Failed to load deck from "${source}": ${message}`);
    }
  }

  return decks;
}

// === Main ===

async function main(): Promise<void> {
  const { deckSources, numGames } = parseArgs(process.argv);

  console.log(`\n=== Commander Game Simulator ===`);
  console.log(`Loading ${deckSources.length} deck(s)...\n`);

  const decks = await loadDecks(deckSources);

  if (decks.length < 2) {
    console.error(`\nError: Need at least 2 valid decks to run a tournament, but only ${decks.length} loaded successfully.`);
    process.exit(1);
  }

  console.log(`\nRunning tournament: ${decks.length} decks, ${numGames} game(s)...\n`);

  const tournamentResult = await runTournament(decks, numGames);

  // Load game results from saved files for narrative generation
  const gameResults: GameResult[] = [];
  for (const gameLogPath of tournamentResult.gameLogs) {
    try {
      const fullPath = join(__dirname, '..', gameLogPath);
      const raw = await readFile(fullPath, 'utf-8');
      gameResults.push(JSON.parse(raw) as GameResult);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Warning: Could not read game log ${gameLogPath}: ${message}`);
    }
  }

  // Generate narrative report
  try {
    await generateNarrativeReport(tournamentResult, gameResults);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Warning: Failed to generate narrative report: ${message}`);
  }

  // Print summary
  console.log(`\n=== Tournament Complete ===`);
  console.log(`Tournament ID: ${tournamentResult.tournamentId}`);
  console.log(`Games Played: ${tournamentResult.gamesPlayed}`);
  console.log(`\nResults:`);

  for (const deckName of tournamentResult.decks) {
    const stats = tournamentResult.results[deckName];
    if (stats) {
      const winPct = (stats.winRate * 100).toFixed(1);
      const avgTurns = stats.avgTurnsSurvived.toFixed(1);
      console.log(`  ${deckName}: ${stats.wins} wins (${winPct}%) — avg ${avgTurns} turns survived`);
    }
  }

  console.log(`\nReport saved to: simulation-report.md`);
  console.log(`Game logs saved to: simulation-games/`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Fatal error: ${message}`);
  process.exit(1);
});
