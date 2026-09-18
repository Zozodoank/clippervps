#!/usr/bin/env python3
"""
Smart AI Dataset Curator & Frame Extractor for ClipperVPS Gatekeeper.
Implements GPT Best Practices:
1. 1 FPS Frame Sampling (representative sampling).
2. Local Pre-Filtering (Laplacian blur variance & color quantization).
3. Similarity Clustering & Deduplication (drops near-identical consecutive/redundant frames).
4. Hard Negative Mining (watermarks, logos, 1s subtitles, graphics, packaging/unboxing, freeze frames).
5. Comprehensive Multi-Column Datasheet (face, text, watermark, graphic, static, action, product, scene_type).
6. Strict Video-Level Split (prevents data leakage between train, val, test).
7. Exports both JSON and CSV datasheets.

Usage:
  python3 curate_dataset.py --video "https://www.youtube.com/watch?v=AQrfDmNuy3o" --split train
  python3 curate_dataset.py --video /path/to/video.mp4 --split val --interval 1.0
"""

import os
import sys
import glob
import json
import csv
import time
import argparse
import subprocess
import numpy as np
import cv2  # type: ignore

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
DATASET_DIR = os.path.join(CURRENT_DIR, "dataset")
TRAIN_DIR = os.path.join(DATASET_DIR, "train")
VAL_DIR = os.path.join(DATASET_DIR, "val")
TEST_DIR = os.path.join(DATASET_DIR, "test")
TEMP_DIR = os.path.join(CURRENT_DIR, "temp_curate")

for base_dir in [TRAIN_DIR, VAL_DIR, TEST_DIR]:
    os.makedirs(os.path.join(base_dir, "valid_real"), exist_ok=True)
    os.makedirs(os.path.join(base_dir, "rejected"), exist_ok=True)
os.makedirs(TEMP_DIR, exist_ok=True)

# ─────────────────────────────────────────────────────────────────────────────
# 1. OPTIONAL: IMPORT GATEKEEPER DETECTORS IF AVAILABLE
# ─────────────────────────────────────────────────────────────────────────────
HAS_GATEKEEPER = False
face_detector = None
text_detector = None
scene_detector = None

try:
    from service import FaceGatekeeper, TextGatekeeper, SceneGatekeeper
    face_detector = FaceGatekeeper(min_confidence=0.45)
    text_detector = TextGatekeeper()
    scene_detector = SceneGatekeeper()
    HAS_GATEKEEPER = True
    print("✅ [Curator] Gatekeeper service modules loaded successfully.")
except Exception as e:
    print(f"ℹ️ [Curator] Running with built-in heuristic vision detectors ({e}).")


# ─────────────────────────────────────────────────────────────────────────────
# 2. IMAGE UTILITIES & CROPPING
# ─────────────────────────────────────────────────────────────────────────────
def crop_9_16(image):
    """Crop center 9:16 vertical slice (matching Shorts/Reels)."""
    h, w = image.shape[:2]
    target_w = int(h * 9.0 / 16.0)
    if target_w >= w:
        return image
    x_start = (w - target_w) // 2
    return image[:, x_start:x_start + target_w]


def compute_frame_similarity(img_a, img_b):
    """
    Calculate visual similarity between two frames using Normalized MAD
    and color histogram correlation.
    Returns similarity score (0.0 to 1.0).
    """
    thumb_a = cv2.resize(img_a, (48, 48), interpolation=cv2.INTER_AREA)
    thumb_b = cv2.resize(img_b, (48, 48), interpolation=cv2.INTER_AREA)

    gray_a = cv2.cvtColor(thumb_a, cv2.COLOR_BGR2GRAY)
    gray_b = cv2.cvtColor(thumb_b, cv2.COLOR_BGR2GRAY)

    # Mean Absolute Difference (0 = identical, 255 = completely inverted)
    mad = float(np.mean(cv2.absdiff(gray_a, gray_b)))
    mad_score = max(0.0, 1.0 - (mad / 50.0))

    # Color histogram correlation
    hist_a = cv2.calcHist([thumb_a], [0, 1, 2], None, [8, 8, 8], [0, 256, 0, 256, 0, 256])
    hist_b = cv2.calcHist([thumb_b], [0, 1, 2], None, [8, 8, 8], [0, 256, 0, 256, 0, 256])
    cv2.normalize(hist_a, hist_a)
    cv2.normalize(hist_b, hist_b)
    hist_corr = float(cv2.compareHist(hist_a, hist_b, cv2.HISTCMP_CORREL))

    similarity = (0.5 * mad_score) + (0.5 * max(0.0, hist_corr))
    return similarity, mad


