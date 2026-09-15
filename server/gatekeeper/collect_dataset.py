#!/usr/bin/env python3
"""
Dataset Collector & Frame Extractor for ClipperVPS AI Training.
Extracts 9:16 cropped frames from YouTube or local video files,
auto-labels them into `valid_real` vs `rejected`, and builds a dataset
ready for Google Colab PyTorch/ONNX transfer learning.

Usage:
  python3 collect_dataset.py --video /path/to/video.mp4
  python3 collect_dataset.py --frames-dir ../temp
  python3 collect_dataset.py --zip
"""

import os
import sys
import glob
import json
import time
import shutil
import zipfile
import argparse
import numpy as np
import cv2

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
DATASET_DIR = os.path.join(CURRENT_DIR, "dataset")
TRAIN_DIR = os.path.join(DATASET_DIR, "train")
VAL_DIR = os.path.join(DATASET_DIR, "val")

for split_dir in [TRAIN_DIR, VAL_DIR]:
    os.makedirs(os.path.join(split_dir, "valid_real"), exist_ok=True)
    os.makedirs(os.path.join(split_dir, "rejected"), exist_ok=True)


def crop_9_16(image):
    h, w = image.shape[:2]
    target_w = int(h * 9.0 / 16.0)
    if target_w >= w:
        return image
    x_start = (w - target_w) // 2
    return image[:, x_start:x_start + target_w]


def evaluate_frame_heuristic(crop_bgr):
    """
    Heuristic rule to pre-classify frames:
    - Rejects flat 2D cartoons, solid intro bumpers, and extreme plain backgrounds.
    - Accepts real camera textures with rich gradients and detailed objects.
    """
    h, w = crop_bgr.shape[:2]
    if h < 50 or w < 50:
        return "rejected", "Dimensi frame terlalu kecil"

    # 1. Color Quantization Check
    small = cv2.resize(crop_bgr, (64, 64), interpolation=cv2.INTER_AREA)
    quantized = (small >> 5).reshape(-1, 3)
    unique_colors = len(np.unique(quantized, axis=0))

    if unique_colors < 22:
        return "rejected", f"Bumper statis/grafis 2D datar ({unique_colors} warna)"

    # 2. Laplacian Texture Variance
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    laplacian_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    if laplacian_var < 15.0:
        return "rejected", f"Frame polos tanpa tekstur (laplacian: {laplacian_var:.1f})"

    # 3. Bottom Subtitle / Banner Detection
    bottom_cut = int(h * 0.65)
    bottom_roi = crop_bgr[bottom_cut:, :]
    bottom_gray = cv2.cvtColor(bottom_roi, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(bottom_gray, 50, 150)
    edge_density = float(np.count_nonzero(edges)) / float(edges.size)
    if edge_density > 0.18:
        return "rejected", f"Teks subtitle/banner dominan di area bawah ({edge_density * 100:.1f}%)"

    return "valid_real", "Peragaan produk fisik nyata alami"


def extract_from_video(video_path, sample_interval_sec=1.0, val_ratio=0.2, max_frames=None):
    print(f"🎬 [Collector] Mengekstrak frame dari video: {video_path}")
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"❌ Gagal membuka video: {video_path}")
        return

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    duration_sec = total_frames / fps
    print(f"   Durasi video: {duration_sec:.1f} detik | FPS: {fps:.1f}")

    frame_step = max(1, int(fps * sample_interval_sec))
    frame_idx = 0
    saved_counts = {"valid_real": 0, "rejected": 0}
    datasheet = []
    prev_small = None

    video_base = os.path.splitext(os.path.basename(video_path))[0]

    while True:
        if max_frames and (saved_counts["valid_real"] + saved_counts["rejected"]) >= max_frames:
            print(f"   Mencapai batas maksimal {max_frames} frame per video.")
            break

        ret, frame = cap.read()
        if not ret:
            break

        if frame_idx % frame_step == 0:
            ts_sec = round(frame_idx / fps, 2)
            cropped = crop_9_16(frame)
            small = cv2.resize(cropped, (80, 144))

            label, reason = evaluate_frame_heuristic(cropped)

            # Jika frame statis diam terhadap frame sebelumnya (MAD < 6.0), otomatis tolak ke rejected!
            if prev_small is not None:
                diff = float(cv2.absdiff(small, prev_small).mean())
                if diff < 6.0:
                    label = "rejected"
                    reason = f"Foto statis / frame beku tanpa peragaan gerakan fisik (MAD: {diff:.2f})"
            prev_small = small

            is_val = (np.random.rand() < val_ratio)
            target_sub = VAL_DIR if is_val else TRAIN_DIR
            out_filename = f"{video_base}_t{int(ts_sec * 10):05d}.jpg"
            out_path = os.path.join(target_sub, label, out_filename)

            # Resize to standardized training size 224x224
            train_img = cv2.resize(cropped, (224, 224), interpolation=cv2.INTER_AREA)
            cv2.imwrite(out_path, train_img)
            saved_counts[label] += 1

            datasheet.append({
                "filename": out_filename,
                "timestamp_sec": ts_sec,
                "label": label,
                "split": "val" if is_val else "train",
                "reason": reason
            })

        frame_idx += 1

    cap.release()

    # Save datasheet JSON
    ds_path = os.path.join(DATASET_DIR, f"{video_base}_datasheet.json")
    with open(ds_path, "w", encoding="utf-8") as f:
        json.dump(datasheet, f, indent=2)

    print(f"✅ Selesai mengekstrak:")
    print(f"   - valid_real : {saved_counts['valid_real']} frame")
    print(f"   - rejected   : {saved_counts['rejected']} frame")
    print(f"   - Datasheet  : {ds_path}")


