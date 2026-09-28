#!/usr/bin/env python3
"""
Uji unit deterministik untuk _ScrfdDetector (pengganti YuNet) TANPA model/GPU.
Sengaja menguji matematika paling rawan: dekode anchor (distance2bbox / distance2kps),
NMS, dan alur detect() end-to-end memakai sesi ONNXRuntime PALSU dengan output buatan
yang sudah diketahui hasilnya.
"""
import os
import sys

import numpy as np
import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import service as gk  # noqa: E402


failures = 0


def check(name, cond, extra=""):
    global failures
    status = "PASS" if cond else "FAIL"
    if not cond:
        failures += 1
    print(f"[{status}] {name} {extra}")


class _FakeInput:
    def __init__(self, name, shape):
        self.name = name
        self.shape = shape


class _FakeOutput:
    def __init__(self, name, shape):
        self.name = name
        self.shape = shape


class _FakeSession:
    """Sesi ORT tiruan: mengembalikan output yang telah kami susun sebelumnya."""

    def __init__(self, outputs):
        self._outputs = outputs
        self._inputs = [_FakeInput("input.1", [1, 3, 64, 64])]

    def get_inputs(self):
        return self._inputs

    def get_outputs(self):
        return [_FakeOutput(f"out{i}", list(o.shape)) for i, o in enumerate(self._outputs)]

    def run(self, output_names, feed):
        return self._outputs


def make_det(outputs, use_kps=True, input_size=(64, 64)):
    """Bangun _ScrfdDetector tanpa __init__ berat (hindari load model asli)."""
    d = gk._ScrfdDetector.__new__(gk._ScrfdDetector)
    d.input_mean = 127.5
    d.input_std = 128.0
    d.det_thresh = 0.5
    d.nms_thresh = 0.4
    d.center_cache = {}
    d.input_size = input_size
    d.input_name = "input.1"
    d.output_names = [f"out{i}" for i in range(len(outputs))]
    d.batched = False
    d.fmc = 3
    d.strides = [8, 16, 32]
    d.num_anchors = 2
    d.use_kps = use_kps
    d.session = _FakeSession(outputs)
    d.backend = "scrfd"
    return d


def build_outputs(n8, n16, n32, pos_index=0, pos_score=0.99, dist=(10.0, 10.0, 10.0, 10.0), use_kps=True):
    """Semua score 0 kecuali satu anchor di level stride-8 (index pos_index)."""
    scores = [np.zeros(n8, np.float32), np.zeros(n16, np.float32), np.zeros(n32, np.float32)]
    scores[0][pos_index] = pos_score
    bboxes = [np.zeros((n8, 4), np.float32), np.zeros((n16, 4), np.float32), np.zeros((n32, 4), np.float32)]
    bboxes[0][pos_index] = dist
    if not use_kps:
        return scores + bboxes
    kpss = [np.zeros((n8, 10), np.float32), np.zeros((n16, 10), np.float32), np.zeros((n32, 10), np.float32)]
    return scores + bboxes + kpss


# ── 1. distance2bbox: decode simetris ──
pts = np.array([[100.0, 100.0]], np.float32)
dst = np.array([[10.0, 20.0, 30.0, 40.0]], np.float32)
box = gk._ScrfdDetector._distance2bbox(pts, dst)[0]
check("distance2bbox x1/y1/x2/y2", np.allclose(box, [90.0, 80.0, 130.0, 140.0]), f"({box.tolist()})")

# ── 2. distance2kps: 2 titik, offset per-sumbu ──
kps = gk._ScrfdDetector._distance2kps(pts, np.array([[5.0, 6.0, 7.0, 8.0]], np.float32))[0]
# px0 = x + d0 = 105, py0 = y + d1 = 106, px1 = x + d2 = 107, py1 = y + d3 = 108
check("distance2kps 2 titik", np.allclose(kps, [105.0, 106.0, 107.0, 108.0]), f"({kps.tolist()})")

# ── 3. NMS: dua box tumpang tindih -> sisakan skor tertinggi ──
d = make_det(build_outputs(128, 32, 8, use_kps=True))
dets = np.array([
    [0, 0, 10, 10, 0.9],
    [1, 1, 11, 11, 0.5],   # IoU tinggi dengan box0 -> dibuang
    [100, 100, 110, 110, 0.7],  # jauh -> tetap
], np.float32)
keep = d._nms(dets)
check("NMS menyisakan 2 box non-overlap", sorted(keep) == [0, 2], f"(keep={sorted(keep)})")

# ── 4. detect() end-to-end: satu wajah di level stride-8, indeks 0 ──
img = np.zeros((64, 64, 3), np.uint8)
outs = build_outputs(128, 32, 8, pos_index=0, pos_score=0.99, dist=(10, 10, 10, 10))
det = make_det(outs)
res = det.detect(img)
check("detect() menemukan tepat 1 wajah", len(res) == 1, f"(n={len(res)})")
if res:
    b = res[0]["box"]
    # bbox_preds dikali stride (8) dahulu (sesuai insightface scrfd.py), jadi
    # anchor(0,0) + dist*stride(10*8=80) -> x1=-80 y1=-80 x2=80 y2=80 -> box=[-80,-80,160,160]
    check("detect() box terdekoding benar (dist x stride)", b == [-80, -80, 160, 160], f"(box={b})")
    check("detect() score terbawa", abs(res[0]["score"] - 0.99) < 1e-4)
    check("detect() kps 10 nilai (5 titik)", res[0]["kps"] is not None and len(res[0]["kps"]) == 10)

# ── 5. ambang: score di bawah det_thresh diabaikan ──
outs_low = build_outputs(128, 32, 8, pos_index=0, pos_score=0.30)
det_low = make_det(outs_low)
check("detect() mengabaikan score < threshold", len(det_low.detect(img)) == 0)

# ── 6. varian 6-output (tanpa kps) tetap jalan, kps None ──
outs_nokps = build_outputs(128, 32, 8, pos_index=0, pos_score=0.99, use_kps=False)
det_nokps = make_det(outs_nokps, use_kps=False)
res_nokps = det_nokps.detect(img)
check("detect() 6-output: 1 wajah, kps None", len(res_nokps) == 1 and res_nokps[0]["kps"] is None, f"(n={len(res_nokps)})")

# ── 7. gambar kosong -> list kosong, tanpa exception ──
check("detect() gambar kosong -> []", det.detect(None) == [] and det.detect(np.zeros((0, 0, 3), np.uint8)) == [])

print("\nHASIL AKHIR:", "PASS" if failures == 0 else f"FAIL ({failures})")
sys.exit(1 if failures else 0)
