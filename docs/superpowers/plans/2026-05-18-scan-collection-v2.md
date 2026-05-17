# Scan Collection v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign scan-collection to use OpenCV card cropping before vision scanning, replacing the single-pass full-photo approach with a three-script pipeline.

**Architecture:** Three independent scripts — crop-cards.ts (OpenCV contour detection + perspective transform → individual card images), scan-cards.ts (Gemma 4 vision scan of each cropped card + validation pass → raw-cards.json), enrich-cards.ts (Scryfall enrichment, mostly unchanged). Each script reads from disk and writes to disk, enabling user review between steps.

**Tech Stack:** @techstark/opencv-js (WASM OpenCV), sharp (image I/O), openai SDK (LM Studio API for Gemma 4), TypeScript ES2022/Node16

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `.agents/skills/scan-collection/scripts/crop-cards.ts` | Create | OpenCV card detection, perspective transform, crop to individual images |
| `.agents/skills/scan-collection/scripts/scan-cards.ts` | Create | Single-card vision scan + validation via Gemma 4 |
| `.agents/skills/scan-collection/scripts/scan-photos.ts` | Delete | Replaced by crop-cards.ts + scan-cards.ts |
| `.agents/skills/scan-collection/scripts/enrich-cards.ts` | Modify | Add setName/collectorNumber fields to DetectedCard, use in Scryfall lookup |
| `.agents/skills/scan-collection/scripts/package.json` | Modify | Add @techstark/opencv-js dependency |
| `.agents/skills/scan-collection/SKILL.md` | Modify | Update workflow to 3-step pipeline |

---

### Task 1: Install @techstark/opencv-js dependency

**Files:**
- Modify: `.agents/skills/scan-collection/scripts/package.json`

- [ ] **Step 1: Add @techstark/opencv-js to package.json**

Change `.agents/skills/scan-collection/scripts/package.json` to:

```json
{
  "name": "scan-collection-scripts",
  "version": "2.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@techstark/opencv-js": "^4.11.0",
    "openai": "^4.100.0",
    "sharp": "^0.33.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 2: Run npm install**

Run: `cd .agents/skills/scan-collection/scripts && npm install`
Expected: Installs @techstark/opencv-js and its dependencies with no errors

- [ ] **Step 3: Verify import works**

Run: `cd .agents/skills/scan-collection/scripts && npx tsx -e "import cv from '@techstark/opencv-js'; console.log('OpenCV loaded:', typeof cv)"`
Expected: Prints `OpenCV loaded: object` (may take a moment for WASM init)

- [ ] **Step 4: Commit**

```bash
git add .agents/skills/scan-collection/scripts/package.json .agents/skills/scan-collection/scripts/package-lock.json
git commit -m "chore: add @techstark/opencv-js dependency for card cropping"
```

---

### Task 2: Build crop-cards.ts — OpenCV card detection and cropping

**Files:**
- Create: `.agents/skills/scan-collection/scripts/crop-cards.ts`

- [ ] **Step 1: Write crop-cards.ts**

Create `.agents/skills/scan-collection/scripts/crop-cards.ts` with the following complete implementation:

```typescript
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from "node:fs";
import { resolve, extname, basename, join } from "node:path";
import sharp from "sharp";

// ── Types ──────────────────────────────────────────────────────────────────

interface DetectedRect {
  x: number;
  y: number;
  width: number;
  height: number;
  vertices: { x: number; y: number }[];
  area: number;
  isRect: boolean; // true if approxPolyDP found 4 vertices
}

interface CropResult {
  photoName: string;
  cardsCropped: number;
  uncertainCrops: number;
  errors: string[];
}

// ── Constants ──────────────────────────────────────────────────────────────

const SUPPORTED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const DEFAULT_MIN_AREA_PCT = 1;
const DEFAULT_MAX_AREA_PCT = 80;
const DEFAULT_CARD_RATIO = 0.714; // 2.5 / 3.5 (MTG card width/height)
const DEFAULT_RATIO_TOLERANCE = 0.15;
const CROPPED_DIR_NAME = "cropped";

// ── Helpers ────────────────────────────────────────────────────────────────

function isImageFile(filename: string): boolean {
  const ext = extname(filename).toLowerCase();
  return SUPPORTED_EXTENSIONS.includes(ext);
}

function parseCliArgs(args: string[]): {
  photoDir: string;
  minAreaPct: number;
  maxAreaPct: number;
  cardRatio: number;
  ratioTolerance: number;
} {
  let photoDir = "";
  let minAreaPct = DEFAULT_MIN_AREA_PCT;
  let maxAreaPct = DEFAULT_MAX_AREA_PCT;
  let cardRatio = DEFAULT_CARD_RATIO;
  let ratioTolerance = DEFAULT_RATIO_TOLERANCE;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--min-area-pct" && args[i + 1]) {
      minAreaPct = parseFloat(args[++i]);
    } else if (args[i] === "--max-area-pct" && args[i + 1]) {
      maxAreaPct = parseFloat(args[++i]);
    } else if (args[i] === "--card-ratio" && args[i + 1]) {
      cardRatio = parseFloat(args[++i]);
    } else if (args[i] === "--ratio-tolerance" && args[i + 1]) {
      ratioTolerance = parseFloat(args[++i]);
    } else if (!args[i].startsWith("--")) {
      photoDir = args[i];
    }
  }

  return { photoDir, minAreaPct, maxAreaPct, cardRatio, ratioTolerance };
}

