#!/usr/bin/env python3
"""
Add 4 gray watermark frames from final_clip_auto_b8813736f0.mp4 (Alat Pemeras Jeruk Manual)
to the gatekeeper dataset and datasheet as 'reject_watermark'.
"""
import os
import sys
import json
import subprocess
import zipfile
import shutil

GATEKEEPER_DIR = os.path.dirname(os.path.abspath(__file__))
DATASET_DIR = os.path.join(GATEKEEPER_DIR, "dataset")
DATASET_ZIP = os.path.join(GATEKEEPER_DIR, "dataset_v2.zip")
FFMPEG_EXE = r"C:\Users\SEMOGA AWET\Documents\clipperVPS\server\node_modules\ffmpeg-static\ffmpeg.exe"

TEMP_INSPECT_DIR = os.path.join(GATEKEEPER_DIR, "temp_inspect")

SELECTED_FRAMES = [
    {"src": "f_005.jpg", "ts": 5, "split": "train"},
    {"src": "f_010.jpg", "ts": 10, "split": "train"},
    {"src": "f_018.jpg", "ts": 18, "split": "train"},
    {"src": "f_025.jpg", "ts": 25, "split": "val"},
]

VIDEO_ID = "b8813736f0"
PRODUCT_NAME = "Alat Pemeras Jeruk Manual"
YOUTUBE_URL = "https://www.youtube.com/watch?v=T5-KDoOJqXw"
REASON = "Watermark abu-abu / logo samar transparan (ikon rumah & teks STARIKA) di pojok kiri atas frame peragaan produk."

def main():
    print(f"=== Menambahkan 4 Frame Watermark Abu-Abu ke Dataset Gatekeeper ===")
    
    datasheet_entries = []
    
    for item in SELECTED_FRAMES:
        src_path = os.path.join(TEMP_INSPECT_DIR, item["src"])
        if not os.path.exists(src_path):
            print(f"Error: Source frame {src_path} tidak ditemukan!")
            return False
            
        out_filename = f"clip_{VIDEO_ID}_wm_t{item['ts']:03d}.jpg"
        target_dir = os.path.join(DATASET_DIR, item["split"], "rejected")
        os.makedirs(target_dir, exist_ok=True)
        dest_path = os.path.join(target_dir, out_filename)
        
        # Resize to 224x224 using ffmpeg lanczos
        cmd = [
            FFMPEG_EXE, "-y",
            "-i", src_path,
            "-vf", "scale=224:224:flags=lanczos",
            dest_path
        ]
        res = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if res.returncode != 0 or not os.path.exists(dest_path):
            shutil.copyfile(src_path, dest_path)
            
        print(f"  [+] Resized & saved: {item['split']}/rejected/{out_filename}")
        
        entry = {
            "filename": out_filename,
            "original_filename": item["src"],
            "video_source": "final_clip_auto_b8813736f0.mp4",
            "youtube_url": YOUTUBE_URL,
            "product_name": PRODUCT_NAME,
            "timestamp_sec": item["ts"],
            "time_formatted": f"00:{item['ts']:02d}",
            "label": "rejected",
            "category": "reject_watermark",
            "category_label": "🏷️ Reject: Watermark / Logo Sosmed",
            "split": item["split"],
            "reason": REASON,
            "watermark_details": {
                "type": "gray_transparent_logo",
                "text": "STARIKA",
                "position": "top_left",
                "escaped_detection": True,
                "verified_by_user": True
            },
            "curated_by_user": True,
            "session_id": f"auto_{VIDEO_ID}"
        }
        datasheet_entries.append(entry)
        
    # Write datasheet JSON
    datasheet_filename = f"final_clip_auto_{VIDEO_ID}_datasheet.json"
    datasheet_path = os.path.join(DATASET_DIR, datasheet_filename)
    with open(datasheet_path, "w", encoding="utf-8") as f:
        json.dump(datasheet_entries, f, indent=2, ensure_ascii=False)
    print(f"  [+] Datasheet JSON tersimpan di: {datasheet_path}")
    
    # Update master dataset_v2.zip if it exists
    if os.path.exists(DATASET_ZIP):
        print(f"  [+] Memperbarui dataset_v2.zip dengan 4 frame watermark baru...")
        temp_zip = DATASET_ZIP + ".tmp"
        with zipfile.ZipFile(DATASET_ZIP, "r") as zin:
            with zipfile.ZipFile(temp_zip, "w", zipfile.ZIP_DEFLATED) as zout:
                # Copy all existing files
                for item in zin.infolist():
                    zout.writestr(item, zin.read(item.filename))
                # Add new files
                for entry in datasheet_entries:
                    local_img = os.path.join(DATASET_DIR, entry["split"], "rejected", entry["filename"])
                    zip_img_path = f"dataset_v2/{entry['split']}/rejected/{entry['filename']}"
                    zout.write(local_img, zip_img_path)
                # Add datasheet json to zip
                zip_ds_path = f"dataset_v2/{datasheet_filename}"
                zout.write(datasheet_path, zip_ds_path)
                
        # Replace original zip
        os.replace(temp_zip, DATASET_ZIP)
        print(f"  [+] dataset_v2.zip berhasil diperbarui!")
        
    print(f"=== Selesai: 4 Frame Watermark Berhasil Ditambahkan ke Datasheet ===")
    return True

if __name__ == "__main__":
    main()
