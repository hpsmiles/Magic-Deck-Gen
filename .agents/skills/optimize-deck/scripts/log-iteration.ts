import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

interface Change {
  action: "remove" | "add";
  card: string;
  reason: string;
}

interface ValidationResult {
  valid: boolean;
  errorCount: number;
  warningCount: number;
}

interface IterationData {
  iteration: number;
  changes: Change[];
  reasoning: string;
  validationResult: ValidationResult;
}

interface IterationEntry extends IterationData {
  timestamp: string;
}

interface Metadata {
  deckFile: string;
  startedAt: string;
  completedAt: string | null;
  totalIterations: number;
  finalValid: boolean;
}

interface OptimizationLog {
  metadata: Metadata;
  iterations: IterationEntry[];
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error(
      "Usage: npx tsx log-iteration.ts <iteration-data-json> [log-path]"
    );
    console.error("       npx tsx log-iteration.ts --complete [log-path]");
    process.exit(1);
  }

  const isComplete = args[0] === "--complete";

  if (isComplete) {
    const logPath = resolve(args[1] ?? "optimization-log.json");
    handleComplete(logPath);
  } else {
    const iterationDataJson = args[0];
    const logPath = resolve(args[1] ?? "optimization-log.json");
    handleLogIteration(iterationDataJson, logPath);
  }
}

function handleComplete(logPath: string): void {
  if (!existsSync(logPath)) {
    console.error(`Error: Log file not found at ${logPath}`);
    process.exit(1);
  }

  const log: OptimizationLog = JSON.parse(readFileSync(logPath, "utf-8"));
  log.metadata.completedAt = new Date().toISOString();

  writeFileSync(logPath, JSON.stringify(log, null, 2) + "\n");
  console.log(`Optimization marked as complete at ${log.metadata.completedAt}`);
}

function handleLogIteration(iterationDataJson: string, logPath: string): void {
  let iterationData: IterationData;
  try {
    iterationData = JSON.parse(iterationDataJson);
  } catch (e) {
    console.error("Error: Invalid JSON provided for iteration data");
    process.exit(1);
  }

  // Validate required fields
  if (
    typeof iterationData.iteration !== "number" ||
    !Array.isArray(iterationData.changes) ||
    typeof iterationData.reasoning !== "string" ||
    !iterationData.validationResult ||
    typeof iterationData.validationResult.valid !== "boolean"
  ) {
    console.error(
      "Error: Iteration data must include iteration (number), changes (array), reasoning (string), and validationResult (object with valid boolean)"
    );
    process.exit(1);
  }

  const newEntry: IterationEntry = {
    ...iterationData,
    timestamp: new Date().toISOString(),
  };

  let log: OptimizationLog;

  if (existsSync(logPath)) {
    // Read existing log and append
    try {
      log = JSON.parse(readFileSync(logPath, "utf-8"));
    } catch (e) {
      console.error("Error: Could not parse existing optimization-log.json");
      process.exit(1);
    }

    log.iterations.push(newEntry);
    log.metadata.totalIterations = log.iterations.length;
    log.metadata.finalValid = iterationData.validationResult.valid;
  } else {
    // Create new log
    log = {
      metadata: {
        deckFile: "deck.json",
        startedAt: new Date().toISOString(),
        completedAt: null,
        totalIterations: 1,
        finalValid: iterationData.validationResult.valid,
      },
      iterations: [newEntry],
    };
  }

  writeFileSync(logPath, JSON.stringify(log, null, 2) + "\n");
  console.log(
    `Iteration ${iterationData.iteration} logged to ${logPath}`
  );
}

main();
