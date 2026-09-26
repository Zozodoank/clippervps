#!/usr/bin/env python3
"""
Model Downloader for Local AI Frame Gatekeeper (ClipperVPS).
Downloads verified ultra-lightweight ONNX & TFLite models (~15MB total):
1. Google MediaPipe BlazeFace (~220 KB)
2. OpenCV YuNet Face Detection (~227 KB)
3. DBNet Text Detection PP-OCRv4 (~4.7 MB)
4. MobileNetV3 Small (~10.2 MB)
"""

import os
import sys
import urllib.request
import urllib.error

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(CURRENT_DIR, "models")
os.makedirs(MODELS_DIR, exist_ok=True)

MODELS = [
    {
        "name": "Google MediaPipe BlazeFace",
        "filename": "blaze_face_short_range.tflite",
        "min_size": 200_000,
        "urls": [
            "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite"
        ]
    },
    {
        "name": "OpenCV YuNet Face Detection",
        "filename": "face_detection_yunet_2023mar.onnx",
        "min_size": 200_000,
        "urls": [
            "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
        ]
    },
    {
        "name": "DBNet Text Detection (PP-OCRv4)",
        "filename": "ch_PP-OCRv4_det.onnx",
        "min_size": 4_000_000,
        "urls": [
            "https://huggingface.co/OleehyO/paddleocrv4.onnx/resolve/main/ch_PP-OCRv4_det.onnx"
        ]
    },
    {
        "name": "MobileNetV3 Small (Scene Classifier)",
        "filename": "mobilenetv3_small.onnx",
        "min_size": 9_000_000,
        "urls": [
            "https://huggingface.co/onnx-community/mobilenetv3_small_100.lamb_in1k/resolve/main/onnx/model.onnx"
        ]
    }
]

def download_file(url, dest_path):
    req = urllib.request.Request(
        url,
        headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    )
    with urllib.request.urlopen(req, timeout=45) as response, open(dest_path, "wb") as out_file:
        chunk_size = 128 * 1024
        while True:
            chunk = response.read(chunk_size)
            if not chunk:
                break
            out_file.write(chunk)

def check_and_download_models():
    print(f"📦 [Gatekeeper Downloader] Memeriksa model ONNX di: {MODELS_DIR}")
    all_ok = True

    for item in MODELS:
        filepath = os.path.join(MODELS_DIR, item["filename"])
        if os.path.exists(filepath) and os.path.getsize(filepath) >= item["min_size"]:
            print(f"  ✅ {item['name']} ({os.path.basename(filepath)}) sudah tersedia ({os.path.getsize(filepath) // 1024} KB).")
            continue

        print(f"  ⬇️ Mengunduh {item['name']}...")
        downloaded = False
        for url in item["urls"]:
            try:
                print(f"     URL: {url[:70]}...")
                download_file(url, filepath)
                if os.path.exists(filepath) and os.path.getsize(filepath) >= item["min_size"]:
                    print(f"     ✅ Berhasil diunduh: {item['filename']} ({os.path.getsize(filepath) // 1024} KB)")
                    downloaded = True
                    break
                else:
                    if os.path.exists(filepath):
                        os.remove(filepath)
            except Exception as err:
                print(f"     ⚠️ Gagal: {err}, mencoba opsi lain...")
                if os.path.exists(filepath):
                    try:
                        os.remove(filepath)
                    except Exception:
                        pass

        if not downloaded:
            print(f"  ❌ Gagal mengunduh {item['name']}. Gatekeeper akan menggunakan mode hybrid/fallback.")
            all_ok = False

    if all_ok:
        print("🎉 [Gatekeeper Downloader] Seluruh model AI lokal siap digunakan!")
    else:
        print("ℹ️ [Gatekeeper Downloader] Mode hybrid fallback aktif untuk model yang belum terunduh.")

if __name__ == "__main__":
    check_and_download_models()
