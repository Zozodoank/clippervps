#!/usr/bin/env python3
"""
Unit test FASE 2 — Face Policy 'presenter_only' pada Gatekeeper.
Murni logika (tanpa model vision): classify_face, _iou, apply_temporal_presenter_track.
Jalankan:  python server/gatekeeper/test_face_policy.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from service import (
    FaceGatekeeper,
    apply_temporal_presenter_track,
    PRESENTER_MIN_AREA_RATIO,
    PRESENTER_UPPER_HALF_Y,
    PRESENTER_MIN_HITS,
)

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [OK] {name}")
    else:
        FAIL += 1
        print(f"  [FAIL] {name} {detail}")


# Frame 9:16 tipik: 1080 x 1920 (h, w)
FRAME = (1920, 1080)


def test_classify_face():
    print("\n[1] classify_face - HANYA presenter (a: besar-di-atas / b: temporal) yang diblokir")
    # a. presenter: wajah besar (500x600 = 14.5% frame) dominan di paruh atas
    check("wajah besar di atas -> presenter",
          FaceGatekeeper.classify_face(FRAME, [290, 150, 500, 600]) == "presenter")
    # c. content: wajah kecil (60x70 = 0.2% frame) pejalan kaki di sample foto
    check("wajah kecil -> content",
          FaceGatekeeper.classify_face(FRAME, [900, 800, 60, 70]) == "content")
    # e. wajah menengah (250x300 = 3.6%) yang BUKAN talking-head atas -> content (wajah tertangkap kamera)
    check("menengah ambigu -> content (wajah sample kamera tidak diblokir)",
          FaceGatekeeper.classify_face(FRAME, [400, 900, 250, 300]) == "content")
    # b. temporal: wajah kecil tapi persisten >= 3 frame -> presenter mengalahkan aturan content
    check("content kecil tapi persisten -> presenter",
          FaceGatekeeper.classify_face(FRAME, [900, 800, 60, 70], temporal_hits=2) == "presenter")
    # wajah besar tapi di paruh bawah (face_cy>=0.55) bukan talking-head -> content
    check("wajah besar di bawah -> content (bukan presenter statis)",
          FaceGatekeeper.classify_face(FRAME, [290, 1200, 500, 600]) == "content")


def test_iou():
    print("\n[2] _iou - Intersection over Union")
    box = [100, 100, 50, 50]
    check("IoU box identik = 1.0", abs(FaceGatekeeper._iou(box, box) - 1.0) < 1e-9)
    check("IoU box berjauhan = 0.0", FaceGatekeeper._iou(box, [500, 500, 50, 50]) == 0.0)
    check("IoU tumpang tindih separuh ~ 0.33",
          0.3 < FaceGatekeeper._iou(box, [125, 100, 50, 50]) < 0.4)


def _v(ts, faces, status="clean"):
    return {
        "filePath": "/tmp/frame_%s.jpg" % ts,
        "timestamp": ts,
        "status": status,
        "stage": "passed",
        "decision": "CANDIDATE_CLEAN",
        "faces": [dict(f) for f in faces],
    }


def test_temporal_track():
    print("\n[3] apply_temporal_presenter_track - kreator statis vs wajah bergerak")
    small = {"box": [900, 800, 60, 70], "score": 0.8, "kind": "content", "region": "crop"}

    # Kasus A: wajah content kecil yang BERGERAK mengikuti scene -> tetap clean + eligible
    moving = [
        _v(0.0, [dict(small, box=[900, 800, 60, 70])]),
        _v(2.5, [dict(small, box=[500, 400, 60, 70])]),
        _v(5.0, [dict(small, box=[120, 950, 60, 70])]),
    ]
    apply_temporal_presenter_track(moving)
    check("wajah bergerak: semua tetap clean", all(v["status"] == "clean" for v in moving))
    check("wajah bergerak: flag cameraResultEligible terpasang",
          all(v.get("cameraResultEligible") for v in moving))

    # Kasus B: ambang ketat min_hits=2 -> wajah DIAM baru dikunci di frame KE-3.
    still = [
        _v(0.0, [dict(small, box=[900, 800, 60, 70])]),
        _v(2.5, [dict(small, box=[905, 802, 60, 70])]),
        _v(5.0, [dict(small, box=[902, 799, 60, 70])]),
    ]
    apply_temporal_presenter_track(still, min_hits=2)
    check("min_hits=2: 2 frame pertama masih clean",
          still[0]["status"] == "clean" and still[1]["status"] == "clean")
    check("min_hits=2: frame ke-3 dibuang sebagai presenter",
          still[2]["status"] == "discarded" and still[2]["stage"] == "face")
    check("min_hits=2: frame ke-3 TIDAK dapat flag eligible",
          not still[2].get("cameraResultEligible"))

    # Kasus B2: DEFAULT fungsi kini = PRODUKSI (min_hits=1) -> wajah DIAM sudah dikunci
    # sejak frame KE-2. Ini menyelaraskan tes dengan nilai yang dipakai process_batch.
    still1 = [
        _v(0.0, [dict(small, box=[900, 800, 60, 70])]),
        _v(2.5, [dict(small, box=[905, 802, 60, 70])]),
        _v(5.0, [dict(small, box=[902, 799, 60, 70])]),
    ]
    apply_temporal_presenter_track(still1)  # tanpa argumen => default = PRESENTER_MIN_HITS
    check("default == PRESENTER_MIN_HITS (selaras produksi)",
          PRESENTER_MIN_HITS == 1)
    check("min_hits=1: frame ke-1 masih clean (belum ada pembanding)",
          still1[0]["status"] == "clean")
    check("min_hits=1: frame ke-2 SUDAH dibuang sebagai presenter (tutup bocor)",
          still1[1]["status"] == "discarded" and still1[1]["stage"] == "face")

    # Kasus C: frame tanpa wajah tidak boleh menerima flag apa pun
    noface = [_v(0.0, []), _v(2.5, [])]
    apply_temporal_presenter_track(noface)
    check("tanpa wajah: status clean, tanpa flag eligible",
          all(v["status"] == "clean" and not v.get("cameraResultEligible") for v in noface))

    # Kasus D: frame yang sudah discarded tahap lain tidak diubah-ubah
    dead = [_v(0.0, [dict(small, box=[900, 800, 60, 70])], status="discarded"),
            _v(2.5, [dict(small, box=[902, 800, 60, 70])], status="discarded"),
            _v(5.0, [dict(small, box=[900, 798, 60, 70])], status="discarded")]
    for v in dead:
        v["stage"] = "text"
    apply_temporal_presenter_track(dead)
    check("frame discarded tahap lain: stage asal dipertahankan",
          all(v["stage"] == "text" for v in dead))


def test_payload_contract():
    """P3.2 Kontrak payload gatekeeper: threshold yang dikirim Node (payload) harus dipakai,
    dan fallback service.py == angka Node (0.06/0.55/1) agar 'satu sumber' tidak drift."""
    print("\n[5] Kontrak payload threshold presenter (P3.1/P3.2)")
    # Fallback modul = nilai produksi yang dikirim Node.
    check("fallback service.py == Node (area 0.06)", abs(PRESENTER_MIN_AREA_RATIO - 0.06) < 1e-9)
    check("fallback service.py == Node (upper 0.55)", abs(PRESENTER_UPPER_HALF_Y - 0.55) < 1e-9)
    check("fallback service.py == Node (min_hits 1)", PRESENTER_MIN_HITS == 1)

    # Area ambang dapat digeser payload: wajah 14.5% yang default=presenter jadi content bila
    # Node mengirim min_area_ratio=0.20.
    big_upper = [290, 150, 500, 600]
    check("default: wajah besar atas -> presenter",
          FaceGatekeeper.classify_face(FRAME, big_upper) == "presenter")
    check("payload min_area_ratio=0.20: wajah 14.5% -> content",
          FaceGatekeeper.classify_face(FRAME, big_upper, min_area_ratio=0.20) == "content")

    # Upper-half ambang dapat digeser: wajah cy=1000 presenter pada 0.55, content pada 0.50.
    mid_face = [290, 700, 500, 600]
    check("default upper 0.55: cy=1000 -> presenter",
          FaceGatekeeper.classify_face(FRAME, mid_face) == "presenter")
    check("payload upper_half_y=0.50: cy=1000 -> content",
          FaceGatekeeper.classify_face(FRAME, mid_face, upper_half_y=0.50) == "content")

    # Temporal ambang mengikuti presenter_min_hits (satu sumber dgn apply_temporal).
    small = [900, 800, 60, 70]
    check("temporal_hits=1 & min_hits=1 -> presenter",
          FaceGatekeeper.classify_face(FRAME, small, temporal_hits=1, presenter_min_hits=1) == "presenter")
    check("temporal_hits=1 & min_hits=2 -> content",
          FaceGatekeeper.classify_face(FRAME, small, temporal_hits=1, presenter_min_hits=2) == "content")


class _FakeImage:
    """Stub berbentuk seperti ndarray cv2 (h, w, 3) untuk jalur tanpa model."""
    def __init__(self):
        self.shape = (1920, 1080, 3)


def test_strict_path_unchanged():
    print("\n[4] Regresi jalur strict - detect() lama tidak boleh berubah perilaku")
    gate = FaceGatekeeper.__new__(FaceGatekeeper)  # tanpa init model
    gate.scrfd = None
    gate.mp_detector = None
    gate.yunet_detector = None
    gate.backend = "none"
    has_face, conf, box, reason = gate.detect(None, niche="kitchen_tools")
    check("strict: detect() tetap meloloskan (disabled sesuai permintaan user)",
          has_face is False and conf == 0.0)
    check("strict: detect_faces() tanpa model mengembalikan list kosong",
          gate.detect_faces(_FakeImage()) == [])


if __name__ == "__main__":
    print("Test Face Policy Presenter_Only (Fase 2)")
    test_classify_face()
    test_iou()
    test_temporal_track()
    test_payload_contract()
    test_strict_path_unchanged()
    print("\n" + "=" * 50)
    print("Hasil: %d passed, %d failed" % (PASS, FAIL))
    sys.exit(1 if FAIL else 0)