// ── OpenCV Card Detection ──────────────────────────────────────────────────

async function detectCards(
  filePath: string,
  minAreaPct: number,
  maxAreaPct: number,
  cardRatio: number,
  ratioTolerance: number
): Promise<DetectedRect[]> {
  // Dynamic import — OpenCV.js is WASM and loads async
  const cv = (await import("@techstark/opencv-js")).default;

  // Load image via sharp → raw pixels → OpenCV Mat
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const src = cv.matFromImageData({
    data: new Uint8ClampedArray(data),
    width: info.width,
    height: info.height,
  });

  const imageArea = info.width * info.height;
  const minArea = imageArea * (minAreaPct / 100);
  const maxArea = imageArea * (maxAreaPct / 100);

  // Preprocess: grayscale → blur → threshold
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  const blurred = new cv.Mat();
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

  const thresh = new cv.Mat();
  cv.threshold(blurred, thresh, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);

  // Find contours
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  const detected: DetectedRect[] = [];

  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const area = cv.contourArea(cnt);

    // Filter by area
    if (area < minArea || area > maxArea) {
      cnt.delete();
      continue;
    }

    const perimeter = cv.arcLength(cnt, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(cnt, approx, 0.02 * perimeter, true);

    const isRect = approx.rows === 4;

    if (isRect) {
      // Extract 4 vertices
      const vertices: { x: number; y: number }[] = [];
      for (let j = 0; j < 4; j++) {
        vertices.push({
          x: approx.intAt(j, 0, 0),
          y: approx.intAt(j, 0, 1),
        });
      }

      // Check aspect ratio
      const boundingRect = cv.boundingRect(cnt);
      const detectedRatio = boundingRect.width / boundingRect.height;
      const ratioOk =
        Math.abs(detectedRatio - cardRatio) < ratioTolerance ||
        Math.abs(1 / detectedRatio - cardRatio) < ratioTolerance; // card may be rotated

      if (ratioOk) {
        detected.push({
          x: boundingRect.x,
          y: boundingRect.y,
          width: boundingRect.width,
          height: boundingRect.height,
          vertices,
          area,
          isRect: true,
        });
      }
    } else if (approx.rows >= 4 && approx.rows <= 8) {
      // Not a clean rectangle but could be a card — save as uncertain
      const boundingRect = cv.boundingRect(cnt);
      detected.push({
        x: boundingRect.x,
        y: boundingRect.y,
        width: boundingRect.width,
        height: boundingRect.height,
        vertices: [],
        area,
        isRect: false,
      });
    }

    approx.delete();
    cnt.delete();
  }

  // Cleanup
  src.delete();
  gray.delete();
  blurred.delete();
  thresh.delete();
  contours.delete();
  hierarchy.delete();

  return detected;
}

// ── Sort & Assign Grid Positions ───────────────────────────────────────────

function assignGridPositions(rects: DetectedRect[]): (DetectedRect & { row: number; col: number })[] {
  if (rects.length === 0) return [];

  // Sort by Y first (top to bottom), then by X (left to right)
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);

  // Group into rows: cards in the same row have similar Y values
  // Use a simple clustering approach: if Y difference < 20% of average height, same row
  const avgHeight = sorted.reduce((s, r) => s + r.height, 0) / sorted.length;
  const rowThreshold = avgHeight * 0.4;

  const rows: DetectedRect[][] = [];
  let currentRow: DetectedRect[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i].y - currentRow[0].y) < rowThreshold) {
      currentRow.push(sorted[i]);
    } else {
      // Sort current row by X
      currentRow.sort((a, b) => a.x - b.x);
      rows.push(currentRow);
      currentRow = [sorted[i]];
    }
  }
  currentRow.sort((a, b) => a.x - b.x);
  rows.push(currentRow);

  // Assign R<row>C<col>
  const result: (DetectedRect & { row: number; col: number })[] = [];
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      result.push({ ...rows[r][c], row: r + 1, col: c + 1 });
    }
  }

  return result;
}

// ── Crop & Save ─────────────────────────────────────────────────────────────

