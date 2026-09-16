#!/usr/bin/env python3
"""
Merge curated frames from ai_dataset_local_*.zip into the master gatekeeper dataset & datasheet.
Preserves 100% of all existing datasheets and images without overwriting or deleting any existing records.
"""

import os
import sys
import shutil
import zipfile
import json
import csv
import subprocess
import re

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATASET_ZIP = os.path.join(SCRIPT_DIR, "dataset_v2.zip")
DATASET_DIR = os.path.join(SCRIPT_DIR, "dataset")
FFMPEG_EXE = r"C:\Users\SEMOGA AWET\Documents\clipperVPS\server\node_modules\ffmpeg-static\ffmpeg.exe"

DEFAULT_ZIP = r"C:\Users\SEMOGA AWET\Downloads\ai_dataset_local_1789557989450_51558c.zip"

def run_merge(user_zip_path=None):
    if not user_zip_path:
        user_zip_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_ZIP

    print(f"[Merge Dataset] Memulai penggabungan datasheet...")
    print(f"Source ZIP: {user_zip_path}")
    print(f"Master Dataset ZIP: {DATASET_ZIP}")

    if not os.path.exists(user_zip_path):
        print(f"Error: File {user_zip_path} tidak ditemukan!")
        return False

    if not os.path.exists(DATASET_ZIP):
        print(f"Error: File {DATASET_ZIP} tidak ditemukan!")
        return False

    # Extract session ID and short ID from zip filename
    base_zip_name = os.path.splitext(os.path.basename(user_zip_path))[0]
    match = re.search(r'(local_\d+_([a-f0-9]+))', base_zip_name)
    if match:
        session_id = match.group(1)
        short_id = match.group(2)
    else:
        session_id = base_zip_name
        short_id = base_zip_name[-6:]

    print(f"Session ID: {session_id} | Short ID: {short_id}")

    # Backup dataset_v2.zip
    backup_zip = DATASET_ZIP + ".bak"
    shutil.copyfile(DATASET_ZIP, backup_zip)
    print(f"Backup dataset dibuat: {backup_zip}")

    temp_dir = os.path.join(SCRIPT_DIR, "_temp_merge")
    if os.path.exists(temp_dir):
        shutil.rmtree(temp_dir)
    os.makedirs(temp_dir, exist_ok=True)

    try:
        # 1. Unzip master dataset_v2.zip into temp
        print("Mengekstrak master dataset_v2.zip...")
        with zipfile.ZipFile(DATASET_ZIP, 'r') as z:
            z.extractall(temp_dir)

        # 2. Unzip user curated zip into user_temp
        user_temp = os.path.join(temp_dir, "_user_curated")
        with zipfile.ZipFile(user_zip_path, 'r') as z:
            z.extractall(user_temp)

        # Read manifest & metadata.csv
        manifest_path = os.path.join(user_temp, "dataset_manifest.json")
        metadata_csv_path = os.path.join(user_temp, "metadata.csv")

        tag_defs = {}
        if os.path.exists(manifest_path):
            with open(manifest_path, 'r', encoding='utf-8') as f:
                manifest_data = json.load(f)
                tag_defs = manifest_data.get("tagDefinitions", {})

        csv_records = []
        with open(metadata_csv_path, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                csv_records.append(row)

        print(f"Ditemukan {len(csv_records)} frame yang dikurasi dari user.")

        # Group dynamically by category
        category_groups = {}
        for item in csv_records:
            cat = item.get("category", "rejected")
            category_groups.setdefault(cat, []).append(item)

        datasheet_entries = []

        for cat, items in category_groups.items():
            is_valid_type = cat.startswith("valid")
            target_class_folder = "valid_real" if is_valid_type else "rejected"
            target_label = "valid_real" if is_valid_type else "rejected"

            # Sort items by timestamp for determinism
            sorted_items = sorted(items, key=lambda x: (int(x.get("video_index", 1)), int(x.get("timestamp_sec", 0))))
            val_indices = {len(sorted_items) - 1} if len(sorted_items) <= 4 else {len(sorted_items) // 3, (2 * len(sorted_items)) // 3}

            for idx, item in enumerate(sorted_items):
                is_val = idx in val_indices
                split = "val" if is_val else "train"

                # Find source file inside user_temp
                orig_fname = item["filename"]
                src_img = os.path.join(user_temp, "images", cat, orig_fname)

                if not os.path.exists(src_img):
                    for r, _, files in os.walk(user_temp):
                        if orig_fname in files:
                            src_img = os.path.join(r, orig_fname)
                            break

                out_filename = f"curated_{short_id}_{orig_fname}"

                # Destination inside temp_dir/dataset_v2/<split>/<target_class_folder>/
                dest_img_path = os.path.join(temp_dir, "dataset_v2", split, target_class_folder, out_filename)
                os.makedirs(os.path.dirname(dest_img_path), exist_ok=True)

                # Destination inside local DATASET_DIR/<split>/<target_class_folder>/
                local_img_path = os.path.join(DATASET_DIR, split, target_class_folder, out_filename)
                os.makedirs(os.path.dirname(local_img_path), exist_ok=True)

                # Resize to standard 224x224 using ffmpeg
                cmd = [
                    FFMPEG_EXE, "-y",
                    "-i", src_img,
                    "-vf", "scale=224:224:flags=lanczos",
                    dest_img_path
                ]
                res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if res.returncode != 0 or not os.path.exists(dest_img_path):
                    shutil.copyfile(src_img, dest_img_path)

                # Copy to local dataset folder too
                shutil.copyfile(dest_img_path, local_img_path)

                cat_info = tag_defs.get(cat, {})
                reason = cat_info.get("description", f"Ditolak/Divalidasi: {cat}")

                datasheet_entries.append({
                    "filename": out_filename,
                    "original_filename": orig_fname,
                    "video_source": item.get("video_source", ""),
                    "video_index": int(item.get("video_index", 1)),
                    "timestamp_sec": int(item.get("timestamp_sec", 0)),
                    "time_formatted": item.get("time_formatted", ""),
                    "label": target_label,
                    "category": cat,
                    "category_label": cat_info.get("label", cat),
                    "split": split,
                    "reason": reason,
                    "curated_by_user": True,
                    "session_id": session_id
                })

        # Save individual datasheet for this session
        new_ds_filename = f"curated_local_{short_id}_datasheet.json"
        temp_ds_path = os.path.join(temp_dir, "dataset_v2", new_ds_filename)
        with open(temp_ds_path, 'w', encoding='utf-8') as f:
            json.dump(datasheet_entries, f, indent=2)

        # Also copy to local dataset directory: server/gatekeeper/dataset/
        os.makedirs(DATASET_DIR, exist_ok=True)
        local_ds_path = os.path.join(DATASET_DIR, new_ds_filename)
        with open(local_ds_path, 'w', encoding='utf-8') as f:
            json.dump(datasheet_entries, f, indent=2)
        print(f"Datasheet baru disimpan ke: {local_ds_path}")

        # Re-pack dataset_v2.zip
        print(f"Mengompres ulang dataset_v2.zip dengan penambahan {len(datasheet_entries)} frame baru...")
        new_zip_path = os.path.join(SCRIPT_DIR, "dataset_v2_new.zip")
        with zipfile.ZipFile(new_zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            base_folder = os.path.join(temp_dir, "dataset_v2")
            for root, _, files in os.walk(base_folder):
                for file in files:
                    if file.startswith(".") or file == "_user_curated":
                        continue
                    full_path = os.path.join(root, file)
                    rel_path = os.path.relpath(full_path, temp_dir)
                    zf.write(full_path, rel_path)

        # Replace dataset_v2.zip
        os.replace(new_zip_path, DATASET_ZIP)
        print(f"Master dataset_v2.zip berhasil diperbarui!")

        # Verify new zip stats
        with zipfile.ZipFile(DATASET_ZIP, 'r') as z:
            names = z.namelist()
            train_valid = len([n for n in names if 'train/valid_real' in n and n.endswith('.jpg')])
            train_reject = len([n for n in names if 'train/rejected' in n and n.endswith('.jpg')])
            val_valid = len([n for n in names if 'val/valid_real' in n and n.endswith('.jpg')])
            val_reject = len([n for n in names if 'val/rejected' in n and n.endswith('.jpg')])
            datasheets = len([n for n in names if n.endswith('_datasheet.json')])

            print("\n[Statistik Dataset Terbaru]")
            print(f"   Train Valid Real : {train_valid} frame")
            print(f"   Train Rejected   : {train_reject} frame")
            print(f"   Val Valid Real   : {val_valid} frame")
            print(f"   Val Rejected     : {val_reject} frame")
            print(f"   Total Datasheet  : {datasheets} berkas datasheet JSON")
            print(f"   Total Berkas ZIP : {len(names)} berkas\n")

        return True

    finally:
        if os.path.exists(temp_dir):
            shutil.rmtree(temp_dir, ignore_errors=True)
        if os.path.exists(backup_zip):
            os.remove(backup_zip)

if __name__ == "__main__":
    success = run_merge()
    if not success:
        sys.exit(1)
