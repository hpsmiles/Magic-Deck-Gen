import { execFileSync } from "node:child_process";
import { resolve, basename, join } from "node:path";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";

// ── Types ──────────────────────────────────────────────────────────────────

interface CropResult {
  photo: string;
  cards: number;
  total_detections?: number;
  error?: string;
}

interface CropSummary {
  total_cards: number;
  total_photos: number;
  output_dir: string;
  results: CropResult[];
}

// ── Constants ──────────────────────────────────────────────────────────────

const SCRIPT_DIR = resolve(import.meta.dirname ?? ".");
const PYTHON_SCRIPT = join(SCRIPT_DIR, "crop_cards.py");
const CROPPED_DIR_NAME = "cropped";

// ── Helpers ────────────────────────────────────────────────────────────────

function findPython(): string {
  // Try python3 first, then python
  for (const cmd of ["python3", "python"]) {
    try {
      const version = execFileSync(cmd, ["--version"], { encoding: "utf-8", timeout: 5000 });
      if (version.includes("Python 3")) return cmd;
    } catch {
      // Not found or wrong version
    }
  }
  console.error("ERROR: Python 3 not found. Install Python 3.8+ and ensure it's on PATH.");
  process.exit(1);
}

function parseCliArgs(args: string[]): {
  photoDir: string;
  conf: number;
  imgsz: number;
  outputSize: string;
} {
  let photoDir = "";
  let conf = 0.25;
  let imgsz = 1088;
  let outputSize = "350x490";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--conf" && args[i + 1]) {
      conf = parseFloat(args[++i]);
    } else if (args[i] === "--imgsz" && args[i + 1]) {
      imgsz = parseInt(args[++i], 10);
    } else if (args[i] === "--output-size" && args[i + 1]) {
      outputSize = args[++i];
    } else if (!args[i].startsWith("--")) {
      photoDir = args[i];
    }
  }

  return { photoDir, conf, imgsz, outputSize };
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { photoDir, conf, imgsz, outputSize } = parseCliArgs(args);

  if (!photoDir) {
    console.error(
      "Usage: npx tsx crop-cards.ts <photo-dir> [--conf 0.25] [--imgsz 1088] [--output-size 350x490]"
    );
    console.error("");
    console.error("Prerequisites:");
    console.error("  - Python 3.8+ with ultralytics and opencv-python installed");
    console.error("  - cardcaptor-v3 model (auto-downloaded from HuggingFace on first run)");
    process.exit(1);
  }

  const resolvedDir = resolve(photoDir);

  try {
    const stat = statSync(resolvedDir);
    if (!stat.isDirectory()) throw new Error("Not a directory");
  } catch {
    console.error(`Error: Directory not found: ${resolvedDir}`);
    process.exit(1);
  }

  // Find Python
  const python = findPython();
  console.error(`Using Python: ${python}`);

  // Build Python script arguments
  const pythonArgs = [PYTHON_SCRIPT, resolvedDir, "--conf", String(conf), "--imgsz", String(imgsz), "--output-size", outputSize];

  console.error(`Running: ${python} ${pythonArgs.join(" ")}`);

  try {
    // Run the Python crop script
    // stdout gets JSON summary, stderr gets progress messages
    const stdout = execFileSync(python, pythonArgs, {
      encoding: "utf-8",
      timeout: 600_000, // 10 minutes max for large collections
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for large JSON output
    });

    // Parse the JSON summary from stdout
    const summary: CropSummary = JSON.parse(stdout);

    console.error(`\nCrop complete: ${summary.total_cards} cards from ${summary.total_photos} photos`);
    console.error(`Output: ${summary.output_dir}`);

    // Also write summary to the cropped directory for downstream consumption
    const summaryPath = join(summary.output_dir, "crop-summary.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    console.error(`Summary written to: ${summaryPath}`);
  } catch (err: unknown) {
    if (err instanceof Error && "stderr" in err) {
      const execErr = err as Error & { stderr?: string; stdout?: string };
      console.error(`Python script error:\n${execErr.stderr || execErr.message}`);
    } else {
      console.error(`Error running crop script: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }
}

main().catch((err: Error) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
