#!/usr/bin/env python3
"""
Memeriksa frame video 84d2721052, memformat ke 224x224, 
memasukkan frame kotor ke dataset train/val rejected,
dan membuat datasheet json.
"""
import os
import sys
import glob
import json
import cv2

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
DATASET_DIR = os.path.join(CURRENT_DIR, "dataset")
TRAIN_DIR = os.path.join(DATASET_DIR, "train")
VAL_DIR = os.path.join(DATASET_DIR, "val")

for d in [TRAIN_DIR, VAL_DIR]:
    os.makedirs(os.path.join(d, "valid_real"), exist_ok=True)
    os.makedirs(os.path.join(d, "rejected"), exist_ok=True)

sys.path.insert(0, CURRENT_DIR)
from service import FrameGatekeeper

def process_frames(frames_dir, video_id="84d2721052"):
    frames = sorted(glob.glob(os.path.join(frames_dir, "*.jpg")))
    print(f"🎬 Memeriksa {len(frames)} frame dari {frames_dir}...")

    gatekeeper = FrameGatekeeper()
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

        res = gatekeeper.process_single_frame(fpath, timestamp=ts_sec)
        is_rejected = (res.get("status") != "clean")
        
        # 9:16 crop & resize to 224x224 standard dataset size
        crop = FrameGatekeeper.crop_9_16(img)
        train_img = cv2.resize(crop, (224, 224), interpolation=cv2.INTER_AREA)

        label = "rejected" if is_rejected else "valid_real"
        # Deterministic 20% validation split (setiap kelipatan 5)
        split = "val" if (ts_sec % 5 == 0) else "train"

        out_filename = f"clip_{video_id}_t{ts_sec:03d}.jpg"
        out_path = os.path.join(DATASET_DIR, split, label, out_filename)
        cv2.imwrite(out_path, train_img)

        reason = res.get("reason", "Frame peragaan fisik bersih")
        stage = res.get("stage", "clean")

        entry = {
            "filename": out_filename,
            "source_frame": fname,
            "timestamp_sec": ts_sec,
            "label": label,
            "split": split,
            "stage": stage,
            "reason": reason,
            "details": {
                k: v for k, v in res.items() 
                if k not in ["filePath", "timestamp", "status", "stage", "reason"]
            }
        }
        datasheet.append(entry)

        if is_rejected:
            rejected_count += 1
            print(f"❌ [REJECTED] {fname} (t={ts_sec}s, stage={stage}): {reason} -> {split}/{label}/{out_filename}")
        else:
            clean_count += 1
            print(f"✅ [CLEAN]    {fname} (t={ts_sec}s) -> {split}/{label}/{out_filename}")

    ds_name = f"final_clip_auto_{video_id}_datasheet.json"
    ds_path = os.path.join(DATASET_DIR, ds_name)
    with open(ds_path, "w", encoding="utf-8") as f:
        json.dump(datasheet, f, indent=2, ensure_ascii=False)

    print("\n═══════════════════════════════════════════════════════════")
    print(f"📊 Ringkasan Pemrosesan Video {video_id}:")
    print(f"   • Total Frame        : {len(datasheet)}")
    print(f"   • Ditolak (rejected) : {rejected_count} frame")
    print(f"   • Lolos (valid_real) : {clean_count} frame")
    print(f"   • Datasheet JSON     : {ds_path}")
    print("═══════════════════════════════════════════════════════════")

if __name__ == "__main__":
    frames_dir = sys.argv[1] if len(sys.argv) > 1 else "/home/ubuntu/clipperVPS/server/temp/inspect_84d2721052"
    vid_id = sys.argv[2] if len(sys.argv) > 2 else "84d2721052"
    process_frames(frames_dir, vid_id)