async function cropAndSave(
  filePath: string,
  rect: DetectedRect & { row: number; col: number },
  outputDir: string
): Promise<string> {
  const fileName = basename(filePath, extname(filePath));
  const suffix = rect.isRect ? "" : "_uncertain";
  const outputName = `${fileName}_R${rect.row}C${rect.col}${suffix}.jpg`;
  const outputPath = join(outputDir, outputName);

  if (rect.isRect && rect.vertices.length === 4) {
    // Perspective transform to straighten the card
    const cv = (await import("@techstark/opencv-js")).default;

    // Load source image
    const { data, info } = await sharp(filePath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const src = cv.matFromImageData({
      data: new Uint8ClampedArray(data),
      width: info.width,
      height: info.height,
    });

    // Order vertices: top-left, top-right, bottom-right, bottom-left
    const ordered = orderVertices(rect.vertices);

    // Destination: standard MTG card proportions
    const cardWidth = 488; // pixels, reasonable output size
    const cardHeight = 680;

    const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
      ordered[0].x, ordered[0].y,
      ordered[1].x, ordered[1].y,
      ordered[2].x, ordered[2].y,
      ordered[3].x, ordered[3].y,
    ]);
    const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
      0, 0,
      cardWidth, 0,
      cardWidth, cardHeight,
      0, cardHeight,
    ]);

    const M = cv.getPerspectiveTransform(srcPts, dstPts);
    const warped = new cv.Mat();
    cv.warpPerspective(src, warped, M, new cv.Size(cardWidth, cardHeight));

    // Convert warped Mat back to buffer via sharp
    const warpedData = new Uint8ClampedArray(warped.data);
    await sharp(Buffer.from(warpedData), {
      raw: { width: cardWidth, height: cardHeight, channels: 4 },
    })
      .jpeg({ quality: 90 })
      .toFile(outputPath);

    // Cleanup
    src.delete();
    srcPts.delete();
    dstPts.delete();
    M.delete();
    warped.delete();
  } else {
    // Simple rectangular crop (no perspective transform)
    await sharp(filePath)
      .extract({
        left: Math.max(0, rect.x),
        top: Math.max(0, rect.y),
        width: Math.min(rect.width, (await sharp(filePath).metadata()).width! - rect.x),
        height: Math.min(rect.height, (await sharp(filePath).metadata()).height! - rect.y),
      })
      .jpeg({ quality: 90 })
      .toFile(outputPath);
  }

  return outputName;
}

function orderVertices(vertices: { x: number; y: number }[]): { x: number; y: number }[] {
  // Sort by sum of coordinates: top-left has smallest sum, bottom-right has largest
  const bySum = [...vertices].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  // Sort by difference: top-right has smallest diff, bottom-left has largest diff
  const byDiff = [...vertices].sort((a, b) => (a.x - a.y) - (b.x - b.y));

  return [bySum[0], byDiff[byDiff.length - 1], bySum[bySum.length - 1], byDiff[0]];
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const { photoDir, minAreaPct, maxAreaPct, cardRatio, ratioTolerance } = parseCliArgs(args);

  if (!photoDir) {
    console.error("Usage: npx tsx crop-cards.ts <photo-dir> [--min-area-pct 1] [--max-area-pct 80] [--card-ratio 0.714] [--ratio-tolerance 0.15]");
    process.exit(1);
  }

  const resolvedDir = resolve(photoDir);

  // Validate directory
  try {
    const stat = statSync(resolvedDir);
    if (!stat.isDirectory()) throw new Error("Not a directory");
  } catch {
    console.error(`Error: Directory not found: ${resolvedDir}`);
    process.exit(1);
  }

  // Find image files
  const imageFiles = readdirSync(resolvedDir)
    .filter(isImageFile)
    .sort()
    .map((f) => resolve(resolvedDir, f));

  if (imageFiles.length === 0) {
    console.error(`Error: No .jpg/.jpeg/.png/.webp files found in ${resolvedDir}`);
    process.exit(1);
  }

  console.error(`Found ${imageFiles.length} image(s) in ${resolvedDir}`);

  // Create cropped output directory
  const croppedDir = join(resolvedDir, CROPPED_DIR_NAME);
  if (!existsSync(croppedDir)) {
    mkdirSync(croppedDir, { recursive: true });
    console.error(`Created output directory: ${croppedDir}`);
  }

  let totalCards = 0;
  let totalUncertain = 0;
  let totalErrors = 0;

  for (let i = 0; i < imageFiles.length; i++) {
    const filePath = imageFiles[i];
    const fileName = basename(filePath);

    console.error(`\nProcessing ${i + 1}/${imageFiles.length}: ${fileName}`);

    try {
      const rects = await detectCards(filePath, minAreaPct, maxAreaPct, cardRatio, ratioTolerance);

      if (rects.length === 0) {
        console.error(`  No cards detected in ${fileName}`);
        totalErrors++;
        continue;
      }

      const withPositions = assignGridPositions(rects);

      let cardsCropped = 0;
      let uncertainCrops = 0;

      for (const rect of withPositions) {
        try {
          const outputName = await cropAndSave(filePath, rect, croppedDir);
          if (!rect.isRect) {
            uncertainCrops++;
          } else {
            cardsCropped++;
          }
          console.error(`  Saved: ${outputName}`);
        } catch (err) {
          console.error(`  Error cropping R${rect.row}C${rect.col}: ${err instanceof Error ? err.message : String(err)}`);
          totalErrors++;
        }
      }

      totalCards += cardsCropped;
      totalUncertain += uncertainCrops;
      console.error(`  ${cardsCropped} cards, ${uncertainCrops} uncertain`);
    } catch (err) {
      console.error(`  Error processing ${fileName}: ${err instanceof Error ? err.message : String(err)}`);
      totalErrors++;
    }
  }

  console.error(`\nDone! ${totalCards} cards cropped, ${totalUncertain} uncertain, ${totalErrors} errors.`);
  console.error(`Output directory: ${croppedDir}`);
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd .agents/skills/scan-collection/scripts && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Test on a single photo**

Run: `cd .agents/skills/scan-collection/scripts && npx tsx crop-cards.ts "C:\Users\harry\Downloads\cards" --min-area-pct 1 --max-area-pct 80`
Expected: Processes photos, creates `cropped/` subfolder with individual card images. Some cards detected, some uncertain.

- [ ] **Step 4: Review cropped images**

Manually inspect `C:\Users\harry\Downloads\cards\cropped\` — verify card images are properly cropped and straightened. Check `_uncertain` images for quality.

- [ ] **Step 5: Commit**

```bash
git add .agents/skills/scan-collection/scripts/crop-cards.ts
git commit -m "feat: add crop-cards.ts — OpenCV card detection and cropping"
```

---

### Task 3: Build scan-cards.ts — Single-card vision scan

**Files:**
- Create: `.agents/skills/scan-collection/scripts/scan-cards.ts`

- [ ] **Step 1: Write scan-cards.ts**

Create `.agents/skills/scan-collection/scripts/scan-cards.ts` with the following complete implementation:

```typescript
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, extname, basename } from "node:path";
import OpenAI from "openai";
import sharp from "sharp";

