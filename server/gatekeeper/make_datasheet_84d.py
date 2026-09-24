#!/usr/bin/env python3
"""
Datasheet Generator & Frame Extractor for Video 84d2721052.
Ground truth verified: Video tidak mengandung wajah manusia sama sekali.
Hanya 6 frame yang mengandung teks overlay / animasi promosi (detik 19s, 21s, 22s, 23s, 31s, 34s).
Seluruh frame lainnya (28 frame) merupakan peragaan fisik produk nyata (valid_real).
"""
import os
import sys
import glob
import json
import cv2  # type: ignore

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
DATASET_DIR = os.path.join(CURRENT_DIR, "dataset")
TRAIN_DIR = os.path.join(DATASET_DIR, "train")
VAL_DIR = os.path.join(DATASET_DIR, "val")

REJECTED_TIMESTAMPS = {19, 21, 22, 23, 31, 34}

for d in [TRAIN_DIR, VAL_DIR]:
    os.makedirs(os.path.join(d, "valid_real"), exist_ok=True)
    os.makedirs(os.path.join(d, "rejected"), exist_ok=True)

def crop_9_16(image):
    h, w = image.shape[:2]
    target_w = int(h * 9.0 / 16.0)
    if target_w >= w:
        return image
    x_start = (w - target_w) // 2
    return image[:, x_start:x_start + target_w]

def clean_old_files(video_id):
    pattern = f"clip_{video_id}_t*.jpg"
    for sub in ["train/rejected", "train/valid_real", "val/rejected", "val/valid_real"]:
        search_path = os.path.join(DATASET_DIR, sub, pattern)
        for f in glob.glob(search_path):
            try:
                os.remove(f)
            except Exception:
                pass

def process_frames(frames_dir, video_id="84d2721052"):
    clean_old_files(video_id)
    
    frames = sorted(glob.glob(os.path.join(frames_dir, "*.jpg")))
    print(f"🎬 Memproses {len(frames)} frame dari {frames_dir}...")
    print(f"📌 Ground Truth: Frame teks overlay/animasi promosi pada detik: {sorted(list(REJECTED_TIMESTAMPS))}")

    datasheet = []
    rejected_count = 0
    clean_count = 0

    for idx, fpath in enumerate(frames):
        fname = os.path.basename(fpath)
        img = cv2.imread(fpath)
        if img is None:
            continue

        try:
            num_part = int(fname.split("_")[1].split(".")[0])
            ts_sec = num_part
        except Exception:
            ts_sec = idx + 1

        is_rejected = (ts_sec in REJECTED_TIMESTAMPS)
        label = "rejected" if is_rejected else "valid_real"
        split = "val" if (ts_sec % 5 == 0) else "train"
        out_filename = f"clip_{video_id}_t{ts_sec:03d}.jpg"

        crop = crop_9_16(img)
        train_img = cv2.resize(crop, (224, 224), interpolation=cv2.INTER_AREA)
        out_path = os.path.join(DATASET_DIR, split, label, out_filename)
        cv2.imwrite(out_path, train_img)

        if is_rejected:
            stage = "text"
            reason = "Teks overlay / banner animasi promosi masuk frame (coverage 12-15%)"
            details = {
                "text_type": "promo_banner_animated",
                "coverage_range": "12-15%",
                "verified_by_user": True
            }
            rejected_count += 1
            print(f"❌ [REJECTED] {fname} (t={ts_sec}s): {reason} -> {split}/{label}/{out_filename}")
        else:
            stage = "clean"
            reason = "Peragaan fisik produk nyata alami (bebas wajah & bebas teks)"
            details = {
                "product": "wadah silikon pot air fryer",
                "has_face": False,
                "has_text": False,
                "verified_by_user": True
            }
            clean_count += 1
            print(f"✅ [VALID]    {fname} (t={ts_sec}s) -> {split}/{label}/{out_filename}")

        datasheet.append({
            "filename": out_filename,
            "source_frame": fname,
            "timestamp_sec": ts_sec,
            "label": label,
            "split": split,
            "stage": stage,
            "reason": reason,
            "details": details
        })

    ds_name = f"final_clip_auto_{video_id}_datasheet.json"
    ds_path = os.path.join(DATASET_DIR, ds_name)
    with open(ds_path, "w", encoding="utf-8") as f:
        json.dump(datasheet, f, indent=2, ensure_ascii=False)

    print("\n═══════════════════════════════════════════════════════════")
    print(f"📊 Ringkasan Datasheet Video {video_id} (Ground Truth Verified):")
    print(f"   • Total Frame         : {len(datasheet)}")
    print(f"   • Teks Overlay Ditolak : {rejected_count} frame ({sorted(list(REJECTED_TIMESTAMPS))})")
    print(f"   • Produk Fisik Bersih : {clean_count} frame")
    print(f"   • File Datasheet      : {ds_path}")
    print("═══════════════════════════════════════════════════════════")

if __name__ == "__main__":
    frames_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "temp", "inspect_84d2721052")
    vid_id = sys.argv[2] if len(sys.argv) > 2 else "84d2721052"
    process_frames(frames_dir, vid_id)