def process_existing_frames(frames_dir, val_ratio=0.2):
    print(f"📁 [Collector] Mengklasifikasikan frame dari direktori: {frames_dir}")
    image_files = glob.glob(os.path.join(frames_dir, "**", "*.jpg"), recursive=True) + \
                  glob.glob(os.path.join(frames_dir, "**", "*.png"), recursive=True)

    if not image_files:
        print(f"⚠️ Tidak ada file gambar ditemukan di {frames_dir}")
        return

    saved_counts = {"valid_real": 0, "rejected": 0}
    datasheet = []

    for fpath in image_files:
        img = cv2.imread(fpath)
        if img is None:
            continue

        cropped = crop_9_16(img)
        label, reason = evaluate_frame_heuristic(cropped)

        is_val = (np.random.rand() < val_ratio)
        target_sub = VAL_DIR if is_val else TRAIN_DIR
        out_filename = os.path.basename(fpath)
        out_path = os.path.join(target_sub, label, out_filename)

        train_img = cv2.resize(cropped, (224, 224), interpolation=cv2.INTER_AREA)
        cv2.imwrite(out_path, train_img)
        saved_counts[label] += 1

        datasheet.append({
            "filename": out_filename,
            "original_path": fpath,
            "label": label,
            "split": "val" if is_val else "train",
            "reason": reason
        })

    ds_path = os.path.join(DATASET_DIR, "imported_frames_datasheet.json")
    with open(ds_path, "w", encoding="utf-8") as f:
        json.dump(datasheet, f, indent=2)

    print(f"✅ Selesai mengklasifikasi:")
    print(f"   - valid_real : {saved_counts['valid_real']} frame")
    print(f"   - rejected   : {saved_counts['rejected']} frame")


def zip_dataset(zip_name="dataset_v2.zip"):
    zip_path = os.path.join(CURRENT_DIR, zip_name)
    print(f"📦 [Collector] Mengompres dataset ke {zip_path}...")

    total_files = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, _, files in os.walk(DATASET_DIR):
            for file in files:
                if file.endswith((".jpg", ".png", ".json")):
                    full_path = os.path.join(root, file)
                    rel_path = os.path.relpath(full_path, DATASET_DIR)
                    zf.write(full_path, os.path.join("dataset_v2", rel_path))
                    total_files += 1

    file_size_mb = os.path.getsize(zip_path) / (1024 * 1024)
    print(f"🎉 Dataset siap diupload ke Google Colab!")
    print(f"   Total file : {total_files} file")
    print(f"   Ukuran zip : {file_size_mb:.2f} MB")
    print(f"   File zip   : {zip_path}")


def print_stats():
    train_valid = len(glob.glob(os.path.join(TRAIN_DIR, "valid_real", "*.*")))
    train_reject = len(glob.glob(os.path.join(TRAIN_DIR, "rejected", "*.*")))
    val_valid = len(glob.glob(os.path.join(VAL_DIR, "valid_real", "*.*")))
    val_reject = len(glob.glob(os.path.join(VAL_DIR, "rejected", "*.*")))

    print("\n📊 [Dataset Statistics]")
    print(f"  Training Set   : {train_valid + train_reject} total (Real: {train_valid}, Reject: {train_reject})")
    print(f"  Validation Set : {val_valid + val_reject} total (Real: {val_valid}, Reject: {val_reject})")
    print(f"  Grand Total    : {train_valid + train_reject + val_valid + val_reject} frame\n")


def extract_from_videos_dir(video_dir, sample_interval_sec=1.0, val_ratio=0.2, max_per_video=30):
    print(f"🎬 [Collector] Memindai semua video di folder: {video_dir}")
    video_files = glob.glob(os.path.join(video_dir, "**", "*.mp4"), recursive=True)
    if not video_files:
        print(f"⚠️ Tidak ada video .mp4 ditemukan di {video_dir}")
        return

    print(f"   Ditemukan {len(video_files)} file video. Memulai ekstraksi...")
    for idx, vpath in enumerate(video_files):
        print(f"\n--- [{idx + 1}/{len(video_files)}] Memproses: {os.path.basename(vpath)} ---")
        extract_from_video(vpath, sample_interval_sec=sample_interval_sec, val_ratio=val_ratio, max_frames=max_per_video)


def main():
    parser = argparse.ArgumentParser(description="Dataset Collector & Frame Extractor for ClipperVPS AI")
    parser.add_argument("--video", type=str, help="Path ke file video MP4 untuk diekstrak framenya")
    parser.add_argument("--video-dir", type=str, help="Path ke direktori berisi file video MP4")
    parser.add_argument("--frames-dir", type=str, help="Path ke direktori frame gambar yang sudah ada")
    parser.add_argument("--interval", type=float, default=1.0, help="Interval pengambilan frame (detik)")
    parser.add_argument("--max-per-video", type=int, default=30, help="Maksimal frame yang diambil per video")
    parser.add_argument("--zip", action="store_true", help="Kompres dataset ke dataset_v2.zip untuk Colab")
    parser.add_argument("--stats", action="store_true", help="Tampilkan statistik frame yang terkumpul")
    args = parser.parse_args()

    if args.video:
        extract_from_video(args.video, sample_interval_sec=args.interval, max_frames=args.max_per_video)
    elif args.video_dir:
        extract_from_videos_dir(args.video_dir, sample_interval_sec=args.interval, max_per_video=args.max_per_video)
    elif args.frames_dir:
        process_existing_frames(args.frames_dir)

    print_stats()

    if args.zip:
        zip_dataset()


if __name__ == "__main__":
    main()
