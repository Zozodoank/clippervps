#!/usr/bin/env python3
"""Regresi Fase 1 hemat CPU gatekeeper (tanpa model ONNX - gate di-stub).

Yang dijamin:
1. Frame SATU PASS: 1 decode per frame, frame statis ditolak TANPA inferensi.
2. DBNet dihemat lewat TEXT_CHECK_STRIDE, tetapi hasil teks yang "kotor" DIWARISKAN
   ke frame yang dilewati -> tidak ada penurunan recall deteksi watermark.
3. Bentuk respons tidak berubah (konsumen Node: cleanFrames, verifiedSegments, benchmarks).
Jalankan: python test_phase1_efficiency.py
"""
import importlib.util
import os
import sys
import tempfile

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("gk_service", os.path.join(HERE, "service.py"))
gk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gk)

# Heuristik modul-level tidak relevan untuk uji efisiensi -> dinetralkan.
gk.detect_pillarbox = lambda img: (False, 0.0, "")
gk.detect_paper_manual = lambda img: (False, "")
gk.detect_synthetic_graphic_overlay = lambda crop: (False, "")


class CountingFace:
    def __init__(self):
        self.calls = 0

    def detect(self, image_bgr, niche="kitchen_tools"):
        self.calls += 1
        return False, 0.0, None, "stub: tanpa wajah"

    def detect_faces(self, image_bgr, min_score=0.60):
        self.calls += 1
        return []


class CountingText:
    def __init__(self, dirty_at=None, always_dirty=False, sentinel=False, dirty_indices=None):
        self.calls = 0
        self.dirty_at = dirty_at  # index pemanggilan ke-N mengembalikan has_text=True
        self.always_dirty = always_dirty
        self.dirty_indices = dirty_indices  # himpunan index yang kotor (untuk uji probe)
        self._sentinel = sentinel
        self.sentinel_calls = 0
        self.backend = "dbnet_onnx_stub"  # TextGatekeeper asli punya atribut ini

    def needs_full_text_check(self, crop_bgr):
        """Stub sentinel Sobel murah (versi asli ada di TextGatekeeper)."""
        self.sentinel_calls += 1
        return self._sentinel

    def detect(self, crop_bgr, niche="kitchen_tools"):
        n = self.calls
        self.calls += 1
        corners = {"TL": 0.0, "TR": 0.0, "BL": 0.0, "BR": 0.0}
        dirty = self.always_dirty or (self.dirty_at is not None and n == self.dirty_at) \
            or (self.dirty_indices is not None and n in self.dirty_indices)
        if dirty:
            return True, 0.05, 0.04, "Watermark di pojok kanan bawah / BR (coverage 4.0%)", {"TL": 0.0, "TR": 0.0, "BL": 0.0, "BR": 0.05}
        return False, 0.001, 0.001, "Teks dalam batas aman (stub)", corners


class CountingScene:
    def __init__(self):
        self.calls = 0

    def evaluate(self, crop_bgr):
        self.calls += 1
        return "valid_real", 0.93, "stub: adegan produk nyata"


def make_gate():
    gate = gk.FrameGatekeeper.__new__(gk.FrameGatekeeper)
    gate.face_gate = CountingFace()
    gate.text_gate = CountingText()
    gate.scene_gate = CountingScene()
    return gate


def write_frames(tmp, pattern, count, start_ts=6.0, step=1.5):
    """pattern='static' -> gambar identik; 'moving' -> noise acak (perubahan besar)."""
    items = []
    rng = np.random.default_rng(7)
    for i in range(count):
        if pattern == "static":
            arr = np.zeros((480, 270, 3), dtype=np.uint8)
            arr[100:380, 40:230] = (40, 120, 200)
        else:
            arr = rng.integers(0, 255, size=(480, 270, 3), dtype="uint8")
        p = os.path.join(tmp, f"frame_{i:04d}.jpg")
        cv2.imwrite(p, arr)
        items.append({"filePath": p, "timestamp": round(start_ts + i * step, 1)})
    return items


