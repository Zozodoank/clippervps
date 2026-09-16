#!/usr/bin/env python3
"""
collect_smartphone_frames.py
-------------------------------------------------------------------------------
Kolektor dan Kurator Frame Khusus Niche Smartphone untuk ClipperVPS Gatekeeper.
Mengekstrak frame dari video review smartphone (durasi 5-7 menit),
memotong ke 9:16 vertikal, melabeli babak (desain, bezel, layar 120Hz,
gaming/performa, uji kamera, baterai, serta wajah vlogger reject),
dan menghasilkan datasheet JSON modular: datasheet_smartphone_<id>.json.
-------------------------------------------------------------------------------
"""

import os
import sys
import glob
import json
import time
import argparse
import subprocess
import cv2
import numpy as np

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATASET_DIR = os.path.join(BASE_DIR, "dataset", "smartphone")
TRAIN_VALID_DIR = os.path.join(DATASET_DIR, "train", "valid_real")
TRAIN_REJECT_DIR = os.path.join(DATASET_DIR, "train", "rejected")
VAL_VALID_DIR = os.path.join(DATASET_DIR, "val", "valid_real")
VAL_REJECT_DIR = os.path.join(DATASET_DIR, "val", "rejected")

os.makedirs(TRAIN_VALID_DIR, exist_ok=True)
os.makedirs(TRAIN_REJECT_DIR, exist_ok=True)
os.makedirs(VAL_VALID_DIR, exist_ok=True)
os.makedirs(VAL_REJECT_DIR, exist_ok=True)


def crop_to_9_16(image_bgr):
    """Memotong frame 16:9 menjadi 9:16 vertikal (center crop)."""
    h, w = image_bgr.shape[:2]
    target_w = int(h * 9.0 / 16.0)
    if target_w >= w:
        return image_bgr
    x_start = (w - target_w) // 2
    return image_bgr[:, x_start:x_start + target_w]


def detect_face_heuristic(image_bgr):
    """
    Deteksi cepat wajah menggunakan OpenCV Haar Cascade / YuNet jika tersedia.
    Mengembalikan: has_face (bool), area_ratio (float), is_vlogger_talking_head (bool)
    """
    h, w = image_bgr.shape[:2]
    total_area = float(h * w)

    # Coba Haar Cascade built-in OpenCV
    cascade_path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
    if os.path.exists(cascade_path):
        face_cascade = cv2.CascadeClassifier(cascade_path)
        gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
        faces = face_cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=4, minSize=(30, 30))
        if len(faces) > 0:
            max_area = 0.0
            for (x, y, fw, fh) in faces:
                area = float(fw * fh)
                if area > max_area:
                    max_area = area
            ratio = max_area / total_area
            # Jika rasio wajah >= 7% dari frame 9:16 -> Vlogger talking head!
            is_talking_head = ratio >= 0.07
            return True, ratio, is_talking_head

    return False, 0.0, False


def classify_frame_by_chapter(ts_sec, total_duration_sec, has_face, is_talking_head):
    """
    Mengelompokkan peran frame smartphone berdasarkan timeline durasi reviewer (5-7 menit).
    """
    norm_pos = ts_sec / max(1.0, total_duration_sec)

    # 1. Jika ada wajah vlogger talking head -> REJECT
    if has_face and is_talking_head:
        return "rejected", "reject_vlogger_face", "Wajah vlogger / presenter talking head di studio"

    # 2. Intro awal (0% - 10% timeline): seringkali intro bumper atau wajah vlogger
    if norm_pos < 0.10:
        if has_face:
            return "rejected", "reject_vlogger_face", "Intro video dengan wajah reviewer"
        return "valid_real", "smartphone_hero_unboxing", "Opening hero shot bodi smartphone atau kotak"

    # 3. Desain fisik & Bezel (10% - 30% timeline)
    if norm_pos < 0.30:
        return "valid_real", "smartphone_design_bezel", "B-roll fisik: bodi belakang, modul kamera, atau bezel layar tipis"

    # 4. Layar & Antarmuka UI 120Hz (30% - 50% timeline)
    if norm_pos < 0.50:
        return "valid_real", "smartphone_screen_ui", "Layar AMOLED navigasi smooth 120Hz dan antarmuka OS"

    # 5. Performa & Pengujian Game (50% - 68% timeline)
    if norm_pos < 0.68:
        return "valid_real", "smartphone_gaming_performance", "Uji performa gaming MLBB/PUBG atau multitasking aplikasi berat"

    # 6. Pengujian Kamera & Sample Foto (68% - 85% timeline)
    if norm_pos < 0.85:
        return "valid_real", "smartphone_camera_sample", "Uji rekaman video 4K jernih atau still photo jepretan kamera"

    # 7. Baterai, Pengisian Daya & Kesimpulan (85% - 100% timeline)
    return "valid_real", "smartphone_battery_cta", "Daya tahan baterai, charger Type-C, dan bodi utuh penutup"