// ── Types ──────────────────────────────────────────────────────────────────

interface DetectedCard {
  name: string;
  quantity: number;
  confidence: "high" | "medium" | "low";
  sourcePhoto: string;
  gridPosition: string;
  setName?: string;
  collectorNumber?: string;
  validatedName?: string;
  validationStatus?: "confirmed" | "corrected" | "flagged";
}

interface ScanResponse {
  name: string;
  setName?: string;
  collectorNumber?: string;
  confidence: string;
}

interface ValidationResponse {
  cards: { originalName: string; correctName: string; confidence: string }[];
}

interface RawCardsOutput {
  metadata: {
    source: string;
    scanDate: string;
    photoDirectory: string;
    croppedDirectory: string;
    cardsScanned: number;
    highConfidenceCards: number;
    uncertainCards: number;
    validatedCards: number;
    correctedCards: number;
    flaggedCards: number;
  };
  cards: DetectedCard[];
  warnings: (DetectedCard | string)[];
}

// ── Constants ──────────────────────────────────────────────────────────────

const SUPPORTED_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20MB
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

const LM_STUDIO_BASE_URL = "http://localhost:1234/v1";
const LM_STUDIO_MODEL = "gemma-4-26b-a4b";

const SCAN_PROMPT = `Identify this MTG card. Output ONLY raw JSON:
{"name":"Card Name","setName":"Set Name","collectorNumber":"123","confidence":"high"}

No markdown. No code fences. No extra text. If you can't read the set name or collector number, omit those fields.`;

const SCAN_RETRY_PROMPT = `Your last response was not valid JSON. Try again.

Identify this MTG card. Output ONLY raw JSON like:
{"name":"Card Name","confidence":"high"}

No markdown. No code fences. No extra text.`;

const VALIDATION_PROMPT = (cardName: string) =>
`Is this card named "${cardName}"? Confirm or correct the name. Output ONLY raw JSON:
{"originalName":"${cardName}","correctName":"Correct Name","confidence":"high"}

No markdown. No code fences. No extra text.`;

// ── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isImageFile(filename: string): boolean {
  const ext = extname(filename).toLowerCase();
  return SUPPORTED_EXTENSIONS.includes(ext);
}

function extractJSON(text: string): any | null {
  // 1. Direct parse
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed;
  } catch { /* continue */ }

  // 2. Markdown code block
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      const parsed = JSON.parse(codeBlockMatch[1]);
      if (parsed && typeof parsed === "object") return parsed;
    } catch { /* continue */ }
  }

  // 3. Brace-matching: find first { ... } block
  const braceStart = text.indexOf("{");
  if (braceStart !== -1) {
    let depth = 0;
    let braceEnd = -1;
    for (let i = braceStart; i < text.length; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) { braceEnd = i; break; }
      }
    }
    if (braceEnd !== -1) {
      try {
        const candidate = text.substring(braceStart, braceEnd + 1);
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === "object") return parsed;
      } catch { /* continue */ }
    }
  }

  return null;
}

function isValidConfidence(c: string): c is "high" | "medium" | "low" {
  return ["high", "medium", "low"].includes(c);
}

function sanitizeCardName(name: string): string {
  let cleaned = name.replace(/\$\\?text\{([^}]*)\}\$/g, "$1");
  cleaned = cleaned.replace(/\$/g, "");
  cleaned = cleaned.replace(/\\[a-zA-Z]+\{([^}]*)\}/g, "$1");
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return cleaned;
}

function parseSourceFromFilename(filename: string): { sourcePhoto: string; gridPosition: string } {
  // Filename format: PXL_20260517_035519830_R1C1.jpg or PXL_20260517_035519830_R1C1_uncertain.jpg
  const base = basename(filename, extname(filename));
  const match = base.match(/^(.+)_R(\d+)C(\d+)(?:_uncertain)?$/);
  if (match) {
    return {
      sourcePhoto: `${match[1]}.jpg`,
      gridPosition: `R${match[2]}C${match[3]}`,
    };
  }
  return { sourcePhoto: filename, gridPosition: "unknown" };
}

