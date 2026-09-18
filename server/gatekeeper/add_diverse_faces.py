#!/usr/bin/env python3
"""
Script to add diverse non-hijab human faces to ClipperVPS Gatekeeper dataset and datasheet.
Creates balanced train/val splits, generates 224x224 scaled images,
updates the datasheet JSON, and re-packs dataset_v2.zip.
"""

import os
import sys
import json
import shutil
import zipfile
import subprocess

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATASET_DIR = os.path.join(SCRIPT_DIR, "dataset")
MASTER_ZIP = os.path.join(SCRIPT_DIR, "dataset_v2.zip")
FFMPEG_EXE = r"C:\Users\SEMOGA AWET\Documents\clipperVPS\server\node_modules\ffmpeg-static\ffmpeg.exe"

SOURCE_IMAGES = [
    {
        "src": r"C:\Users\SEMOGA AWET\.gemini\antigravity-ide\brain\af5f137e-aaf1-482a-b3a9-5a8420ac5e72\.user_uploaded\media_1789769699895.jpg",
        "id": "face_woman_sunglasses",
        "desc": "Wanita tanpa hijab, rambut terbuka, kacamata hitam di kepala, selfie outdoor",
        "split": "train"
    },
    {
        "src": r"C:\Users\SEMOGA AWET\.gemini\antigravity-ide\brain\af5f137e-aaf1-482a-b3a9-5a8420ac5e72\.user_uploaded\media_1789769699901.jpg",
        "id": "face_two_men_outdoor",
        "desc": "Dua pria bertopi & kasual di area outdoor berpasir",
        "split": "train"
    },
    {
        "src": r"C:\Users\SEMOGA AWET\.gemini\antigravity-ide\brain\af5f137e-aaf1-482a-b3a9-5a8420ac5e72\.user_uploaded\media_1789769699952.jpg",
        "id": "face_senior_man_beard_phone",
        "desc": "Pria paruh baya berambut uban dan jenggot putih berbicara di telepon",
        "split": "val"
    },
    {
        "src": r"C:\Users\SEMOGA AWET\.gemini\antigravity-ide\brain\af5f137e-aaf1-482a-b3a9-5a8420ac5e72\.user_uploaded\media_1789769699958.jpg",
        "id": "face_young_man_glasses_mic",
        "desc": "Pria muda berkacamata bulat dengan mikrofon podcast, talking-head creator",
        "split": "train"
    },
    {
        "src": r"C:\Users\SEMOGA AWET\.gemini\antigravity-ide\brain\46290641-235c-47be-8bb0-e3e6f27d0f9d\.user_uploaded\media_1789767413172.jpg",
        "id": "face_girl_pink_dress",
        "desc": "Gadis muda berambut panjang terurai memakai busana pink tanpa hijab",
        "split": "val"
    }
]