# ─────────────────────────────────────────────────────────────────────────────
# 3. ADVANCED FRAME EVALUATOR & MULTI-FEATURE DETECTOR
# ─────────────────────────────────────────────────────────────────────────────
def analyze_frame_features(cropped_bgr, full_bgr, prev_cropped, consecutive_static_count=0):
    """
    Evaluates all required GPT datasheet columns:
    [face, text, watermark, graphic, static, action, product, scene_type]
    Returns (features_dict, label, reason, confidence)
    """
    h, w = cropped_bgr.shape[:2]
    features = {
        "face": False,
        "text": False,
        "watermark": False,
        "graphic": False,
        "static": False,
        "action": False,
        "product": True,
        "scene_type": "demonstration"
    }
    reasons = []
    confidence = 0.95

    # ── A. PRE-FILTER: Blur & Flat Color Check ──
    small = cv2.resize(cropped_bgr, (64, 64), interpolation=cv2.INTER_AREA)
    gray_small = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    laplacian_var = float(cv2.Laplacian(gray_small, cv2.CV_64F).var())

    quantized = (small >> 5).reshape(-1, 3)
    unique_colors = len(np.unique(quantized, axis=0))

    if laplacian_var < 14.0:
        features["graphic"] = True
        features["scene_type"] = "graphic_intro"
        reasons.append(f"Frame polos/blur (Laplacian: {laplacian_var:.1f})")

    if unique_colors < 22:
        features["graphic"] = True
        features["scene_type"] = "graphic_intro"
        reasons.append(f"Kartu bumper statis 2D ({unique_colors} warna)")

    # ── B. MOTION & STATIC FRAME CHECK ──
    motion_mad = 20.0
    if prev_cropped is not None:
        p_small = cv2.resize(prev_cropped, (64, 64), interpolation=cv2.INTER_AREA)
        p_gray = cv2.cvtColor(p_small, cv2.COLOR_BGR2GRAY)
        motion_mad = float(np.mean(cv2.absdiff(gray_small, p_gray)))

        if motion_mad < 5.5:
            features["static"] = True
            if consecutive_static_count >= 2:
                reasons.append(f"Frame statis beku > 3 detik (MAD: {motion_mad:.1f})")
                features["scene_type"] = "static_display"
        elif motion_mad > 12.0:
            features["action"] = True
    else:
        features["action"] = True

    # ── C. FACE DETECTION ──
    has_face = False
    if HAS_GATEKEEPER and face_detector:
        try:
            detected, face_conf, _, face_desc = face_detector.detect(full_bgr)
            if detected:
                has_face = True
                reasons.append(f"Wajah terdeteksi ({face_desc})")
        except Exception:
            pass

    if not has_face:
        # Standalone Haar cascade fallback if available
        cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        if os.path.exists(cascade_path):
            cascade = cv2.CascadeClassifier(cascade_path)
            gray_full = cv2.cvtColor(full_bgr, cv2.COLOR_BGR2GRAY)
            faces = cascade.detectMultiScale(gray_full, scaleFactor=1.2, minNeighbors=4, minSize=(30, 30))
            if len(faces) > 0:
                has_face = True
                reasons.append("Wajah terdeteksi di frame (Haar cascade)")

    features["face"] = has_face
    if has_face:
        features["scene_type"] = "talking_head"

    # ── D. SUBTITLE / TEXT DETECTION ──
    has_text = False
    if HAS_GATEKEEPER and text_detector:
        try:
            has_text, total_cov, bot_cov, text_desc = text_detector.detect(cropped_bgr)
            if has_text:
                reasons.append(text_desc)
        except Exception:
            pass

    if not has_text:
        # Standalone bottom 35% Canny edge check
        bottom_cut = int(h * 0.65)
        bottom_roi = cropped_bgr[bottom_cut:, :]
        bottom_gray = cv2.cvtColor(bottom_roi, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(bottom_gray, 50, 150)
        bot_density = float(np.count_nonzero(edges)) / float(edges.size)
        if bot_density > 0.17:
            has_text = True
            reasons.append(f"Teks subtitle terbakar di area bawah ({bot_density * 100:.1f}%)")

    features["text"] = has_text

    # ── E. WATERMARK & CORNER LOGO DETECTION ──
    has_watermark = False
    # Check top-right and bottom-right corner patches for persistent high-contrast badges
    corners = [
        ("top_right", cropped_bgr[:int(h * 0.18), int(w * 0.60):]),
        ("bottom_right", cropped_bgr[int(h * 0.82):, int(w * 0.60):]),
        ("top_left", cropped_bgr[:int(h * 0.18), :int(w * 0.40):])
    ]
    for c_name, c_roi in corners:
        if c_roi.size == 0:
            continue
        c_gray = cv2.cvtColor(c_roi, cv2.COLOR_BGR2GRAY)
        c_edges = cv2.Canny(c_gray, 80, 200)
        c_density = float(np.count_nonzero(c_edges)) / float(c_edges.size)
        
        # High edge density in a small corner indicates logo/watermark overlay
        if c_density > 0.22:
            has_watermark = True
            reasons.append(f"Watermark/logo terdeteksi di sudut {c_name} ({c_density * 100:.1f}%)")
            break

    features["watermark"] = has_watermark

    # ── F. PACKAGING / UNBOXING / CARDBOARD BOX HEURISTIC ──
    # Unboxing videos often have brown cardboard boxes, plastic wrappers, styrofoam
    # Dominant cardboard brown color in HSV
    hsv = cv2.cvtColor(cropped_bgr, cv2.COLOR_BGR2HSV)
    # Brown cardboard range: H: 10-25, S: 50-200, V: 50-220
    brown_mask = cv2.inRange(hsv, np.array([10, 50, 50]), np.array([25, 200, 220]))
    brown_ratio = float(np.count_nonzero(brown_mask)) / float(brown_mask.size)
    if brown_ratio > 0.45:
        features["scene_type"] = "packaging"
        reasons.append(f"Kardus kemasan / packaging unboxing dominan ({brown_ratio * 100:.1f}%)")

    # ── G. SCENE CLASSIFICATION WITH MOBILENETV3 (IF AVAILABLE) ──
    if HAS_GATEKEEPER and scene_detector:
        try:
            is_scene_valid, s_conf, s_desc = scene_detector.evaluate(cropped_bgr)
            confidence = s_conf
            if not is_scene_valid:
                features["graphic"] = True
                reasons.append(s_desc)
        except Exception:
            pass

    # ── H. DETERMINE FINAL LABEL (valid_real vs rejected) ──
    # Rejection criteria: face, text, watermark, graphic, packaging, or extended freeze
    is_rejected = (
        features["face"] or
        features["text"] or
        features["watermark"] or
        features["graphic"] or
        (features["static"] and consecutive_static_count >= 2) or
        (features["scene_type"] in ["packaging", "graphic_intro", "talking_head"])
    )

    if is_rejected:
        label = "rejected"
        final_reason = "; ".join(reasons) if reasons else "Kriteria visual tidak memenuhi syarat"
    else:
        label = "valid_real"
        if motion_mad > 12.0:
            features["scene_type"] = "demonstration"
            final_reason = "Peragaan fisik produk nyata alami & tangan aktif (bebas wajah/teks)"
        else:
            features["scene_type"] = "close_up_product"
            final_reason = "Close-up produk bersih & tajam (bebas wajah/teks/watermark)"

    return features, label, final_reason, confidence, motion_mad


# ─────────────────────────────────────────────────────────────────────────────
# 4. DOWNLOAD VIDEO VIA YT-DLP IF YOUTUBE URL
# ─────────────────────────────────────────────────────────────────────────────
def resolve_video_source(source_input):
    """
    Resolves YouTube URL or local video path.
    Returns (local_video_path, video_id, is_temp).
    """
    if os.path.exists(source_input):
        vid_id = os.path.splitext(os.path.basename(source_input))[0]
        return source_input, vid_id, False

    # Extract YouTube ID
    import re
    m = re.search(r"(?:v=|\/|youtu\.be\/)([a-zA-Z0-9_-]{11})", source_input)
    vid_id = m.group(1) if m else "online_video"

    local_output = os.path.join(TEMP_DIR, f"{vid_id}.mp4")
    if os.path.exists(local_output) and os.path.getsize(local_output) > 100_000:
        print(f"📁 [Curator] Video lokal sudah tersedia di cache: {local_output}")
        return local_output, vid_id, False

    print(f"⬇️ [Curator] Mengunduh video YouTube: {source_input}...")
    yt_dlp_bin = "/usr/local/bin/yt-dlp" if os.path.exists("/usr/local/bin/yt-dlp") else "yt-dlp"

    cmd = [
        yt_dlp_bin,
        "-f", "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4]/best",
        "--merge-output-format", "mp4",
        "-o", local_output,
        source_input,
        "--no-warnings"
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0 or not os.path.exists(local_output):
        # Fallback to direct single stream
        cmd2 = [
            yt_dlp_bin,
            "-f", "18/best[ext=mp4]/best",
            "-o", local_output,
            source_input,
            "--no-warnings"
        ]
        res2 = subprocess.run(cmd2, capture_output=True, text=True)
        if res2.returncode != 0 or not os.path.exists(local_output):
            raise RuntimeError(f"Gagal mengunduh video: {res.stderr or res2.stderr}")

    print(f"✅ Video berhasil diunduh: {local_output} ({os.path.getsize(local_output) // 1024} KB)")
    return local_output, vid_id, True


# ─────────────────────────────────────────────────────────────────────────────
# 5. CORE CURATION PIPELINE WITH CLUSTER DEDUPLICATION
# ─────────────────────────────────────────────────────────────────────────────
def curate_video(
    source_input,
    split="train",
    sample_interval_sec=1.0,
    similarity_thresh=0.88,
    target_frames_max=200
):
    """
    Executes the full GPT workflow:
    Extract 1 FPS -> Pre-filter -> Cluster/Similarity Deduplication -> Hard Negative Evaluation -> Datasheet.
    """
    video_path, video_id, is_temp = resolve_video_source(source_input)

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Tidak dapat membuka file video: {video_path}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration_sec = total_frames / fps

    print("\n" + "═" * 65)
    print(f"🎬 SMART AI DATASET CURATOR - CLIPPERVPS")
    print(f"   • Video ID      : {video_id}")
    print(f"   • Durasi        : {duration_sec:.1f} detik ({duration_sec / 60:.2f} menit)")
    print(f"   • Sampling Rate : 1 frame per {sample_interval_sec} detik (1 FPS)")
    print(f"   • Target Split  : [{split.upper()}] (Video-level grouping)")
    print(f"   • Max Target    : {target_frames_max} frame beragam")
    print("═" * 65 + "\n")

    frame_step = max(1, int(fps * sample_interval_sec))
    frame_idx = 0
    ts_sec = 0.0

    target_base = VAL_DIR if split == "val" else (TEST_DIR if split == "test" else TRAIN_DIR)

    datasheet_records = []
    saved_clusters = []   # Representatives of accepted frame clusters
    prev_cropped = None
    consecutive_static = 0
    cluster_counter = 0

    stats = {
        "total_sampled": 0,
        "dropped_similarity": 0,
        "saved_valid_real": 0,
        "saved_rejected": 0,
        "hard_negatives": {
            "face": 0,
            "text": 0,
            "watermark": 0,
            "graphic": 0,
            "packaging": 0,
            "static_freeze": 0
        }
    }

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % frame_step == 0:
            ts_sec = round(frame_idx / fps, 2)
            stats["total_sampled"] += 1

            cropped_9_16 = crop_9_16(frame)

            # Analyze multi-column features
            features, label, reason, conf, motion_mad = analyze_frame_features(
                cropped_9_16,
                frame,
                prev_cropped,
                consecutive_static_count=consecutive_static
            )

            if motion_mad < 5.5:
                consecutive_static += 1
            else:
                consecutive_static = 0

            # ── SIMILARITY CLUSTERING & DEDUPLICATION ──
            # Skip near-identical frames to prevent visual repetition & dataset bias
            is_redundant = False
            assigned_cluster_id = cluster_counter

            # Check similarity against recent cluster centers
            for cl_id, cl_img in saved_clusters[-15:]:
                sim, _ = compute_frame_similarity(cropped_9_16, cl_img)
                if sim >= similarity_thresh:
                    is_redundant = True
                    assigned_cluster_id = cl_id
                    break

            # If redundant and we already have enough valid frames in this cluster, drop it
            if is_redundant and label == "valid_real":
                stats["dropped_similarity"] += 1
                # Still record in datasheet for audit with 'dropped_redundant' note
                datasheet_records.append({
                    "filename": f"clip_{video_id}_t{int(ts_sec):04d}.jpg",
                    "video_id": video_id,
                    "timestamp_sec": ts_sec,
                    "label": "skipped_duplicate",
                    "split": split,
                    "face": features["face"],
                    "text": features["text"],
                    "watermark": features["watermark"],
                    "graphic": features["graphic"],
                    "static": features["static"],
                    "action": features["action"],
                    "product": features["product"],
                    "scene_type": features["scene_type"],
                    "confidence": round(conf, 3),
                    "reason": f"Dibuang: Frame sangat mirip dengan cluster #{assigned_cluster_id} (Deduplikasi visual)",
                    "cluster_id": assigned_cluster_id,
                    "notes": "Redundant frame dropped per GPT clustering rules"
                })
                frame_idx += 1
                prev_cropped = cropped_9_16
                continue

            # If it's a new distinct visual scene, create a new cluster
            if not is_redundant:
                cluster_counter += 1
                assigned_cluster_id = cluster_counter
                saved_clusters.append((assigned_cluster_id, cropped_9_16))

            # Track hard negative categories
            if features["face"]:
                stats["hard_negatives"]["face"] += 1
            if features["text"]:
                stats["hard_negatives"]["text"] += 1
            if features["watermark"]:
                stats["hard_negatives"]["watermark"] += 1
            if features["graphic"]:
                stats["hard_negatives"]["graphic"] += 1
            if features["scene_type"] == "packaging":
                stats["hard_negatives"]["packaging"] += 1
            if features["static"] and consecutive_static >= 2:
                stats["hard_negatives"]["static_freeze"] += 1

            # Save frame image (224x224 standard training size)
            out_filename = f"clip_{video_id}_t{int(ts_sec):04d}.jpg"
            out_folder = os.path.join(target_base, label)
            out_path = os.path.join(out_folder, out_filename)

            train_img = cv2.resize(cropped_9_16, (224, 224), interpolation=cv2.INTER_AREA)
            cv2.imwrite(out_path, train_img)

            if label == "valid_real":
                stats["saved_valid_real"] += 1
                icon = "✅ [VALID]"
            else:
                stats["saved_rejected"] += 1
                icon = "❌ [REJECT]"

            print(f"{icon} t={ts_sec:5.1f}s | Clust #{assigned_cluster_id:02d} | {features['scene_type']:<15} | {reason}")

            datasheet_records.append({
                "filename": out_filename,
                "video_id": video_id,
                "timestamp_sec": ts_sec,
                "label": label,
                "split": split,
                "face": features["face"],
                "text": features["text"],
                "watermark": features["watermark"],
                "graphic": features["graphic"],
                "static": features["static"],
                "action": features["action"],
                "product": features["product"],
                "scene_type": features["scene_type"],
                "confidence": round(conf, 3),
                "reason": reason,
                "cluster_id": assigned_cluster_id,
                "notes": f"Saved to {split}/{label}"
            })

            prev_cropped = cropped_9_16

            # Stop if reached target maximum diverse frames
            if (stats["saved_valid_real"] + stats["saved_rejected"]) >= target_frames_max:
                print(f"\n🎯 Mencapai batas target maksimal {target_frames_max} frame beragam terkurasi.")
                break

        frame_idx += 1

    cap.release()

    # ── EXPORT DATASHEET IN JSON AND CSV ──
    json_path = os.path.join(DATASET_DIR, f"{video_id}_curated_datasheet.json")
    csv_path = os.path.join(DATASET_DIR, f"{video_id}_curated_datasheet.csv")

    with open(json_path, "w", encoding="utf-8") as f_json:
        json.dump(datasheet_records, f_json, indent=2, ensure_ascii=False)

    if datasheet_records:
        keys = list(datasheet_records[0].keys())
        with open(csv_path, "w", newline="", encoding="utf-8") as f_csv:
            writer = csv.DictWriter(f_csv, fieldnames=keys)
            writer.writeheader()
            writer.writerows(datasheet_records)

    # ── PRINT SUMMARY REPORT ──
    print("\n" + "═" * 65)
    print(f"📊 LAPORAN KURASI DATASET AI (GPT-COMPLIANT):")
    print(f"   • Total Frame Disampling (1 FPS)  : {stats['total_sampled']}")
    print(f"   • Frame Dibuang (Redundansi/Mirip): {stats['dropped_similarity']} frame")
    print(f"   • Frame Valid Disimpan (valid_real): {stats['saved_valid_real']} frame")
    print(f"   • Hard Negatives (rejected)       : {stats['saved_rejected']} frame")
    print(f"     - Wajah Manusia                 : {stats['hard_negatives']['face']}")
    print(f"     - Subtitle / Teks               : {stats['hard_negatives']['text']}")
    print(f"     - Watermark / Logo Sudut        : {stats['hard_negatives']['watermark']}")
    print(f"     - Grafis / Bumper 2D            : {stats['hard_negatives']['graphic']}")
    print(f"     - Kemasan / Kardus Unboxing     : {stats['hard_negatives']['packaging']}")
    print(f"     - Freeze / Statis > 3 Detik     : {stats['hard_negatives']['static_freeze']}")
    print(f"   • Total Kluster Visual Unik       : {len(saved_clusters)}")
    print(f"   • Format Datasheet JSON           : {json_path}")
    print(f"   • Format Datasheet CSV            : {csv_path}")
    print("═" * 65 + "\n")

    return {
        "stats": stats,
        "json_datasheet": json_path,
        "csv_datasheet": csv_path,
        "total_saved": stats["saved_valid_real"] + stats["saved_rejected"]
    }


# ─────────────────────────────────────────────────────────────────────────────
# 6. CLI ENTRYPOINT
# ─────────────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Smart AI Dataset Curator & Multi-Feature Datasheet Generator")
    parser.add_argument("--video", type=str, required=True, help="YouTube URL atau path file video MP4")
    parser.add_argument("--split", type=str, choices=["train", "val", "test"], default="train", help="Dataset split (train/val/test)")
    parser.add_argument("--interval", type=float, default=1.0, help="Interval sampling detik (default: 1.0 = 1 FPS)")
    parser.add_argument("--similarity", type=float, default=0.88, help="Threshold kesamaan visual untuk buang duplikat (0.0-1.0)")
    parser.add_argument("--max-frames", type=int, default=200, help="Target maksimal frame beragam yang disimpan")
    args = parser.parse_args()

    curate_video(
        source_input=args.video,
        split=args.split,
        sample_interval_sec=args.interval,
        similarity_thresh=args.similarity,
        target_frames_max=args.max_frames
    )


if __name__ == "__main__":
    main()