async function resizeIfNeeded(filePath: string): Promise<{ buffer: Buffer; wasResized: boolean }> {
  const stat = statSync(filePath);
  if (stat.size <= MAX_IMAGE_BYTES) {
    return { buffer: readFileSync(filePath), wasResized: false };
  }
  console.error(`  Resizing ${basename(filePath)} (${(stat.size / 1024 / 1024).toFixed(1)}MB)...`);
  const buffer = await sharp(filePath)
    .resize({ width: 2048, withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return { buffer, wasResized: true };
}

function imageToDataUri(buffer: Buffer, wasResized: boolean, filePath: string): string {
  const ext = wasResized ? ".jpg" : extname(filePath).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
  };
  const mime = mimeMap[ext] || "image/jpeg";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

// ── Scan Single Card ───────────────────────────────────────────────────────

async function scanCard(
  client: OpenAI,
  filePath: string,
  jsonRetry = false,
  apiRetries = 0
): Promise<{ card: DetectedCard | null; warnings: (DetectedCard | string)[] }> {
  const fileName = basename(filePath);
  const { sourcePhoto, gridPosition } = parseSourceFromFilename(fileName);
  const warnings: (DetectedCard | string)[] = [];

  try {
    const { buffer: imageBuffer, wasResized } = await resizeIfNeeded(filePath);
    const dataUri = imageToDataUri(imageBuffer, wasResized, filePath);

    const prompt = jsonRetry ? SCAN_RETRY_PROMPT : SCAN_PROMPT;

    const response = await client.chat.completions.create({
      model: LM_STUDIO_MODEL,
      messages: [
        {
          role: "system",
          content: "You are a precise MTG card identifier. Always respond with raw JSON only. Never use markdown or code fences.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUri } },
          ],
        },
      ],
      max_tokens: 1024,
      temperature: 0.1,
    });

    const content = response.choices[0]?.message?.content?.trim() ?? "";
    const parsed = extractJSON(content);

    if (!parsed || !parsed.name) {
      if (!jsonRetry) {
        console.error(`  Invalid JSON for ${fileName}, retrying...`);
        return scanCard(client, filePath, true, 0);
      }
      warnings.push(`card ${fileName}: model returned invalid JSON after retry`);
      return { card: null, warnings };
    }

    const confidence = isValidConfidence(parsed.confidence) ? parsed.confidence : "low";
    const card: DetectedCard = {
      name: sanitizeCardName(parsed.name?.trim() || "Unknown"),
      quantity: 1,
      confidence,
      sourcePhoto,
      gridPosition,
      setName: parsed.setName?.trim(),
      collectorNumber: parsed.collectorNumber?.trim(),
    };

    if (confidence === "low") {
      warnings.push(card);
      return { card: null, warnings };
    }

    return { card, warnings };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = (err as any)?.status ?? (err as any)?.statusCode ?? 0;
    const isRetryable = status === 429 || (status >= 500 && status < 600);

    if (isRetryable && apiRetries < MAX_RETRIES) {
      const delay = RETRY_BASE_MS * Math.pow(2, apiRetries);
      console.error(`  API error ${status} for ${fileName}. Retrying in ${delay}ms...`);
      await sleep(delay);
      return scanCard(client, filePath, jsonRetry, apiRetries + 1);
    }

    warnings.push(`card ${fileName}: API error (status ${status}): ${msg}`);
    return { card: null, warnings };
  }
}

// ── Validate Card ──────────────────────────────────────────────────────────

async function validateCard(
  client: OpenAI,
  filePath: string,
  detectedCard: DetectedCard,
  apiRetries = 0
): Promise<{ card: DetectedCard; correction?: string; flag?: string }> {
  const fileName = basename(filePath);

  try {
    const { buffer: imageBuffer, wasResized } = await resizeIfNeeded(filePath);
    const dataUri = imageToDataUri(imageBuffer, wasResized, filePath);

    const prompt = VALIDATION_PROMPT(detectedCard.name);

    const response = await client.chat.completions.create({
      model: LM_STUDIO_MODEL,
      messages: [
        {
          role: "system",
          content: "You are a precise MTG card validator. Always respond with raw JSON only. Never use markdown or code fences.",
        },
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: dataUri } },
          ],
        },
      ],
      max_tokens: 512,
      temperature: 0.1,
    });

    const content = response.choices[0]?.message?.content?.trim() ?? "";
    const parsed = extractJSON(content);

    if (!parsed || !parsed.correctName) {
      // Validation parse failed — flag for review
      return {
        card: { ...detectedCard, validationStatus: "flagged" },
        flag: `${detectedCard.name} (${detectedCard.gridPosition}) — validation parse failed`,
      };
    }

    const correctedName = sanitizeCardName(parsed.correctName?.trim() || detectedCard.name);
    const valConfidence = parsed.confidence?.toLowerCase() || "low";

    if (correctedName.toLowerCase() === detectedCard.name.toLowerCase()) {
      return { card: { ...detectedCard, validatedName: detectedCard.name, validationStatus: "confirmed" } };
    } else if (valConfidence === "high" || valConfidence === "medium") {
      return {
        card: {
          ...detectedCard,
          name: correctedName,
          validatedName: correctedName,
          validationStatus: "corrected",
        },
        correction: `${detectedCard.name} → ${correctedName} (${detectedCard.gridPosition}) [${valConfidence}]`,
      };
    } else {
      return {
        card: { ...detectedCard, validatedName: correctedName, validationStatus: "flagged" },
        flag: `${detectedCard.name} → ${correctedName}? (${detectedCard.gridPosition}) [low confidence]`,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const status = (err as any)?.status ?? (err as any)?.statusCode ?? 0;
    const isRetryable = status === 429 || (status >= 500 && status < 600);

    if (isRetryable && apiRetries < MAX_RETRIES) {
      const delay = RETRY_BASE_MS * Math.pow(2, apiRetries);
      console.error(`  Validation API error ${status} for ${fileName}. Retrying in ${delay}ms...`);
      await sleep(delay);
      return validateCard(client, filePath, detectedCard, apiRetries + 1);
    }

    return {
      card: { ...detectedCard, validationStatus: "flagged" },
      flag: `${detectedCard.name} (${detectedCard.gridPosition}) — validation API error`,
    };
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error("Usage: npx tsx scan-cards.ts <photo-dir> [raw-cards-path]");
    process.exit(1);
  }

  const photoDir = resolve(args[0]);
  const outputPath = resolve(args[1] || "raw-cards.json");

  // Find cropped directory
  const croppedDir = resolve(photoDir, "cropped");
  if (!existsSync(croppedDir)) {
    console.error(`Error: Cropped directory not found: ${croppedDir}`);
    console.error("Run crop-cards.ts first to generate cropped card images.");
    process.exit(1);
  }

  // Find cropped image files
  const imageFiles = readdirSync(croppedDir)
    .filter(isImageFile)
    .sort()
    .map((f) => resolve(croppedDir, f));

  if (imageFiles.length === 0) {
    console.error(`Error: No image files found in ${croppedDir}`);
    process.exit(1);
  }

  console.error(`Found ${imageFiles.length} cropped image(s) in ${croppedDir}`);

  // Initialize OpenAI client for LM Studio
  const client = new OpenAI({
    apiKey: "lm-studio",
    baseURL: LM_STUDIO_BASE_URL,
  });

  const allCards: DetectedCard[] = [];
  const allWarnings: (DetectedCard | string)[] = [];
  let totalValidated = 0;
  let totalCorrected = 0;
  let totalFlagged = 0;

  for (let i = 0; i < imageFiles.length; i++) {
    const filePath = imageFiles[i];
    const fileName = basename(filePath);

    console.error(`\nScanning ${i + 1}/${imageFiles.length}: ${fileName}`);

    // Step 1: Scan
    const scanResult = await scanCard(client, filePath);

    if (scanResult.warnings.length > 0) {
      allWarnings.push(...scanResult.warnings);
    }

    if (!scanResult.card) {
      continue;
    }

    // Step 2: Validate
    console.error(`  Validating: ${scanResult.card.name}`);
    const valResult = await validateCard(client, filePath, scanResult.card);

    allCards.push(valResult.card);
    totalValidated++;

    if (valResult.correction) {
      console.error(`  Corrected: ${valResult.correction}`);
      totalCorrected++;
    }
    if (valResult.flag) {
      console.error(`  Flagged: ${valResult.flag}`);
      allWarnings.push(valResult.flag);
      totalFlagged++;
    }
  }

  // Deduplicate by card name, summing quantities
  const cardMap = new Map<string, DetectedCard>();
  for (const card of allCards) {
    const key = card.name.toLowerCase();
    const existing = cardMap.get(key);
    if (existing) {
      existing.quantity += card.quantity;
    } else {
      cardMap.set(key, { ...card });
    }
  }
  const dedupedCards = Array.from(cardMap.values());

  const totalCardsDetected = dedupedCards.reduce((sum, c) => sum + c.quantity, 0);
  const highConfidenceCards = dedupedCards
    .filter((c) => c.confidence === "high" || c.confidence === "medium")
    .reduce((sum, c) => sum + c.quantity, 0);
  const uncertainCards = allWarnings
    .filter((w): w is DetectedCard => typeof w !== "string")
    .reduce((sum, w) => sum + w.quantity, 0);

  if (dedupedCards.length === 0) {
    console.error("Error: No cards confidently identified — check photo quality and LM Studio status");
    process.exit(1);
  }

  // Build output
  const output: RawCardsOutput = {
    metadata: {
      source: "photo-scan-v2",
      scanDate: new Date().toISOString(),
      photoDirectory: photoDir,
      croppedDirectory: croppedDir,
      cardsScanned: imageFiles.length,
      highConfidenceCards,
      uncertainCards,
      validatedCards: totalValidated,
      correctedCards: totalCorrected,
      flaggedCards: totalFlagged,
    },
    cards: dedupedCards,
    warnings: allWarnings,
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2), "utf-8");

  console.error(`\nDone! ${dedupedCards.length} unique cards detected (${totalCardsDetected} total).`);
  console.error(`Validation: ${totalValidated} validated, ${totalCorrected} corrected, ${totalFlagged} flagged`);
  if (uncertainCards > 0) {
    console.error(`Uncertain cards (review recommended): ${uncertainCards}`);
  }
  console.error(`\nOutput written to: ${outputPath}`);
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd .agents/skills/scan-collection/scripts && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add .agents/skills/scan-collection/scripts/scan-cards.ts
git commit -m "feat: add scan-cards.ts — single-card vision scan with Gemma 4"
```

---

### Task 4: Update enrich-cards.ts for new DetectedCard fields

**Files:**
- Modify: `.agents/skills/scan-collection/scripts/enrich-cards.ts`

The existing `enrich-cards.ts` has a `DetectedCard` interface (lines 6-11) that only has `name`, `quantity`, `confidence`, `sourcePhoto`. The new `raw-cards.json` from `scan-cards.ts` adds `gridPosition`, `setName`, `collectorNumber`, `validatedName`, `validationStatus`. We need to update the interface and use `setName`/`collectorNumber` in Scryfall batch lookups.

- [ ] **Step 1: Update DetectedCard interface in enrich-cards.ts**

Change lines 6-11 from:

```typescript
interface DetectedCard {
  name: string;
  quantity: number;
  confidence: "high" | "medium" | "low";
  sourcePhoto: string;
}
```

to:

```typescript
interface DetectedCard {
  name: string;
  quantity: number;
  confidence: "high" | "medium" | "low";
  sourcePhoto: string;
  gridPosition?: string;
  setName?: string;
  collectorNumber?: string;
  validatedName?: string;
  validationStatus?: "confirmed" | "corrected" | "flagged";
}
```

- [ ] **Step 2: Update RawCardsOutput metadata interface**

Change lines 13-26 from:

```typescript
interface RawCardsOutput {
  metadata: {
    source: string;
    scanDate: string;
    photoDirectory: string;
    photosProcessed: number;
    photosSkipped: number;
    totalCardsDetected: number;
    highConfidenceCards: number;
    uncertainCards: number;
  };
  cards: DetectedCard[];
  warnings: (DetectedCard | string)[];
}
```

to:

```typescript
interface RawCardsOutput {
  metadata: {
    source: string;
    scanDate: string;
    photoDirectory: string;
    croppedDirectory?: string;
    cardsScanned?: number;
    photosProcessed?: number;
    photosSkipped?: number;
    totalCardsDetected: number;
    highConfidenceCards: number;
    uncertainCards: number;
    validatedCards?: number;
    correctedCards?: number;
    flaggedCards?: number;
  };
  cards: DetectedCard[];
  warnings: (DetectedCard | string)[];
}
```

- [ ] **Step 3: Use setName and collectorNumber in Scryfall batch lookup**

First, update the `ScryfallIdentifier` interface (line 65-67) from:

```typescript
interface ScryfallIdentifier {
  name?: string;
}
```

to:

```typescript
interface ScryfallIdentifier {
  name?: string;
  set?: string;
  collector_number?: string;
}
```

Then, update the batch identifier construction. The `nameToQuantity` map (lines 214-218) needs to also track the DetectedCard objects so we can access `setName` and `collectorNumber`. Change the map to store the full card info:

Replace lines 213-225:

```typescript
  // Build lookup from name → quantity (sum duplicates from different photos)
  const nameToQuantity = new Map<string, number>();
  for (const card of detectedCards) {
    const existing = nameToQuantity.get(card.name) ?? 0;
    nameToQuantity.set(card.name, existing + card.quantity);
  }

  const entries = Array.from(nameToQuantity.entries());

  // Process in batches of 75
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const identifiers: ScryfallIdentifier[] = batch.map(([name]) => ({ name }));
```

with:

```typescript
  // Build lookup from name → { quantity, setName, collectorNumber }
  const nameToInfo = new Map<string, { quantity: number; setName?: string; collectorNumber?: string }>();
  for (const card of detectedCards) {
    const existing = nameToInfo.get(card.name);
    if (existing) {
      existing.quantity += card.quantity;
    } else {
      nameToInfo.set(card.name, {
        quantity: card.quantity,
        setName: card.setName,
        collectorNumber: card.collectorNumber,
      });
    }
  }

  const entries = Array.from(nameToInfo.entries());

  // Process in batches of 75
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const identifiers: ScryfallIdentifier[] = batch.map(([name, info]) => {
      const id: ScryfallIdentifier = { name };
      if (info.setName) id.set = info.setName;
      if (info.collectorNumber) id.collector_number = info.collectorNumber;
      return id;
    });
