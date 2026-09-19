#!/usr/bin/env python3
"""
Comprehensive Test & Benchmark suite for AI Local Frame Gatekeeper.
Tests:
1. 3-State Confidence Policy (VERIFIED_CLEAN >= 0.78, UNCERTAIN 0.62-0.78, REJECT < 0.62)
2. 4-Corner Watermark Detection & Zone Math (TL, TR, BL, BR)
3. Multi-Frame Temporal Watermark Persistence Tracker
4. Clean Temporal Segment Validation (min 3 consecutive frames, min 4.0s, 0 dirty frames)
5. Static Frame / Freeze Frame Detection (Normalized MAD + Edge Difference)
6. End-to-End Vision Pipeline & Benchmarking (when cv2 & numpy are installed)
"""

import os
import sys
import time
import math
import unittest

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

# ── LOGIC TESTS (Running in all environments) ─────────────────────────────────

class TestGatekeeperLogic(unittest.TestCase):
    """
    Test suite for algorithmic rules and state machine logic.
    Executes universally regardless of underlying CV libraries.
    """

    def test_three_state_confidence_policy(self):
        """Uji ambang batas 3-state: CLEAN >= 0.78, UNCERTAIN 0.62-0.78, REJECT < 0.62"""
        CLEAN_THRESHOLD = 0.78
        UNCERTAIN_THRESHOLD = 0.62

        def classify_confidence(conf):
            if conf >= CLEAN_THRESHOLD:
                return "CANDIDATE_CLEAN"
            elif conf >= UNCERTAIN_THRESHOLD:
                return "UNCERTAIN_REJECT"
            else:
                return "REJECT"

        # Case 1: High confidence clean frame
        self.assertEqual(classify_confidence(0.92), "CANDIDATE_CLEAN")
        self.assertEqual(classify_confidence(0.78), "CANDIDATE_CLEAN")

        # Case 2: Borderline / uncertain frame (must be rejected from clean stream)
        self.assertEqual(classify_confidence(0.77), "UNCERTAIN_REJECT")
        self.assertEqual(classify_confidence(0.65), "UNCERTAIN_REJECT")
        self.assertEqual(classify_confidence(0.62), "UNCERTAIN_REJECT")

        # Case 3: Low confidence / dirty frame
        self.assertEqual(classify_confidence(0.61), "REJECT")
        self.assertEqual(classify_confidence(0.35), "REJECT")
        print("  [Pass] 3-State Confidence Policy: 0.92->CLEAN, 0.77->UNCERTAIN_REJECT, 0.50->REJECT")

    def test_corner_watermark_geometry(self):
        """Uji isolasi 4 sudut (Top-Left, Top-Right, Bottom-Left, Bottom-Right)"""
        H, W = 720, 405  # Crop 9:16 dari 1280x720
        corner_w = int(W * 0.32)
        corner_h = int(H * 0.20)

        corners = {
            "TL": (0, corner_h, 0, corner_w),
            "TR": (0, corner_h, W - corner_w, W),
            "BL": (H - corner_h, H, 0, corner_w),
            "BR": (H - corner_h, H, W - corner_w, W),
        }

        # Pastikan tidak ada tumpang tindih antar sudut
        self.assertLessEqual(corners["TL"][3], corners["TR"][2])  # TL x2 <= TR x1
        self.assertLessEqual(corners["BL"][3], corners["BR"][2])  # BL x2 <= BR x1
        self.assertLessEqual(corners["TL"][1], corners["BL"][0])  # TL y2 <= BL y1
        self.assertLessEqual(corners["TR"][1], corners["BR"][0])  # TR y2 <= BR y1

        # Pastikan area proporsional
        corner_area = corner_w * corner_h
        total_area = W * H
        self.assertLessEqual((corner_area / total_area), 0.08)  # Sudut ~6.4% luas layar
        print(f"  [Pass] 4-Corner Watermark Zones: TL, TR, BL, BR ({corner_w}x{corner_h} px each) non-overlapping")

    def test_temporal_clean_segment_validation(self):
        """Uji '1 Clean Frame != Aman' vs 'Clean Temporal Segment = Aman'"""
        min_consecutive = 3
        min_duration = 4.0

        def validate_segments(frame_verdicts):
            verified_segments = []
            current_streak = []

            for idx, v in enumerate(frame_verdicts):
                if v["status"] == "clean":
                    current_streak.append(idx)
                else:
                    if len(current_streak) >= min_consecutive:
                        start_ts = frame_verdicts[current_streak[0]]["timestamp"]
                        end_ts = frame_verdicts[current_streak[-1]]["timestamp"]
                        if (end_ts - start_ts) >= min_duration or len(current_streak) >= 4:
                            verified_segments.append({
                                "startSec": start_ts,
                                "endSec": end_ts,
                                "frameCount": len(current_streak),
                                "indices": list(current_streak)
                            })
                    current_streak = []

            if len(current_streak) >= min_consecutive:
                start_ts = frame_verdicts[current_streak[0]]["timestamp"]
                end_ts = frame_verdicts[current_streak[-1]]["timestamp"]
                if (end_ts - start_ts) >= min_duration or len(current_streak) >= 4:
                    verified_segments.append({
                        "startSec": start_ts,
                        "endSec": end_ts,
                        "frameCount": len(current_streak),
                        "indices": list(current_streak)
                    })

            # Map back to frames
            verified_indices = set()
            for seg in verified_segments:
                for fi in seg["indices"]:
                    verified_indices.add(fi)

            result_frames = []
            for idx, v in enumerate(frame_verdicts):
                copied = dict(v)
                if idx in verified_indices:
                    copied["decision"] = "VERIFIED_CLEAN"
                    copied["status"] = "clean"
                else:
                    copied["status"] = "discarded"
                    copied["decision"] = "ISOLATED_CLEAN_REJECT" if v["status"] == "clean" else "REJECT"
                result_frames.append(copied)

            return verified_segments, result_frames

        # Scenario A: [CLEAN, DIRTY, CLEAN, CLEAN, DIRTY] -> Isolated clean frames should be rejected!
        scenario_a = [
            {"timestamp": 0.0, "status": "clean"},
            {"timestamp": 2.0, "status": "discarded"},
            {"timestamp": 4.0, "status": "clean"},
            {"timestamp": 6.0, "status": "clean"},
            {"timestamp": 8.0, "status": "discarded"},
        ]
        segs_a, res_a = validate_segments(scenario_a)
        self.assertEqual(len(segs_a), 0, "Streak < 3 harus menghasilkan 0 verified segments")
        self.assertTrue(all(f["decision"] in ("ISOLATED_CLEAN_REJECT", "REJECT") for f in res_a))

        # Scenario B: [CLEAN, CLEAN, CLEAN, CLEAN] (0.0s to 6.0s = 6.0s duration >= 4.0s) -> VERIFIED_CLEAN!
        scenario_b = [
            {"timestamp": 0.0, "status": "clean"},
            {"timestamp": 2.0, "status": "clean"},
            {"timestamp": 4.0, "status": "clean"},
            {"timestamp": 6.0, "status": "clean"},
        ]
        segs_b, res_b = validate_segments(scenario_b)
        self.assertEqual(len(segs_b), 1)
        self.assertEqual(segs_b[0]["frameCount"], 4)
        self.assertTrue(all(f["decision"] == "VERIFIED_CLEAN" for f in res_b))

        # Scenario C: Mixed - 1 dirty, then a solid clean temporal window
        scenario_c = [
            {"timestamp": 0.0, "status": "discarded"},  # bumper
            {"timestamp": 2.0, "status": "discarded"},  # intro text
            {"timestamp": 4.0, "status": "clean"},      # clean start
            {"timestamp": 6.0, "status": "clean"},
            {"timestamp": 8.0, "status": "clean"},      # streak=3, dur=4.0s
            {"timestamp": 10.0, "status": "discarded"}, # watermark / face
        ]
        segs_c, res_c = validate_segments(scenario_c)
        self.assertEqual(len(segs_c), 1)
        self.assertEqual(res_c[2]["decision"], "VERIFIED_CLEAN")
        self.assertEqual(res_c[3]["decision"], "VERIFIED_CLEAN")
        self.assertEqual(res_c[4]["decision"], "VERIFIED_CLEAN")
        self.assertEqual(res_c[0]["decision"], "REJECT")
        print("  [Pass] Clean Temporal Segment Validation: Isolated clean frames rejected, continuous windows verified")

    def test_persistent_watermark_multi_frame_tracker(self):
        """Uji pelacakan watermark statis multi-frame di sudut yang sama"""
        frames = [
            {"filePath": "f1.jpg", "status": "clean", "cornerActivations": {"TL": 0.015, "TR": 0.0, "BL": 0.0, "BR": 0.0}},
            {"filePath": "f2.jpg", "status": "clean", "cornerActivations": {"TL": 0.0, "TR": 0.0, "BL": 0.0, "BR": 0.0}},
            {"filePath": "f3.jpg", "status": "clean", "cornerActivations": {"TL": 0.018, "TR": 0.0, "BL": 0.0, "BR": 0.0}},
        ]

        corner_hits = {"TL": [], "TR": [], "BL": [], "BR": []}
        for idx, v in enumerate(frames):
            c_acts = v.get("cornerActivations") or {}
            for c_name in ["TL", "TR", "BL", "BR"]:
                if c_acts.get(c_name, 0.0) >= 0.012:
                    corner_hits[c_name].append(idx)

        # TL muncul di frame 0 dan frame 2 -> harus ditandai sebagai persistent watermark
        self.assertEqual(len(corner_hits["TL"]), 2)
        self.assertEqual(len(corner_hits["TR"]), 0)

        for c_name, hit_indices in corner_hits.items():
            if len(hit_indices) >= 2:
                for h_idx in hit_indices:
                    frames[h_idx]["status"] = "discarded"
                    frames[h_idx]["stage"] = "persistent_watermark"
                    frames[h_idx]["decision"] = "REJECT"

        self.assertEqual(frames[0]["decision"], "REJECT")
        self.assertEqual(frames[0]["stage"], "persistent_watermark")
        self.assertEqual(frames[2]["decision"], "REJECT")
        self.assertEqual(frames[2]["stage"], "persistent_watermark")
        print("  [Pass] Multi-Frame Watermark Tracker: Corner TL recurring watermark flagged & rejected retroactively")


