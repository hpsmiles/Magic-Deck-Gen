import { readFileSync, readdirSync, statSync, mkdirSync, existsSync } from "node:fs";
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
  isRect: boolean;
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
  const cv = (await import("@techstark/opencv-js")).default;

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

  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

  const blurred = new cv.Mat();
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

  const thresh = new cv.Mat();
  cv.threshold(blurred, thresh, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  const detected: DetectedRect[] = [];

  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i);
    const area = cv.contourArea(cnt);

    if (area < minArea || area > maxArea) {
      cnt.delete();
      continue;
    }

    const perimeter = cv.arcLength(cnt, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(cnt, approx, 0.02 * perimeter, true);

    const isRect = approx.rows === 4;

    if (isRect) {
      const vertices: { x: number; y: number }[] = [];
      for (let j = 0; j < 4; j++) {
        vertices.push({
          x: approx.intAt(j, 0, 0),
          y: approx.intAt(j, 0, 1),
        });
      }

      const boundingRect = cv.boundingRect(cnt);
      const detectedRatio = boundingRect.width / boundingRect.height;
      const ratioOk =
        Math.abs(detectedRatio - cardRatio) < ratioTolerance ||
        Math.abs(1 / detectedRatio - cardRatio) < ratioTolerance;

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

  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x);

  const avgHeight = sorted.reduce((s, r) => s + r.height, 0) / sorted.length;
  const rowThreshold = avgHeight * 0.4;

  const rows: DetectedRect[][] = [];
  let currentRow: DetectedRect[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i].y - currentRow[0].y) < rowThreshold) {
      currentRow.push(sorted[i]);
    } else {
      currentRow.sort((a, b) => a.x - b.x);
      rows.push(currentRow);
      currentRow = [sorted[i]];
    }
  }
  currentRow.sort((a, b) => a.x - b.x);
  rows.push(currentRow);

  const result: (DetectedRect & { row: number; col: number })[] = [];
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < rows[r].length; c++) {
      result.push({ ...rows[r][c], row: r + 1, col: c + 1 });
    }
  }

  return result;
}

// ── Crop & Save ─────────────────────────────────────────────────────────────

function orderVertices(vertices: { x: number; y: number }[]): { x: number; y: number }[] {
  const bySum = [...vertices].sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byDiff = [...vertices].sort((a, b) => (a.x - a.y) - (b.x - b.y));
  return [bySum[0], byDiff[byDiff.length - 1], bySum[bySum.length - 1], byDiff[0]];
}

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
    const cv = (await import("@techstark/opencv-js")).default;

    const { data, info } = await sharp(filePath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const src = cv.matFromImageData({
      data: new Uint8ClampedArray(data),
      width: info.width,
      height: info.height,
    });

    const ordered = orderVertices(rect.vertices);

    const cardWidth = 488;
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

    const warpedData = new Uint8ClampedArray(warped.data);
    await sharp(Buffer.from(warpedData), {
      raw: { width: cardWidth, height: cardHeight, channels: 4 },
    })
      .jpeg({ quality: 90 })
      .toFile(outputPath);

    src.delete();
    srcPts.delete();
    dstPts.delete();
    M.delete();
    warped.delete();
  } else {
    const meta = await sharp(filePath).metadata();
    await sharp(filePath)
      .extract({
        left: Math.max(0, rect.x),
        top: Math.max(0, rect.y),
        width: Math.min(rect.width, meta.width! - rect.x),
        height: Math.min(rect.height, meta.height! - rect.y),
      })
      .jpeg({ quality: 90 })
      .toFile(outputPath);
  }

  return outputName;
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

  try {
    const stat = statSync(resolvedDir);
    if (!stat.isDirectory()) throw new Error("Not a directory");
  } catch {
    console.error(`Error: Directory not found: ${resolvedDir}`);
    process.exit(1);
  }

  const imageFiles = readdirSync(resolvedDir)
    .filter(isImageFile)
    .sort()
    .map((f) => resolve(resolvedDir, f));

  if (imageFiles.length === 0) {
    console.error(`Error: No .jpg/.jpeg/.png/.webp files found in ${resolvedDir}`);
    process.exit(1);
  }

  console.error(`Found ${imageFiles.length} image(s) in ${resolvedDir}`);

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
