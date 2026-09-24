#!/usr/bin/env python3
"""
Unit test FASE 2 — Face Policy 'presenter_only' pada Gatekeeper.
Murni logika (tanpa model vision): classify_face, _iou, apply_temporal_presenter_track.
Jalankan:  python server/gatekeeper/test_face_policy.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from service import FaceGatekeeper, apply_temporal_presenter_track

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
    print("\n[1] classify_face - aturan geometrik a/b/c/e")
    # a. presenter: wajah besar (500x600 = 14.5% frame) dominan di paruh atas
    check("wajah besar di atas -> presenter",
          FaceGatekeeper.classify_face(FRAME, [290, 150, 500, 600]) == "presenter")
    # c. content: wajah kecil (60x70 = 0.2% frame) pejalan kaki di sample foto
    check("wajah kecil -> content",
          FaceGatekeeper.classify_face(FRAME, [900, 800, 60, 70]) == "content")
    # e. fallback: ukuran menengah (250x300 = 3.6%) -> presenter (fail-safe)
    check("menengah ambigu -> presenter (fail-safe)",
          FaceGatekeeper.classify_face(FRAME, [400, 900, 250, 300]) == "presenter")
    # b. temporal: wajah kecil tapi persisten >= 3 frame -> presenter mengalahkan aturan c
    check("content kecil tapi persisten -> presenter",
          FaceGatekeeper.classify_face(FRAME, [900, 800, 60, 70], temporal_hits=2) == "presenter")
    check("wajah besar di bawah ambigu -> presenter (fallback e)",
          FaceGatekeeper.classify_face(FRAME, [290, 1200, 500, 600]) == "presenter")


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

    # Kasus B: wajah content yang DIAM di posisi sama 3 frame berurutan -> presenter
    still = [
        _v(0.0, [dict(small, box=[900, 800, 60, 70])]),
        _v(2.5, [dict(small, box=[905, 802, 60, 70])]),
        _v(5.0, [dict(small, box=[902, 799, 60, 70])]),
    ]
    apply_temporal_presenter_track(still)
    check("wajah persisten: 2 frame pertama masih clean",
          still[0]["status"] == "clean" and still[1]["status"] == "clean")
    check("wajah persisten: frame ke-3 dibuang sebagai presenter",
          still[2]["status"] == "discarded" and still[2]["stage"] == "face")
    check("wajah persisten: frame ke-3 TIDAK dapat flag eligible",
          not still[2].get("cameraResultEligible"))

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


class _FakeImage:
    """Stub berbentuk seperti ndarray cv2 (h, w, 3) untuk jalur tanpa model."""
    def __init__(self):
        self.shape = (1920, 1080, 3)


def test_strict_path_unchanged():
    print("\n[4] Regresi jalur strict - detect() lama tidak boleh berubah perilaku")
    gate = FaceGatekeeper.__new__(FaceGatekeeper)  # tanpa init model
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
    test_strict_path_unchanged()
    print("\n" + "=" * 50)
    print("Hasil: %d passed, %d failed" % (PASS, FAIL))
    sys.exit(1 if FAIL else 0)
