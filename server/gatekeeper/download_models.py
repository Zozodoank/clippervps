#!/usr/bin/env python3
"""
Model Downloader for Local AI Frame Gatekeeper (ClipperVPS).
Downloads verified ultra-lightweight ONNX & TFLite models (~15MB total):
1. Google MediaPipe BlazeFace (~220 KB)
2. OpenCV YuNet Face Detection (~227 KB)
2b. SCRFD 2.5G bkps (pengganti YuNet via GK_FACE_BACKEND=scrfd, ~3.3 MB)
3. DBNet Text Detection PP-OCRv4 (~4.7 MB)
4. MobileNetV3 Small (~10.2 MB)
"""

import os
import sys
import urllib.request
import urllib.error
import argparse

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(CURRENT_DIR, "models")
os.makedirs(MODELS_DIR, exist_ok=True)

MODELS = [
    {
        "name": "Google MediaPipe BlazeFace",
        "filename": "blaze_face_short_range.tflite",
        "min_size": 200_000,
        "legacy": True,
        "urls": [
            "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite"
        ]
    },
    {
        "name": "OpenCV YuNet Face Detection",
        "filename": "face_detection_yunet_2023mar.onnx",
        "min_size": 200_000,
        "legacy": True,
        "urls": [
            "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"
        ]
    },
    {
        "name": "SCRFD 2.5G Face Detection (bkps, pengganti YuNet)",
        "filename": "scrfd_2.5g_bnkps.onnx",
        "min_size": 3_000_000,
        "legacy": True,
        "urls": [
            "https://huggingface.co/RuteNL/SCRFD-face-detection-ONNX/resolve/main/2.5g_bnkps.onnx"
        ]
    },
    {
        "name": "DBNet Text Detection (PP-OCRv4)",
        "filename": "ch_PP-OCRv4_det.onnx",
        "min_size": 4_000_000,
        "legacy": True,
        "urls": [
            "https://huggingface.co/OleehyO/paddleocrv4.onnx/resolve/main/ch_PP-OCRv4_det.onnx"
        ]
    },
    {
        "name": "MobileNetV3 Small (Scene Classifier)",
        "filename": "mobilenetv3_small.onnx",
        "min_size": 9_000_000,
        "legacy": True,
        "urls": [
            "https://huggingface.co/onnx-community/mobilenetv3_small_100.lamb_in1k/resolve/main/onnx/model.onnx"
        ]
    }, {
        # Model hasil training lokal; tidak memiliki URL publik bawaan. Operator yang
        # meng-host artifact dapat menyediakan GK_ZONETEXT_MODEL_URL atau --zone-model-url.
        "name": "MobileNetV3 Zone Text Student (opsional, hasil train_zone_text.py)",
        "filename": "zonetext_v1.onnx",
        "min_size": 500_000,
        "optional": True,
        "urls": [os.environ.get("GK_ZONETEXT_MODEL_URL", "").strip()] if os.environ.get("GK_ZONETEXT_MODEL_URL", "").strip() else [],
    }
]

# ── VLM LOKAL (SmolVLM2-500M GGUF) ─────────────────────────────────────────
# HANYA diunduh bila dipanggil eksplisit (unduh_vlm_models()). Distribusi utama
# ke Termux adalah MENYALIN file hasil unduhan PC via scp (lihat sync-to-termux.ps1),
# BUKAN download di perangkat; karena itu unduh di sini opsional. URL & nama file
# WAJIB diverifikasi terhadap repo HF sebelum dipakai (bisa berubah).
VLM_MODELS = [
    {
        "name": "SmolVLM2-500M GGUF (Q4_K_M, auto-quant mradermacher)",
        "filename": "smolvlm2-500m.Q4_K_M.gguf",
        "min_size": 250_000_000,
        "urls": [
            "https://huggingface.co/mradermacher/SmolVLM2-500M-Video-Instruct-GGUF/resolve/main/SmolVLM2-500M-Video-Instruct.Q4_K_M.gguf"
        ]
    },
    {
        # mmproj HANYA tersedia di repo resmi ggml-org (Q8_0 & f16). Q8_0 dipilih
        # agar hemat RAM/kuota Termux; encoder vision kurang sensitif kuantisasi.
        "name": "SmolVLM2-500M mmproj (vision projector, Q8_0 resmi ggml-org)",
        "filename": "smolvlm2-500m-mmproj.gguf",
        "min_size": 90_000_000,
        "urls": [
            "https://huggingface.co/ggml-org/SmolVLM2-500M-Video-Instruct-GGUF/resolve/main/mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf"
        ]
    },
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

def _download_items(items):
    """Unduh daftar model yang belum ada (dicek existence + min_size). Return True bila semua siap."""
    all_ok = True
    for item in items:
        filepath = os.path.join(MODELS_DIR, item["filename"])
        if os.path.exists(filepath) and os.path.getsize(filepath) >= item["min_size"]:
            print(f"  ✅ {item['name']} ({os.path.basename(filepath)}) sudah tersedia ({os.path.getsize(filepath) // 1024} KB).")
            continue

        if item.get("optional") and not item.get("urls"):
            print(f"  ℹ️ {item['filename']} belum tersedia; distilasi dengan make_zone_text_dataset.py lalu train_zone_text.py (opsional).")
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
            print(f"  ❌ Gagal mengunduh {item['name']}.")
            all_ok = False
    return all_ok

def check_and_download_models():
    print(f"📦 [Gatekeeper Downloader] Memeriksa model ONNX di: {MODELS_DIR}")
    all_ok = _download_items(MODELS)
    if all_ok:
        print("🎉 [Gatekeeper Downloader] Seluruh model AI lokal siap digunakan!")
    else:
        print("ℹ️ [Gatekeeper Downloader] Mode hybrid fallback aktif untuk model yang belum terunduh.")

def unduh_vlm_models():
    """Opsional: unduh GGUF SmolVLM2 ke MODELS_DIR. Dipanggil hanya via --download-vlm.
    Pada Termux cukup salin file hasil unduhan PC (sync-to-termux.ps1), jadi jalur ini
    terutama untuk menyiapkan PC sebagai sumber master."""
    print(f"🧠 [Gatekeeper VLM Downloader] Memeriksa GGUF VLM di: {MODELS_DIR}")
    all_ok = _download_items(VLM_MODELS)
    if all_ok:
        print("🎉 [Gatekeeper VLM Downloader] GGUF SmolVLM2 siap. Set GK_VLM_MODEL/GK_VLM_MMPROJ di server/.env.")
    else:
        print("ℹ️ [Gatekeeper VLM Downloader] Sebagian GGUF gagal - verifikasi URL/nama file pada repo HF.")
    return all_ok

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Gatekeeper model downloader")
    parser.add_argument("--download-vlm", action="store_true", help="Unduh GGUF SmolVLM2 (opsional)")
    parser.add_argument("--zone-model-url", default="", help="URL artifact zonetext_v1.onnx hasil training (opsional)")
    args = parser.parse_args()
    if args.zone_model_url:
        ok = _download_items([{
            "name": "MobileNetV3 Zone Text Student",
            "filename": "zonetext_v1.onnx",
            "min_size": 500_000,
            "urls": [args.zone_model_url],
        }])
        sys.exit(0 if ok else 1)
    elif args.download_vlm:
        unduh_vlm_models()
    else:
        check_and_download_models()