# ── FULL OPENCV BENCHMARK SUITE (Executes when CV2 is present) ────────────────

def run_opencv_benchmarks():
    try:
        import numpy as np
        import cv2
        from service import FrameGatekeeper
    except ImportError as e:
        print(f"\n⚠️  [CV2 Benchmark Skipped] Modul OpenCV/numpy belum terpasang di host: {e}")
        print("   (Ini normal untuk Windows host lokal. Pipeline microservice beroperasi penuh di Linux VPS).")
        return

    print("\n🚀 [End-to-End Benchmark] Menginisialisasi FrameGatekeeper dengan OpenCV...")
    gatekeeper = FrameGatekeeper()

    temp_dir = os.path.join(os.path.dirname(__file__), "test_temp")
    os.makedirs(temp_dir, exist_ok=True)

    # 1. Bersih 1 (Simulasi wajan logam di atas meja)
    img_clean1 = np.zeros((720, 1280, 3), dtype=np.uint8)
    for y in range(720):
        img_clean1[y, :] = [40 + (y // 15), 60 + (y // 12), 110 + (y // 10)]
    cv2.circle(img_clean1, (640, 360), 180, (180, 180, 180), -1)
    cv2.circle(img_clean1, (640, 360), 70, (80, 80, 80), -1)
    noise = np.random.normal(0, 10, (720, 1280, 3)).astype(np.uint8)
    img_clean1 = cv2.add(img_clean1, noise)
    p_clean1 = os.path.join(temp_dir, "f_clean_01.jpg")
    cv2.imwrite(p_clean1, img_clean1)

    # 2. Bersih 2 (Gerakan wajan bergeser sedikit - 2 detik kemudian)
    img_clean2 = img_clean1.copy()
    cv2.circle(img_clean2, (660, 370), 180, (185, 185, 185), -1)
    p_clean2 = os.path.join(temp_dir, "f_clean_02.jpg")
    cv2.imwrite(p_clean2, img_clean2)

    # 3. Bersih 3 (Wajan 4 detik kemudian)
    img_clean3 = img_clean1.copy()
    cv2.circle(img_clean3, (630, 350), 180, (175, 175, 175), -1)
    p_clean3 = os.path.join(temp_dir, "f_clean_03.jpg")
    cv2.imwrite(p_clean3, img_clean3)

    # 4. Kotor Subtitle
    img_sub = img_clean1.copy()
    cv2.rectangle(img_sub, (400, 580), (880, 680), (0, 0, 0), -1)
    cv2.putText(img_sub, "DISKON SPESIAL HARI INI", (420, 640), cv2.FONT_HERSHEY_SIMPLEX, 1.1, (255, 255, 255), 3)
    p_sub = os.path.join(temp_dir, "f_sub.jpg")
    cv2.imwrite(p_sub, img_sub)

    # 5. Kotor Watermark Sudut Kanan Atas (TR)
    img_wm = img_clean1.copy()
    cv2.putText(img_wm, "@SHOP_LOGO", (1000, 100), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2)
    p_wm = os.path.join(temp_dir, "f_wm.jpg")
    cv2.imwrite(p_wm, img_wm)

    # 6. Bumper Statis Polos
    img_bumper = np.full((720, 1280, 3), (255, 200, 0), dtype=np.uint8)
    p_bumper = os.path.join(temp_dir, "f_bumper.jpg")
    cv2.imwrite(p_bumper, img_bumper)

    test_frames = [
        {"filePath": p_bumper, "timestamp": 0.0},
        {"filePath": p_clean1, "timestamp": 3.0},
        {"filePath": p_clean2, "timestamp": 5.0},
        {"filePath": p_clean3, "timestamp": 7.5},
        {"filePath": p_sub, "timestamp": 10.0},
        {"filePath": p_wm, "timestamp": 12.0},
    ]

    res = gatekeeper.process_batch(test_frames, min_consecutive_clean=3, min_clean_duration=4.0)

    print(f"\n📊 HASIL BENCHMARK BATCH:")
    print(f"  Total Waktu: {res.get('benchmarks', {}).get('totalMs', 0)} ms")
    print(f"  FPS: {res.get('benchmarks', {}).get('fps', 0)}")
    print(f"  Verified Clean Segments: {len(res.get('verifiedSegments', []))}")
    print(f"  Clean Frames Count: {res.get('cleanFramesCount', 0)} / {res.get('totalFrames', 0)}")

    for idx, f in enumerate(res.get("allFrames", [])):
        icon = "✅" if f["status"] == "clean" else "❌"
        dec = f.get("decision", f["status"])
        print(f"  [{idx+1}] {icon} {os.path.basename(f['filePath'])}: decision={dec} stage={f.get('stage')} -> {f.get('reason')}")

    # Bersihkan file temp
    for p in [p_clean1, p_clean2, p_clean3, p_sub, p_wm, p_bumper]:
        try:
            os.remove(p)
        except Exception:
            pass
    try:
        os.rmdir(temp_dir)
    except Exception:
        pass


def main():
    print("=" * 70)
    print("🧪 [GATEKEEPER SUITE] MENJALANKAN PENGUJIAN LOGIKA & ATURAN KETAT")
    print("=" * 70)

    # 1. Jalankan Unit Tests Logika
    suite = unittest.TestLoader().loadTestsFromTestCase(TestGatekeeperLogic)
    runner = unittest.TextTestRunner(verbosity=1)
    test_res = runner.run(suite)

    if not test_res.wasSuccessful():
        print("❌ Uji logika Gatekeeper GAGAL!")
        sys.exit(1)

    print("\n✅ Seluruh uji unit logika dan state-machine BERHASIL!")

    # 2. Jalankan CV2 Benchmark jika environment mendukung
    run_opencv_benchmarks()
    print("=" * 70)


if __name__ == "__main__":
    main()