```

Then update all references from `nameToQuantity` to `nameToInfo` and access `.quantity` on the info object. Specifically, on line 249 change:

```typescript
      const quantity = nameToQuantity.get(detectedName) ?? nameToQuantity.get(apiCard.name) ?? 1;
```

to:

```typescript
      const quantity = nameToInfo.get(detectedName)?.quantity ?? nameToInfo.get(apiCard.name)?.quantity ?? 1;
```

And on line 238 change:

```typescript
        result.push(makePartialCard(name, quantity));
```

to:

```typescript
        result.push(makePartialCard(name, nameToInfo.get(name)?.quantity ?? quantity));
```

And on line 262 (fuzzy fallback), change any remaining `nameToQuantity.get(name)` references to `nameToInfo.get(name)?.quantity ?? 1`.

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd .agents/skills/scan-collection/scripts && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add .agents/skills/scan-collection/scripts/enrich-cards.ts
git commit -m "feat: update enrich-cards.ts for v2 DetectedCard fields and set-aware Scryfall lookup"
```

---

### Task 5: Delete scan-photos.ts and update SKILL.md

**Files:**
- Delete: `.agents/skills/scan-collection/scripts/scan-photos.ts`
- Modify: `.agents/skills/scan-collection/SKILL.md`

- [ ] **Step 1: Delete scan-photos.ts**