def process_and_add():
    print("🚀 [Add Diverse Faces] Memproses gambar wajah baru...")
    
    # Check source files
    valid_sources = []
    for item in SOURCE_IMAGES:
        if os.path.exists(item["src"]):
            valid_sources.append(item)
            print(f"  ✅ Ditemukan: {item['id']} ({os.path.basename(item['src'])})")
        else:
            print(f"  ⚠️ Tidak ditemukan: {item['src']}")

    if not valid_sources:
        print("❌ Tidak ada file gambar yang valid!")
        return False

    datasheet_records = []
    generated_files = [] # list of (local_path, rel_in_zip)

    for idx, item in enumerate(valid_sources):
        src_path = item["src"]
        split = item["split"]
        base_id = item["id"]
        
        # 1. Full 224x224 scaled frame
        fname_full = f"curated_face_div_{idx+1:02d}_{base_id}_full.jpg"
        dest_local_full = os.path.join(DATASET_DIR, split, "rejected", fname_full)
        os.makedirs(os.path.dirname(dest_local_full), exist_ok=True)

        cmd1 = [
            FFMPEG_EXE, "-y",
            "-i", src_path,
            "-vf", "scale=224:224:flags=lanczos",
            "-q:v", "2",
            dest_local_full
        ]
        res1 = subprocess.run(cmd1, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if res1.returncode == 0 and os.path.exists(dest_local_full):
            print(f"  📸 Dibuat: {fname_full} ({split}/rejected)")
            rel_zip_full = f"dataset_v2/{split}/rejected/{fname_full}"
            generated_files.append((dest_local_full, rel_zip_full))
            datasheet_records.append({
                "filename": fname_full,
                "original_filename": os.path.basename(src_path),
                "video_source": f"user_curated_faces_{base_id}",
                "video_index": idx + 1,
                "timestamp_sec": 1,
                "time_formatted": "00:01",
                "label": "rejected",
                "category": "reject_face",
                "category_label": "👤 Reject: Wajah / Manusia / Vlogger",
                "split": split,
                "reason": f"Menampilkan wajah manusia tanpa hijab ({item['desc']}).",
                "curated_by_user": True,
                "session_id": "curated_faces_diverse_v3"
            })

        # 2. Centered/Close-up Crop (9:16 vertical crop then 224x224)
        fname_crop = f"curated_face_div_{idx+1:02d}_{base_id}_crop.jpg"
        dest_local_crop = os.path.join(DATASET_DIR, split, "rejected", fname_crop)
        cmd2 = [
            FFMPEG_EXE, "-y",
            "-i", src_path,
            "-vf", "crop='min(iw,ih*9/16)':'min(ih,iw*16/9)':(iw-ow)/2:(ih-oh)/3,scale=224:224:flags=lanczos",
            "-q:v", "2",
            dest_local_crop
        ]
        res2 = subprocess.run(cmd2, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if res2.returncode == 0 and os.path.exists(dest_local_crop):
            print(f"  📸 Dibuat: {fname_crop} ({split}/rejected)")
            rel_zip_crop = f"dataset_v2/{split}/rejected/{fname_crop}"
            generated_files.append((dest_local_crop, rel_zip_crop))
            datasheet_records.append({
                "filename": fname_crop,
                "original_filename": os.path.basename(src_path),
                "video_source": f"user_curated_faces_{base_id}",
                "video_index": idx + 1,
                "timestamp_sec": 2,
                "time_formatted": "00:02",
                "label": "rejected",
                "category": "reject_face",
                "category_label": "👤 Reject: Wajah / Manusia / Vlogger",
                "split": split,
                "reason": f"Menampilkan crop wajah presenter/vlogger tanpa hijab ({item['desc']}).",
                "curated_by_user": True,
                "session_id": "curated_faces_diverse_v3"
            })

    # Save dedicated datasheet JSON: curated_local_diverse_faces_datasheet.json
    ds_filename = "curated_local_diverse_faces_datasheet.json"
    ds_local_path = os.path.join(DATASET_DIR, ds_filename)
    with open(ds_local_path, "w", encoding="utf-8") as f:
        json.dump(datasheet_records, f, indent=2, ensure_ascii=False)
    print(f"📄 Datasheet JSON berhasil disimpan: {ds_local_path} ({len(datasheet_records)} entri)")

    # Update dataset_v2.zip
    if os.path.exists(MASTER_ZIP):
        print("📦 Mengintegrasikan frame baru & datasheet ke dataset_v2.zip...")
        backup_zip = MASTER_ZIP + ".bak"
        shutil.copyfile(MASTER_ZIP, backup_zip)
        
        # Open existing zip and append new entries
        with zipfile.ZipFile(MASTER_ZIP, "a", zipfile.ZIP_DEFLATED) as zf:
            # Write datasheet
            zf.write(ds_local_path, f"dataset_v2/{ds_filename}")
            # Write images
            for loc_path, zip_rel in generated_files:
                zf.write(loc_path, zip_rel)
        print("✅ dataset_v2.zip berhasil diperbarui dengan sampel wajah manusia beragam!")

    return True

if __name__ == "__main__":
    process_and_add()
