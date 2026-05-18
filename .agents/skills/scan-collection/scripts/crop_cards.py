#!/usr/bin/env python3
"""
Crop individual MTG cards from photos using YOLO11m OBB (cardcaptor-v3).

Detects trading cards with oriented bounding boxes, straightens them
via perspective transform, and saves individual card images.

Usage:
    python crop_cards.py <photo-dir> [--conf 0.25] [--imgsz 1088] [--output-size 350x490]
"""

import argparse
import math
import os
import sys

import cv2
import numpy as np
from ultralytics import YOLO

# ── Constants ──────────────────────────────────────────────────────────────

MODEL_PATH = os.path.join(
    os.environ.get(
        "CARDCAPTOR_MODEL_DIR",
        os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub",
                     "models--AlecKarfonta--cardcaptor-v3", "snapshots"),
    ),
)

SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
CROPPED_DIR_NAME = "cropped"


def find_model_path() -> str:
    """Find the cardcaptor-v3 best.pt model file."""
    # Check env override first
    env_path = os.environ.get("CARDCAPTOR_MODEL_PATH")
    if env_path and os.path.isfile(env_path):
        return env_path

    # Search in HuggingFace cache
    base = os.path.join(
        os.path.expanduser("~"), ".cache", "huggingface", "hub",
        "models--AlecKarfonta--cardcaptor-v3", "snapshots",
    )
    if os.path.isdir(base):
        for snapshot in sorted(os.listdir(base), reverse=True):
            pt_path = os.path.join(base, snapshot, "weights", "cardcaptor_v3_best.pt")
            if os.path.isfile(pt_path):
                return pt_path

    print("ERROR: cardcaptor-v3 model not found.", file=sys.stderr)
    print("Download it with:", file=sys.stderr)
    print("  python -c \"from huggingface_hub import hf_hub_download; "
          "hf_hub_download('AlecKarfonta/cardcaptor-v3', 'weights/cardcaptor_v3_best.pt')\"",
          file=sys.stderr)
    sys.exit(1)


def is_image_file(filename: str) -> bool:
    return os.path.splitext(filename)[1].lower() in SUPPORTED_EXTENSIONS


def crop_card_from_obb(img: np.ndarray, cx: float, cy: float, w: float, h: float,
                        angle_rad: float, out_w: int, out_h: int) -> np.ndarray:
    """Crop a card from an OBB detection using perspective transform."""
    # Get the 4 corner points of the rotated rectangle
    rect = ((cx, cy), (w, h), math.degrees(angle_rad))
    box_pts = cv2.boxPoints(rect).astype(np.float32)

    # Order corners: top-left, top-right, bottom-right, bottom-left
    # Sort by x+y sum to find top-left (smallest sum)
    sums = box_pts[:, 0] + box_pts[:, 1]
    tl_idx = np.argmin(sums)
    src_pts = np.roll(box_pts, -tl_idx, axis=0)

    # After rolling, we have TL, then counter-clockwise points
    # We need TL, TR, BR, BL (clockwise)
    # Check if second point is TR (larger x) or BL (smaller x)
    if src_pts[1][0] < src_pts[3][0]:
        # Second point is BL, fourth is TR — swap
        src_pts = src_pts[[0, 3, 2, 1]]

    dst_pts = np.array([
        [0, 0],
        [out_w - 1, 0],
        [out_w - 1, out_h - 1],
        [0, out_h - 1],
    ], dtype=np.float32)

    M = cv2.getPerspectiveTransform(src_pts, dst_pts)
    card_crop = cv2.warpPerspective(img, M, (out_w, out_h),
                                     flags=cv2.INTER_LANCZOS4,
                                     borderMode=cv2.BORDER_REPLICATE)
    return card_crop


def assign_grid_positions(detections: list) -> list:
    """Assign row/col grid positions to detections based on spatial layout."""
    if not detections:
        return []

    # Sort by y then x
    sorted_dets = sorted(detections, key=lambda d: (d["cy"], d["cx"]))

    # Group into rows based on y proximity
    avg_h = sum(d["h"] for d in sorted_dets) / len(sorted_dets)
    row_threshold = avg_h * 0.4

    rows = []
    current_row = [sorted_dets[0]]

    for i in range(1, len(sorted_dets)):
        if abs(sorted_dets[i]["cy"] - current_row[0]["cy"]) < row_threshold:
            current_row.append(sorted_dets[i])
        else:
            current_row.sort(key=lambda d: d["cx"])
            rows.append(current_row)
            current_row = [sorted_dets[i]]
    current_row.sort(key=lambda d: d["cx"])
    rows.append(current_row)

    result = []
    for r_idx, row in enumerate(rows):
        for c_idx, det in enumerate(row):
            result.append({**det, "row": r_idx + 1, "col": c_idx + 1})

    return result