def check(name, cond, extra=""):
    status = "PASS" if cond else "FAIL"
    print(f"[{status}] {name} {extra}")
    return 0 if cond else 1


def main():
    failures = 0
    with tempfile.TemporaryDirectory() as tmp:
        # ── 1. Batch statis total: tidak boleh ada inferensi (kecuali frame pertama) ──
        gate = make_gate()
        items = write_frames(tmp, "static", 8)
        res = gate.process_batch(items, niche="kitchen_tools", face_policy="strict")
        static_discards = [f for f in res["discardedFrames"] if f.get("stage") == "static_frame"]
        heavy = gate.face_gate.calls + gate.scene_gate.calls
        failures += check("statis: semua frame dibuang sebagai static_frame", len(static_discards) == 8,
                          f"({len(static_discards)}/8)")
        failures += check("statis: inferensi dihentikan (<=1 frame, dulu 8x penuh)", heavy <= 3,
                          f"(face+scene calls={heavy})")
        failures += check("statis: DBNet nyaris tidak dipanggil", gate.text_gate.calls <= 1,
                          f"(dbnet calls={gate.text_gate.calls})")
        failures += check("statis: field diagnostik ada", "staticFramesSkippedInference" in res["benchmarks"],
                          str(res["benchmarks"]))

        # ── 2. Batch bergerak: DBNet dihemat, face/scene tetap tiap frame ──
        gate2 = make_gate()
        items2 = write_frames(tmp, "moving", 12)
        res2 = gate2.process_batch(items2, niche="kitchen_tools", face_policy="strict")
        stride = gk.TEXT_CHECK_STRIDE
        failures += check("bergerak: face gate tetap per frame", gate2.face_gate.calls >= 24,
                          f"({gate2.face_gate.calls})")
        failures += check("bergerak: DBNet dihemat", gate2.text_gate.calls < 12,
                          f"(dbnet {gate2.text_gate.calls}/12, stride {stride})")
        failures += check("bergerak: bersih lolos sebagai clean", len(res2["cleanFrames"]) > 0,
                          f"({len(res2['cleanFrames'])} clean)")

        # ── 3. Watermark persisten: frame yang DBNet-nya di-skip tetap DIBUANG (warisan) ──
        gate3 = make_gate()
        gate3.text_gate = CountingText(always_dirty=True)
        items3 = write_frames(tmp, "moving", 12, start_ts=20.0)
        res3 = gate3.process_batch(items3, niche="kitchen_tools", face_policy="strict")
        text_discards = [f for f in res3["discardedFrames"] if f.get("stage") == "text"]
        inherited = [f for f in text_discards if f.get("textInherited")]
        failures += check("watermark persisten: SEMUA frame dibuang, termasuk yang DBNet-nya di-skip",
                          len(text_discards) == 12, f"({len(text_discards)}/12 dibuang, {len(inherited)} warisan)")
        failures += check("watermark persisten: DBNet tetap dihemat", gate3.text_gate.calls < 12,
                          f"({gate3.text_gate.calls}/12)")

        # ── 3B. SENTINEL: overlay BARU di frame yang seharusnya di-skip tetap ketangkap ──
        # Stub sentinel=True berarti "ada tanda teks di sudut/bawah" -> frame itu wajib
        # diperiksa DBNet penuh, bukan diwarisi hasil bersih frame sebelumnya.
        gate4 = make_gate()
        gate4.text_gate = CountingText(always_dirty=False, sentinel=True)
        items4 = write_frames(tmp, "moving", 12, start_ts=40.0)
        res4 = gate4.process_batch(items4, niche="kitchen_tools", face_policy="strict")
        failures += check("sentinel: frame curiga TIDAK diwarisi (DBNet jalan tiap frame curiga)",
                          gate4.text_gate.calls == 12, f"({gate4.text_gate.calls}/12)")
        failures += check("sentinel: tidak ada frame berlabel warisan",
                          not [f for f in res4["allFrames"] if f.get("textInherited")])

        # ── 4. Kontrak respons untuk konsumen Node tidak berubah ──
        for key in ("status", "eligible", "reason", "totalFrames", "cleanFramesCount",
                    "verifiedSegments", "cleanFrames", "discardedFrames", "allFrames", "benchmarks"):
            failures += check(f"kontrak respons: '{key}' ada", key in res2)

        # ── 5. (#5) INSTRUMENTASI: bench per-tahap bersarang di benchmarks ──
        bm = res2["benchmarks"]
        failures += check("bench: stageMs ada", isinstance(bm.get("stageMs"), dict) and len(bm["stageMs"]) > 0, str(bm.get("stageMs")))
        failures += check("bench: stageCounts ada", isinstance(bm.get("stageCounts"), dict), str(bm.get("stageCounts")))
        failures += check("bench: rejectsByStage ada", isinstance(bm.get("rejectsByStage"), dict), str(bm.get("rejectsByStage")))
        sc = bm.get("stageCounts", {})
        failures += check("bench: frames_in == 12", sc.get("frames_in") == 12, f"({sc.get('frames_in')})")
        failures += check("bench: yunet_crop & dbnet & mobilenet tercatat",
                          sc.get("yunet_crop_calls", 0) > 0 and sc.get("dbnet_calls", 0) > 0 and sc.get("mobilenet_calls", 0) > 0,
                          f"(crop={sc.get('yunet_crop_calls')} dbnet={sc.get('dbnet_calls')} scene={sc.get('mobilenet_calls')})")
        failures += check("bench: face_caught_by_full_only nihil (stub tanpa wajah)",
                          sc.get("face_caught_by_full_only", 0) == 0, f"({sc.get('face_caught_by_full_only', 0)})")
        # bench instance lokal -> dua batch berurutan TIDAK boleh menumpuk (bukti anti-race).
        failures += check("bench: lokal (dbnet_calls batch kecil != akumulasi dua batch)",
                          res["benchmarks"]["stageCounts"].get("dbnet_calls", 0) <= 1)

        # ── 6. (#2) WATERMARK PROBE: stateless, hanya text_gate, tidak sentuh face/scene ──
        gatep = make_gate()
        gatep.text_gate = CountingText(dirty_indices={0, 2, 4})
        probe_items = write_frames(tmp, "moving", 5, start_ts=60.0)
        pres = gatep.process_watermark_probe(probe_items, niche="kitchen_tools")
        failures += check("probe: flag probe=True & status success", pres.get("probe") is True and pres.get("status") == "success")
        failures += check("probe: wmCount==3 dari 5 titik", pres.get("wmCount") == 3 and pres.get("total") == 5, f"({pres.get('wmCount')}/{pres.get('total')})")
        failures += check("probe: hanya DBNet yang dipanggil (tanpa face/scene)",
                          gatep.face_gate.calls == 0 and gatep.scene_gate.calls == 0 and gatep.text_gate.calls == 5,
                          f"(text={gatep.text_gate.calls} face={gatep.face_gate.calls} scene={gatep.scene_gate.calls})")
        # Frame gagal decode TIDAK dihitung sebagai watermark & tidak menggagalkan probe.
        probe_items2 = write_frames(tmp, "moving", 4, start_ts=80.0) + [{"filePath": os.path.join(tmp, "tidak_ada.jpg"), "timestamp": 99.0}]
        pres2 = gatep.process_watermark_probe(probe_items2, niche="kitchen_tools")
        failures += check("probe: frame gagal decode -> decoded<total & hit False", pres2["decoded"] == 4 and pres2["total"] == 5, f"(decoded={pres2['decoded']})")
        failures += check("probe: hits adalah list bool seukuran total", isinstance(pres2["hits"], list) and len(pres2["hits"]) == 5)

    print("\nHASIL AKHIR:", "PASS" if failures == 0 else f"FAIL ({failures} pemeriksaan gagal)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