Run: `Remove-Item -LiteralPath ".agents/skills/scan-collection/scripts/scan-photos.ts"`

- [ ] **Step 2: Update SKILL.md**

Replace the entire content of `.agents/skills/scan-collection/SKILL.md` with:

```markdown
---
name: scan-collection
description: "Use when the user wants to import their MTG card collection from photos. Triggers include requests to 'scan my cards', 'import from photos', 'read my card photos', or 'scan a directory of card images'."
---

# Scan Collection

Import an MTG card collection from a directory of photos. Uses OpenCV to detect and crop individual cards, then Gemma 4 vision model to identify each card, then enriches with Scryfall data.

## Prerequisites

- LM Studio must be running with Gemma 4 model loaded (`gemma-4-26b-a4b`)
- Photos should be `.jpg`, `.jpeg`, `.png`, or `.webp` format
- Phone camera photos are supported (handles glare, angles, varied lighting)
- Dependencies must be installed: `cd .agents/skills/scan-collection/scripts && npm install`

## Workflow

1. Ask the user for the path to their photo directory
2. Ask the user whether to merge with an existing `collection.json` (if one exists)
3. Run the crop script:
   ```bash
   cd .agents/skills/scan-collection/scripts && npx tsx crop-cards.ts <photo-dir>
   ```
   - `<photo-dir>`: Path to directory containing card photos
   - Creates `<photo-dir>/cropped/` with individual card images
   - Optional flags: `--min-area-pct`, `--max-area-pct`, `--card-ratio`, `--ratio-tolerance`
4. **User reviews cropped images** (optional but recommended — check for missed or poorly cropped cards)
5. Run the scan script:
   ```bash
   cd .agents/skills/scan-collection/scripts && npx tsx scan-cards.ts <photo-dir> [raw-cards-path]
   ```
   - `<photo-dir>`: Path to photo directory (must contain `cropped/` subfolder from step 3)
   - `[raw-cards-path]`: Where to write `raw-cards.json` (default: `raw-cards.json` in current directory)
6. Review `raw-cards.json` — show the user the detected cards and warnings (uncertain cards are listed in warnings)
7. Ask the user if they want to proceed with enrichment
8. Run the enrichment script:
   ```bash
   cd .agents/skills/scan-collection/scripts && npx tsx enrich-cards.ts <raw-cards-path> <output-path> [--merge]
   ```
   - `<raw-cards-path>`: Path to `raw-cards.json` from step 5
   - `<output-path>`: Where to write `photo-collection.json`
   - `--merge`: Optional flag to merge into existing `collection.json` (backs up to `collection.json.bak`)
9. Inform the user of the results: cards detected, enriched, not found, uncertain cards for review

## Output

- `<photo-dir>/cropped/` — individual card images (from crop-cards.ts)
- `raw-cards.json` — intermediate file with detected card names, quantities, confidence levels, and source photos
- `photo-collection.json` — enriched card library (same schema as `collection.json`), usable by all downstream MTG deck skills

## Troubleshooting

- **"No contours found"**: Photos may have poor contrast between cards and playmat. Try better-lit photos with a contrasting background
- **"LM Studio not running"**: Start LM Studio and load the Gemma 4 model before scanning
- **"Invalid JSON from model"**: Gemma 4 sometimes wraps JSON in markdown. The script handles this automatically with retry + brace-matching
- **"npm install fails on sharp"**: Sharp requires native build tools on Windows. Install Visual Studio Build Tools or try `npm install --ignore-scripts` then `npm install sharp` separately
- **Too many/few cards detected**: Adjust `--min-area-pct` and `--max-area-pct` flags on crop-cards.ts
- **Cards not found on Scryfall**: The vision model may have misread a card name. Check `raw-cards.json` for typos
- **Rate limiting**: Scryfall requests are rate-limited to 550ms. Large collections may take a few minutes
```

