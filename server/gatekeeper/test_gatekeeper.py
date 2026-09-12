#!/usr/bin/env python3
"""
Test & Benchmark suite for AI Local Frame Gatekeeper.
Tests MediaPipe face detection, DBNet text detection, and MobileNetV3 scene classification.
"""

import os
import sys
import time
import numpy as np
import cv2

from service import FrameGatekeeper

def run_tests():
    print("🧪 [Test Suite] Menginisialisasi AI Local Frame Gatekeeper...")
    gatekeeper = FrameGatekeeper()

    temp_dir = os.path.join(os.path.dirname(__file__), "test_temp")
    os.makedirs(temp_dir, exist_ok=True)

    # 1. Buat Test Image 1: Frame Alami Bersih (Simulasi close-up alat dapur di atas meja)
    clean_img = np.zeros((720, 1280, 3), dtype=np.uint8)
    # Background gradasi kayu alami
    for y in range(720):
        clean_img[y, :] = [40 + (y // 15), 60 + (y // 12), 110 + (y // 10)]
    # Tambah objek produk (lingkaran / elips logam)
    cv2.circle(clean_img, (640, 360), 180, (180, 180, 180), -1)
    cv2.circle(clean_img, (640, 360), 160, (220, 220, 220), -1)
    cv2.circle(clean_img, (640, 360), 70, (80, 80, 80), -1)
    # Tambah noise tekstur agar natural
    noise = np.random.normal(0, 12, (720, 1280, 3)).astype(np.uint8)
    clean_img = cv2.add(clean_img, noise)
    clean_path = os.path.join(temp_dir, "frame_clean.jpg")
    cv2.imwrite(clean_path, clean_img)

    # 2. Buat Test Image 2: Frame Kotor dengan Subtitle Tebal di Bawah
    sub_img = clean_img.copy()
    cv2.rectangle(sub_img, (400, 580), (880, 680), (0, 0, 0), -1)
    cv2.putText(sub_img, "SUBTITLE TEBAL DISINI", (420, 640), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 255, 255), 3)
    sub_path = os.path.join(temp_dir, "frame_subtitle.jpg")
    cv2.imwrite(sub_path, sub_img)

    # 3. Buat Test Image 3: Frame Slide Bumper Datar / Polos (Intro 2D)
    flat_img = np.full((720, 1280, 3), (255, 200, 0), dtype=np.uint8)
    flat_path = os.path.join(temp_dir, "frame_bumper.jpg")
    cv2.imwrite(flat_path, flat_img)

    print("\n🔍 Menjalankan Pengujian 3-Tahap Gatekeeper...")
    frames_to_test = [
        {"filePath": clean_path, "timestamp": 3.0},
        {"filePath": sub_path, "timestamp": 6.0},
        {"filePath": flat_path, "timestamp": 0.0}
    ]

    res = gatekeeper.process_batch(frames_to_test)

    print(f"\n📊 HASIL BENCHMARK:")
    print(f"  Total Waktu: {res['benchmarks']['totalMs']} ms")
    print(f"  Rata-rata per frame: {res['benchmarks']['avgMsPerFrame']} ms ({res['benchmarks']['fps']} FPS)")
    print(f"  Clean Frames: {res['cleanFramesCount']} / {res['totalFrames']}")

    for idx, f in enumerate(res["allFrames"]):
        status_icon = "✅" if f["status"] == "clean" else "❌"
        print(f"  [{idx + 1}] {status_icon} Frame {os.path.basename(f['filePath'])}: {f['status']} ({f.get('stage', 'none')}) - {f['reason']}")

    # Clean up test temp
    try:
        os.remove(clean_path)
        os.remove(sub_path)
        os.remove(flat_path)
        os.rmdir(temp_dir)
    except Exception:
        pass

    print("\n🎉 Pengujian Gatekeeper selesai!")

if __name__ == "__main__":
    run_tests()