def process_photo(model: YOLO, img_path: str, output_dir: str,
                   conf: float, imgsz: int, target_w: int, target_h: int) -> dict:
    """Process a single photo: detect cards, crop, and save."""
    img = cv2.imread(img_path)
    if img is None:
        return {"photo": os.path.basename(img_path), "error": "Failed to read image", "cards": 0}

    results = model(img_path, conf=conf, imgsz=imgsz, verbose=False)
    r = results[0]

    if len(r.obb) == 0:
        return {"photo": os.path.basename(img_path), "cards": 0, "detections": []}

    detections = []
    for i, box in enumerate(r.obb):
        cx, cy, w, h, rot = box.xywhr[0].tolist()
        confidence = float(box.conf[0])
        detections.append({
            "index": i, "cx": cx, "cy": cy, "w": w, "h": h,
            "angle_rad": rot, "confidence": confidence,
        })

    # Assign grid positions
    positioned = assign_grid_positions(detections)

    base_name = os.path.splitext(os.path.basename(img_path))[0]
    cards_saved = 0

    for det in positioned:
        # Determine output dimensions (portrait: height > width)
        if det["w"] > det["h"]:
            out_w, out_h = int(det["h"]), int(det["w"])
        else:
            out_w, out_h = int(det["w"]), int(det["h"])

        try:
            card_crop = crop_card_from_obb(
                img, det["cx"], det["cy"], det["w"], det["h"],
                det["angle_rad"], out_w, out_h,
            )

            # Resize to target dimensions
            card_crop = cv2.resize(card_crop, (target_w, target_h),
                                    interpolation=cv2.INTER_LANCZOS4)

            out_name = f"{base_name}_R{det['row']}C{det['col']}.jpg"
            out_path = os.path.join(output_dir, out_name)
            cv2.imwrite(out_path, card_crop, [cv2.IMWRITE_JPEG_QUALITY, 90])
            cards_saved += 1
        except Exception as e:
            print(f"  Warning: Failed to crop R{det['row']}C{det['col']}: {e}",
                  file=sys.stderr)

    return {
        "photo": os.path.basename(img_path),
        "cards": cards_saved,
        "total_detections": len(detections),
    }


def main():
    parser = argparse.ArgumentParser(description="Crop MTG cards from photos using YOLO OBB")
    parser.add_argument("photo_dir", help="Directory containing card photos")
    parser.add_argument("--conf", type=float, default=0.25, help="Confidence threshold (default: 0.25)")
    parser.add_argument("--imgsz", type=int, default=1088, help="Inference image size (default: 1088)")
    parser.add_argument("--output-size", type=str, default="350x490",
                        help="Output card size WxH (default: 350x490)")
    args = parser.parse_args()

    # Parse output size
    try:
        target_w, target_h = map(int, args.output_size.split("x"))
    except ValueError:
        print("ERROR: --output-size must be WxH format (e.g. 350x490)", file=sys.stderr)
        sys.exit(1)

    # Validate photo directory
    photo_dir = os.path.abspath(args.photo_dir)
    if not os.path.isdir(photo_dir):
        print(f"ERROR: Directory not found: {photo_dir}", file=sys.stderr)
        sys.exit(1)

    # Find image files
    image_files = sorted([
        os.path.join(photo_dir, f)
        for f in os.listdir(photo_dir)
        if is_image_file(f)
    ])

    if not image_files:
        print(f"ERROR: No image files found in {photo_dir}", file=sys.stderr)
        sys.exit(1)

    print(f"Found {len(image_files)} image(s) in {photo_dir}", file=sys.stderr)

    # Create output directory
    output_dir = os.path.join(photo_dir, CROPPED_DIR_NAME)
    os.makedirs(output_dir, exist_ok=True)
    print(f"Output directory: {output_dir}", file=sys.stderr)

    # Load model
    model_path = find_model_path()
    print(f"Loading model: {model_path}", file=sys.stderr)
    model = YOLO(model_path)

    # Process each photo
    total_cards = 0
    results = []

    for i, img_path in enumerate(image_files):
        fname = os.path.basename(img_path)
        print(f"\nProcessing {i + 1}/{len(image_files)}: {fname}", file=sys.stderr)

        result = process_photo(model, img_path, output_dir, args.conf, args.imgsz,
                                target_w, target_h)
        results.append(result)
        total_cards += result["cards"]
        print(f"  {result['cards']} cards cropped (from {result.get('total_detections', 0)} detections)",
              file=sys.stderr)

    # Summary
    print(f"\nDone! {total_cards} cards cropped from {len(image_files)} photos.", file=sys.stderr)
    print(f"Output directory: {output_dir}", file=sys.stderr)

    # Output JSON summary to stdout for programmatic consumption
    import json
    summary = {
        "total_cards": total_cards,
        "total_photos": len(image_files),
        "output_dir": output_dir,
        "results": results,
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