def process_video_file(video_path, product_name="Smartphone Flagship Review", interval_sec=3.0, max_frames=60):
    """
    Mengekstrak frame dari file video lokal dan menyusun datasheet.
    """
    if not os.path.exists(video_path):
        print(f"❌ Video file tidak ditemukan: {video_path}")
        return None

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"❌ Gagal membuka video: {video_path}")
        return None

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    total_frames_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    duration_sec = total_frames_count / fps

    video_basename = os.path.splitext(os.path.basename(video_path))[0]
    clean_id = "".join(c for c in video_basename if c.isalnum())[:16] or "sample"

    print(f"\n📱 Memproses Video Smartphone: {video_basename}")
    print(f"   Durasi: {duration_sec:.1f}s ({int(duration_sec // 60)}m {int(duration_sec % 60)}s) | FPS: {fps:.1f}")
    print(f"   Interval sampling: setiap {interval_sec}s | Target maks: {max_frames} frame\n")

    datasheet_records = []
    saved_count = 0
    ts_current = 1.0

    while ts_current < (duration_sec - 1.0) and saved_count < max_frames:
        frame_idx = int(ts_current * fps)
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ret, frame = cap.read()
        if not ret or frame is None:
            ts_current += interval_sec
            continue

        # Potong ke 9:16 vertikal
        crop_916 = crop_to_9_16(frame)

        # Cek deteksi wajah
        has_face, face_ratio, is_talking_head = detect_face_heuristic(crop_916)

        label, category, reason = classify_frame_by_chapter(ts_current, duration_sec, has_face, is_talking_head)

        # Tentukan split train (80%) vs val (20%)
        is_val = (saved_count % 5 == 0)
        split_name = "val" if is_val else "train"

        time_str = f"t{int(ts_current):03d}"
        filename = f"phone_{clean_id}_{time_str}.jpg"

        if label == "valid_real":
            target_folder = VAL_VALID_DIR if is_val else TRAIN_VALID_DIR
        else:
            target_folder = VAL_REJECT_DIR if is_val else TRAIN_REJECT_DIR

        dest_path = os.path.join(target_folder, filename)
        cv2.imwrite(dest_path, crop_916, [cv2.IMWRITE_JPEG_QUALITY, 90])

        mins = int(ts_current // 60)
        secs = int(ts_current % 60)
        formatted_time = f"{mins:02d}:{secs:02d}"

        record = {
            "filename": filename,
            "relative_path": os.path.relpath(dest_path, BASE_DIR).replace("\\", "/"),
            "video_source": os.path.basename(video_path),
            "product_name": product_name,
            "timestamp_sec": round(ts_current, 1),
            "time_formatted": formatted_time,
            "label": label,
            "category": category,
            "split": split_name,
            "reason": reason,
            "features": {
                "has_face": has_face,
                "face_ratio": round(face_ratio, 4),
                "is_talking_head": is_talking_head,
                "niche": "gadget_smartphone"
            }
        }
        datasheet_records.append(record)
        saved_count += 1

        label_icon = "✅" if label == "valid_real" else "⛔"
        print(f"   [{formatted_time}] {label_icon} {category} -> {filename}")

        ts_current += interval_sec

    cap.release()

    # Simpan Datasheet JSON Modular
    datasheet_filename = f"datasheet_smartphone_{clean_id}.json"
    datasheet_path = os.path.join(DATASET_DIR, datasheet_filename)
    with open(datasheet_path, "w", encoding="utf-8") as f:
        json.dump(datasheet_records, f, indent=2, ensure_ascii=False)

    valid_total = sum(1 for r in datasheet_records if r["label"] == "valid_real")
    reject_total = sum(1 for r in datasheet_records if r["label"] == "rejected")

    print(f"\n✨ Selesai! Berhasil mengekstrak {saved_count} frame:")
    print(f"   - Valid Real (B-roll Smartphone): {valid_total} frame")
    print(f"   - Rejected (Wajah Vlogger/Intro): {reject_total} frame")
    print(f"   - Datasheet Modular tersimpan di: {datasheet_path}\n")

    return datasheet_path


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Smartphone Dataset & Datasheet Collector")
    parser.add_argument("--video", type=str, help="Path ke file video reviewer smartphone lokal")
    parser.add_argument("--name", type=str, default="Smartphone Flagship Review", help="Nama produk smartphone")
    parser.add_argument("--interval", type=float, default=3.0, help="Interval sampling per detik (default: 3.0s)")
    parser.add_argument("--max-frames", type=int, default=60, help="Jumlah maksimum frame yang diekstrak")
    args = parser.parse_args()

    if args.video:
        process_video_file(args.video, product_name=args.name, interval_sec=args.interval, max_frames=args.max_frames)
    else:
        # Cek apakah ada video sampel di folder temp / uploads
        search_dirs = [
            os.path.join(BASE_DIR, "..", "temp"),
            os.path.join(BASE_DIR, "..", "..", "public", "uploads"),
            os.path.join(BASE_DIR, "..", "output")
        ]
        found_videos = []
        for d in search_dirs:
            if os.path.exists(d):
                found_videos.extend(glob.glob(os.path.join(d, "*.mp4")))

        if found_videos:
            print(f"Menemukan {len(found_videos)} file video lokal. Memproses video pertama: {found_videos[0]}")
            process_video_file(found_videos[0], product_name=args.name, interval_sec=args.interval, max_frames=args.max_frames)
        else:
            print("Gunakan parameter: python collect_smartphone_frames.py --video /path/to/video.mp4 --name 'Poco X6 Pro'")