- [ ] **Step 3: Commit**

```bash
git add .agents/skills/scan-collection/SKILL.md
git rm .agents/skills/scan-collection/scripts/scan-photos.ts
git commit -m "feat: update SKILL.md for v2 pipeline, remove scan-photos.ts"
```

---

### Task 6: End-to-end test

**Files:** None (testing only)

- [ ] **Step 1: Run crop-cards.ts on the full photo directory**

Run: `cd .agents/skills/scan-collection/scripts && npx tsx crop-cards.ts "C:\Users\harry\Downloads\cards"`
Expected: Creates `C:\Users\harry\Downloads\cards\cropped\` with individual card images. Reports total cards cropped and uncertain crops.

- [ ] **Step 2: Review cropped images**

Manually inspect `C:\Users\harry\Downloads\cards\cropped\` — verify:
- Card images are properly cropped and straightened
- `_uncertain` images are reasonable
- No obviously missed cards

- [ ] **Step 3: Run scan-cards.ts on the cropped images**

Run: `cd .agents/skills/scan-collection/scripts && npx tsx scan-cards.ts "C:\Users\harry\Downloads\cards" raw-cards.json`
Expected: Scans each cropped image, identifies cards, validates names, writes `raw-cards.json`.

- [ ] **Step 4: Run enrich-cards.ts**

Run: `cd .agents/skills/scan-collection/scripts && npx tsx enrich-cards.ts raw-cards.json photo-collection.json`
Expected: Enriches cards via Scryfall, writes `photo-collection.json`.

- [ ] **Step 5: Verify output**

Check `photo-collection.json` — verify:
- Cards have Scryfall data (manaCost, typeLine, etc.)
- Metadata shows reasonable counts
- Warnings are present for any not-found cards

- [ ] **Step 6: Commit any fixes**

If any issues were found and fixed during testing, commit them:

```bash
git add -A
git commit -m "fix: address issues found during end-to-end testing"
```
