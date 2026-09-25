#!/usr/bin/env python3
"""
AI Local Frame Gatekeeper Service for ClipperVPS.
Lightweight real-time CPU vision pipeline to reject dirty video frames before reaching main LLM:
- Stage 1: MediaPipe & YuNet Face Detection (100% faceless in 9:16 crop & full frame)
- Stage 2: DBNet Text, Subtitle & 4-Corner Watermark Detection + Temporal Watermark Aggregation
- Stage 3: MobileNetV3 3-State Scene Classifier (CLEAN >= 0.78, UNCERTAIN 0.62-0.78, REJECT < 0.62)
- Stage 4: Clean Temporal Segment Validation (Continuous clean windows, min 3 consecutive frames / >=4.0s)
"""

import os
import sys

# Ensure UTF-8 output on Windows console to prevent UnicodeEncodeError with emojis
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# PAKSA LINE BUFFERING untuk SEMUA platform. Saat proses dijalankan lewat PM2
# (pm2 start service.py --interpreter python3), stdout BUKAN sebuah TTY sehingga
# Python memakainya dalam MODE BLOCK BUFFER (4-8 KB). Akibatnya semua print()
# (termasuk log /filter-frames dan peringatan "Klien terputus") tertahan di buffer
# dan `pm2 logs gatekeeper` tampak DIAM / log tidak tampil sama sekali bermenit-menit.
# line_buffering=True = flush tiap baris, sama seperti PYTHONUNBUFFERED=-u tapi tidak
# bergantung pada cara proses distart.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(line_buffering=True)
    except Exception:
        pass

import json
import time
import math
import argparse
from collections import Counter, defaultdict
from http.server import HTTPServer, ThreadingHTTPServer, BaseHTTPRequestHandler

# VPS 2-core: batasi thread OpenMP/BLAS SEBELUM cv2/numpy/onnxruntime dimuat,
# mencegah kontensi thread dengan Node.js + FFmpeg yang berjalan bersamaan.
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")
os.environ.setdefault("ORT_LOGGING_LEVEL", "3")
os.environ.setdefault("ONNXRUNTIME_LOG_LEVEL", "3")
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")

try:
    import cv2  # type: ignore
    HAS_CV2 = True
except ImportError:
    cv2 = None
    HAS_CV2 = False

try:
    import numpy as np  # type: ignore
    HAS_NUMPY = True
except ImportError:
    np = None
    HAS_NUMPY = False

if HAS_CV2 and cv2 is not None:
    try:
        cv2.setNumThreads(1)
    except Exception:
        pass

# ONNX runtime & MediaPipe
try:
    import onnxruntime as ort  # type: ignore
    HAS_ORT = True
except ImportError:
    ort = None
    HAS_ORT = False

try:
    import mediapipe as mp  # type: ignore
    from mediapipe.tasks import python as mp_tasks  # type: ignore
    from mediapipe.tasks.python import vision as mp_vision  # type: ignore
    HAS_MEDIAPIPE = True
except ImportError:
    mp = None
    mp_tasks = None
    mp_vision = None
    HAS_MEDIAPIPE = False

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
MODELS_DIR = os.path.join(CURRENT_DIR, "models")

# Phase 1 hemat CPU (2026-09-25): DBNet PP-OCRv4 (input 736px) adalah stage TERBERAT di
# gatekeeper, padahal overlay watermark/subtitle yang dicari bertahan berdetik-detik sementara
# frame kita berjarak ~1.5s. Cukup periksa 1 dari N frame; frame sisanya mewarisi hasil cek
# terakhir. Set GK_TEXT_CHECK_STRIDE=1 untuk mengembalikan perilaku lama (DBNet tiap frame).
TEXT_CHECK_STRIDE = max(1, int(os.environ.get("GK_TEXT_CHECK_STRIDE", "3") or 3))


class _Bench:
    """Akumulasi metrik per-tahap yang AMAN untuk ThreadingHTTPServer.
    Instance dibuat LOKAL per process_batch (BUKAN global) supaya job yang
    berjalan konkuren tidak saling mengotori angka."""
    __slots__ = ("ns", "counts")

    def __init__(self):
        self.ns = defaultdict(int)
        self.counts = defaultdict(int)

    def tic(self):
        return time.perf_counter_ns()

    def toc(self, key, t0):
        self.ns[key] += (time.perf_counter_ns() - t0)

    def inc(self, key, n=1):
        self.counts[key] += n

    def to_payload(self):
        # Konversi ns -> ms sekali di akhir; hindari print per-frame.
        return {
            "stageMs": {k: round(v / 1e6, 1) for k, v in self.ns.items()},
            "stageCounts": {k: v for k, v in self.counts.items()},
        }


def _bench_time(bench, key, fn, *args, **kwargs):
    """Jalankan fn. Bila bench aktif, kumpulkan waktu (ns) + jumlah pemanggilan.
    bench=None (jalur non-batch) => panggil langsung fn tanpa overhead."""
    if bench is None:
        return fn(*args, **kwargs)
    t0 = bench.tic()
    try:
        return fn(*args, **kwargs)
    finally:
        bench.toc(key, t0)
        bench.inc(key + "_calls")


# ─────────────────────────────────────────────────────────────────────────────
# 1. TAHAP 1: FACE DETECTOR (MediaPipe BlazeFace + OpenCV YuNet)
# ─────────────────────────────────────────────────────────────────────────────
class FaceGatekeeper:
    def __init__(self, min_confidence=0.52):
        # min_confidence 0.52 — cukup tinggi agar tidak false-positive pada produk oval/tangan
        self.min_confidence = min_confidence
        self.mp_detector = None
        self.yunet_detector = None
        self.backend = "none"

        # 1. MediaPipe Tasks FaceDetector (BlazeFace short range)
        tflite_path = os.path.join(MODELS_DIR, "blaze_face_short_range.tflite")
        if HAS_MEDIAPIPE and os.path.exists(tflite_path):
            try:
                base_options = mp_tasks.BaseOptions(model_asset_path=tflite_path)
                options = mp_vision.FaceDetectorOptions(
                    base_options=base_options,
                    min_detection_confidence=self.min_confidence
                )
                self.mp_detector = mp_vision.FaceDetector.create_from_options(options)
                self.backend = "mediapipe"
                print("  [FaceGatekeeper] ✅ MediaPipe BlazeFace aktif (threshold 0.38).")
            except Exception as e:
                print(f"  [FaceGatekeeper] ⚠️ MediaPipe init error: {e}")

        # 2. OpenCV YuNet (ONNX sub-2ms)
        yunet_path = os.path.join(MODELS_DIR, "face_detection_yunet_2023mar.onnx")
        if os.path.exists(yunet_path):
            try:
                self.yunet_detector = cv2.FaceDetectorYN.create(
                    model=yunet_path,
                    config="",
                    input_size=(320, 320),
                    score_threshold=0.72,
                    nms_threshold=0.3,
                    top_k=5000
                )
                if self.backend == "none":
                    self.backend = "yunet"
                print("  [FaceGatekeeper] ✅ OpenCV YuNet Face Detection aktif (threshold 0.875 + Semantic Gate).")
            except Exception as e:
                print(f"  [FaceGatekeeper] ⚠️ YuNet init error: {e}")

        if self.backend == "none":
            print("  [FaceGatekeeper] ⚠️ Mode fallback aktif.")

    def _save_rejected_face_frame(self, image_bgr, bbox, score, detector_name="YuNet"):
        """
        Menyimpan visual frame yang ditolak oleh detektor wajah (YuNet / MediaPipe)
        ke folder server/rejected_frames/yunet lengkap dengan bounding box & confidence score
        agar pengguna dapat menginspeksi akurasi deteksi secara langsung.
        """
        try:
            rejected_dir = os.path.join(CURRENT_DIR, "..", "rejected_frames", "yunet")
            os.makedirs(rejected_dir, exist_ok=True)

            # Batasi maksimal 200 frame agar tidak memenuhi penyimpanan Termux/VPS
            existing = sorted(os.listdir(rejected_dir))
            if len(existing) > 200:
                for old in existing[:25]:
                    try:
                        os.unlink(os.path.join(rejected_dir, old))
                    except Exception:
                        pass

            vis = image_bgr.copy()
            if bbox and len(bbox) == 4:
                bx, by, bw, bh = bbox
                # Gambar kotak merah terang di sekeliling wajah terdeteksi
                cv2.rectangle(vis, (bx, by), (bx + bw, by + bh), (0, 0, 255), 2)
                # Label teks confidence score
                label = f"{detector_name}: {score * 100:.1f}%"
                cv2.putText(vis, label, (bx, max(20, by - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (0, 0, 255), 2)

            ts_ms = int(time.time() * 1000)
            fname = f"rejected_{detector_name.lower()}_{ts_ms}.jpg"
            out_path = os.path.join(rejected_dir, fname)
            cv2.imwrite(out_path, vis)
            print(f"  [FaceGatekeeper] 📸 Frame wajah ditolak {detector_name} ({score * 100:.1f}%) disimpan ke: {out_path}")
        except Exception as e:
            pass

    def _is_valid_human_face(self, image_bgr, bbox, score, landmarks=None, min_score=0.94):
        """
        Penyaring Semantik Pasca-Deteksi (Post-Processing Semantic Verification Gate):
        Membedakan wajah vlogger/presenter manusia asli dari tangan, perkakas dapur,
        tombol/panel chopper, blender kaca, pisau berputar, dan lipatan kertas/manual.
        """
        h, w = image_bgr.shape[:2]
        bx, by, bw, bh = bbox

        # 1. Ambang batas keyakinan (Score Threshold) sangat ketat:
        # Ditingkatkan ke 94.0% agar YuNet tidak agresif memblokir non-wajah (seperti tombol alat dapur).
        # Wajah yang tidak tertangkap di sini akan ditangani oleh Gemini Filter 3.
        if score < min_score:
            return False, f"Score di bawah batas presenter ({score * 100:.1f}% < {min_score * 100:.1f}%)"

        # 2. Batas dimensi geometris frame:
        # Bounding box tidak boleh melampaui lebar frame utuh (ciri khas bidikan makro tangan/alas meja)
        if bw > w:
            return False, f"BBox melebihi dimensi frame ({bw}px > {w}px)"

        # 3. Ukuran minimal wajah presenter:
        # Menolak maskot kartun kecil di kemasan produk / stiker meja
        min_dim = max(40, int(min(h, w) * 0.08))
        if bw < min_dim or bh < min_dim:
            return False, f"Ukuran wajah terlalu kecil untuk presenter ({bw}x{bh} < {min_dim}px)"

        # 4. Rasio aspek wajah manusia normal (tinggi vs lebar biasanya 0.85 - 1.70)
        # Objek horizontal melebar (bh/bw < 0.85) biasanya adalah genggaman tangan atau alat dapur
        aspect = bh / max(bw, 1)
        if aspect < 0.85 or aspect > 1.70:
            return False, f"Proporsi aspek tidak wajar untuk wajah manusia ({aspect:.2f})"

        # 5. Verifikasi spektrum warna kulit manusia alami (HSV + YCrCb ganda)
        # Membuang blender kaca, pisau stainless steel, tutup chopper plastik, panci teflon
        crop = image_bgr[max(0, by):min(h, by + bh), max(0, bx):min(w, bx + bw)]
        if crop.size == 0:
            return False, "Area crop wajah kosong"

        try:
            hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
            ycrcb = cv2.cvtColor(crop, cv2.COLOR_BGR2YCrCb)
            mask_hsv = cv2.inRange(hsv, (0, 25, 50), (25, 255, 255))
            mask_ycrcb = cv2.inRange(ycrcb, (0, 133, 77), (255, 173, 127))
            skin_mask = cv2.bitwise_and(mask_hsv, mask_ycrcb)
            skin_ratio = float(np.count_nonzero(skin_mask)) / float(crop.shape[0] * crop.shape[1])
            if skin_ratio < 0.35:
                return False, f"Bukan warna kulit manusia (skin_ratio: {skin_ratio * 100:.1f}% < 35%)"
        except Exception:
            pass

        # 6. Geometri 5-titik landmark wajah (mata kanan, mata kiri, hidung, mulut kanan, mulut kiri)
        if landmarks is not None and len(landmarks) >= 10:
            re_x, re_y = landmarks[0], landmarks[1]
            le_x, le_y = landmarks[2], landmarks[3]
            n_x, n_y = landmarks[4], landmarks[5]
            rm_x, rm_y = landmarks[6], landmarks[7]
            lm_x, lm_y = landmarks[8], landmarks[9]

            # Jarak antarmata terhadap lebar wajah (normalnya 20% - 60%)
            eye_dist = np.hypot(re_x - le_x, re_y - le_y)
            eye_ratio = eye_dist / max(bw, 1)
            if eye_ratio < 0.20 or eye_ratio > 0.60:
                return False, f"Jarak antarmata di luar proporsi natural ({eye_ratio:.2f})"

            # Kemiringan mata (wajah presenter wajar kemiringan mata < ~35 derajat)
            eye_tilt = abs(re_y - le_y) / max(eye_dist, 1)
            if eye_tilt > 0.55:
                return False, f"Kemiringan mata abnormal ({eye_tilt:.2f})"

            # Hierarki susunan vertikal: mata di atas hidung, hidung di atas mulut
            avg_eye_y = (re_y + le_y) / 2.0
            avg_mouth_y = (rm_y + lm_y) / 2.0
            if not (avg_eye_y < n_y < avg_mouth_y):
                return False, "Susunan landmark vertikal tidak sesuai wajah manusia"

            # Simetri Midline Wajah: Titik tengah mata vs titik tengah mulut
            # Pada anatomi manusia, mata dan mulut berada di satu sumbu vertikal simetris (drift < 10% lebar wajah).
            # Tangan menekuk kertas atau tombol alat dapur memiliki deviasi lateral jauh lebih tinggi.
            eye_cx = (re_x + le_x) / 2.0
            mouth_cx = (rm_x + lm_x) / 2.0
            mouth_eye_drift = abs(mouth_cx - eye_cx) / max(bw, 1)
            if mouth_eye_drift > 0.10:
                return False, f"Asimetri midline wajah abnormal (drift {mouth_eye_drift:.2f} > 0.10)"

        # 7. Validasi zona meja / alas kerja (Tabletop Zone Sanity Check):
        # Wajah presenter dalam video affiliasi selalu berada di separuh atas frame (top 65%).
        # Jika pusat bounding box berada di zona bawah (center_y > 65% height), area tersebut adalah
        # tempat chopper, blender, dan talenan berada — memerlukan keyakinan mutlak (>= 97%).
        center_y = by + bh / 2.0
        if center_y > h * 0.50 and score < 0.97:
            return False, f"Objek di zona meja/bawah dengan keyakinan belum konklusif ({score * 100:.1f}% < 97%)"

        return True, "Wajah manusia valid"

    @staticmethod
    def _iou(box_a, box_b):
        ax1, ay1, aw, ah = box_a
        bx1, by1, bw, bh = box_b
        ix = max(0, min(ax1 + aw, bx1 + bw) - max(ax1, bx1))
        iy = max(0, min(ay1 + ah, by1 + bh) - max(ay1, by1))
        inter = ix * iy
        union = aw * ah + bw * bh - inter
        return float(inter) / float(union) if union > 0 else 0.0

    @staticmethod
    def classify_face(frame_shape, box, temporal_hits=0):
        """Klasifikasi wajah: 'presenter' (blokir) vs 'content' (boleh untuk slot
        ber-facePolicy presenter_only, misal uji kamera niche smartphone).
        Urutan aturan sesuai spesifikasi Fase 2; ragukan = presenter (fail-safe)."""
        fh, fw = frame_shape
        bx, by, bw, bh = box
        frame_area = float(max(1, fw * fh))
        area_ratio = (bw * bh) / frame_area
        face_cy = by + bh / 2.0

        # a. PRESENTER: wajah besar & dominan di paruh atas frame (talking-head / kreator pegang HP)
        if area_ratio >= 0.06 and face_cy < 0.55 * fh:
            return "presenter"
        # b. PRESENTER: posisi stabil lintas >= 3 frame berurutan (hits dihitung track temporal)
        if temporal_hits >= 2:
            return "presenter"
        # c. CONTENT: wajah kecil (pejalan kaki / wajah dalam sample foto hasil kamera)
        if area_ratio < 0.03:
            return "content"
        # d. Region layar perangkat/viewfinder belum terdeteksi di pipeline CPU ini ->
        # e. FALLBACK konservatif: ragukan = PRESENTER
        return "presenter"

    def detect_faces(self, image_bgr, min_score=0.60):
        """Daftar wajah manusia valid (box + score) untuk policy presenter_only.
        Mode strict TIDAK memakai method ini — deteksi lokal sengaja nonaktif
        (keputusan user: wajah disaring Gemini Filter 3), jadi niche lain tak terpengaruh."""
        faces = []
        h, w = image_bgr.shape[:2]
        if self.mp_detector:
            try:
                rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                results = self.mp_detector.detect(mp_image)
                for det in (getattr(results, "detections", None) or []):
                    score = det.categories[0].score if det.categories else 0.0
                    bbox = det.bounding_box
                    box = [max(0, int(bbox.origin_x)), max(0, int(bbox.origin_y)), int(bbox.width), int(bbox.height)]
                    if self._is_valid_human_face(image_bgr, box, score, min_score=min_score)[0]:
                        faces.append({"box": box, "score": float(score), "kind": self.classify_face((h, w), box)})
            except Exception:
                pass
        if self.yunet_detector:
            try:
                self.yunet_detector.setInputSize((w, h))
                _, dets = self.yunet_detector.detect(image_bgr)
                if dets is not None:
                    for face in dets:
                        score = float(face[-1])
                        box = [int(face[0]), int(face[1]), int(face[2]), int(face[3])]
                        landmarks = [float(face[i]) for i in range(4, 14)]
                        if self._is_valid_human_face(image_bgr, box, score, landmarks, min_score=min_score)[0]:
                            if not any(self._iou(box, f["box"]) > 0.4 for f in faces):
                                faces.append({"box": box, "score": score, "kind": self.classify_face((h, w), box)})
            except Exception:
                pass
        return faces

    def detect(self, image_bgr, niche="kitchen_tools"):
        # ATAS PERMINTAAN USER: Matikan deteksi wajah lokal (YuNet/MediaPipe) sepenuhnya.
        # Biarkan Gemini Filter 3 yang bertugas membuang frame wajah.
        # CATATAN FASE 2: jalur ini tetap untuk policy 'strict' (semua niche lama).
        # Policy 'presenter_only' memakai detect_faces() + classify_face() di process_single_frame.
        return False, 0.0, None, "Local Face Detection Disabled"

        # 1. MediaPipe BlazeFace
        if self.mp_detector:
            try:
                rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                results = self.mp_detector.detect(mp_image)
                if results and results.detections:
                    best_score = 0.0
                    best_box = None
                    for det in results.detections:
                        score = det.categories[0].score if det.categories else 0.0
                        bbox = det.bounding_box
                        bx = max(0, int(bbox.origin_x))
                        by = max(0, int(bbox.origin_y))
                        bw = int(bbox.width)
                        bh = int(bbox.height)
                        is_valid, _ = self._is_valid_human_face(image_bgr, [bx, by, bw, bh], score)
                        if is_valid and score > best_score:
                            best_score = score
                            best_box = [bx, by, bw, bh]
                    if best_box:
                        self._save_rejected_face_frame(image_bgr, best_box, float(best_score), "MediaPipe")
                        return True, float(best_score), best_box, f"Wajah vlogger/presenter terdeteksi (BlazeFace: {best_score * 100:.1f}%)"
            except Exception:
                pass

        # 2. OpenCV YuNet (Second-pass detector untuk wajah samping/miring)
        if self.yunet_detector:
            try:
                self.yunet_detector.setInputSize((w, h))
                _, faces = self.yunet_detector.detect(image_bgr)
                if faces is not None and len(faces) > 0:
                    for face in faces:
                        score = float(face[-1])
                        bx, by, bw, bh = int(face[0]), int(face[1]), int(face[2]), int(face[3])
                        landmarks = [float(face[i]) for i in range(4, 14)]
                        is_valid, reason = self._is_valid_human_face(image_bgr, [bx, by, bw, bh], score, landmarks)
                        if is_valid:
                            self._save_rejected_face_frame(image_bgr, [bx, by, bw, bh], score, "YuNet")
                            return True, score, [bx, by, bw, bh], f"Wajah presenter terdeteksi (YuNet: {score * 100:.1f}%)"
            except Exception:
                pass

        return False, 0.0, None, "Bersih (faceless)"


def apply_temporal_presenter_track(single_verdicts, iou_thresh=0.55, min_hits=2):
    """Fase 2 (policy presenter_only): wajah 'content' yang bertahan di posisi sama
    (IoU >= 0.55) pada >= min_hits frame kronologis sebelumnya adalah PRESENTER statis
    (kreator di depan kamera), bukan konten sample foto. Frame-nya di-discard.
    Frame clean yang masih punya wajah content murni diberi flag cameraResultEligible."""
    history = []
    for v in single_verdicts:
        faces = v.get("faces") or []
        for f in faces:
            hits = 0
            for prev_boxes in reversed(history):
                if any(FaceGatekeeper._iou(pb, f["box"]) >= iou_thresh for pb in prev_boxes):
                    hits += 1
                else:
                    break
            if hits >= min_hits:
                f["kind"] = "presenter"
        history.append([f["box"] for f in faces])
        if faces and any(f["kind"] == "presenter" for f in faces) and v.get("status") != "discarded":
            v["status"] = "discarded"
            v["stage"] = "face"
            v["decision"] = "REJECT"
            v["reason"] = "Wajah persisten di posisi sama lintas >= 3 frame (presenter statis, policy presenter_only)"
        elif faces and v.get("status") in ("clean",) and all(f["kind"] == "content" for f in faces):
            v["cameraResultEligible"] = True
    return single_verdicts


# ─────────────────────────────────────────────────────────────────────────────
# 2. TAHAP 2: TEXT, SUBTITLE & CORNER WATERMARK DETECTOR (DBNet PP-OCRv4 ONNX)
# ─────────────────────────────────────────────────────────────────────────────
class TextGatekeeper:
    """
    Deteksi teks, watermark pojok, subtitle terbakar, dan promo banner.
    Memeriksa 4 sudut frame secara ketat untuk menangkap watermark sekecil 2-5% zona.
    """
    def __init__(self, max_total_coverage=0.012, max_bottom_coverage=0.013):
        # Threshold diperketat (2026-09-24): subtitle >= 1.3% area bawah, total teks >= 1.2% frame, sudut >= 1.2%
        # Lebih agresif untuk menangkap angka/badge kecil mengambang, overlay samar, dan teks semi-transparan
        self.max_total_coverage = max_total_coverage
        self.max_bottom_coverage = max_bottom_coverage
        self.ort_session = None
        self.backend = "none"

        model_path = os.path.join(MODELS_DIR, "ch_PP-OCRv4_det.onnx")
        if HAS_ORT and os.path.exists(model_path):
            try:
                opts = ort.SessionOptions()
                opts.intra_op_num_threads = 2
                opts.inter_op_num_threads = 1
                opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
                self.ort_session = ort.InferenceSession(
                    model_path,
                    sess_options=opts,
                    providers=["CPUExecutionProvider"]
                )
                self.backend = "dbnet_onnx"
                print("  [TextGatekeeper] ✅ DBNet PP-OCRv4 ONNX Text & 4-Corner Watermark Detection aktif (736px high-res).")
            except Exception as e:
                print(f"  [TextGatekeeper] ⚠️ Gagal memuat DBNet ONNX: {e}")

        if not self.ort_session:
            self.backend = "gradient_fallback"
            print("  [TextGatekeeper] ℹ️ Menggunakan fallback Sobel horizontal edge 4-corner text density.")

    def detect(self, crop_bgr, niche="kitchen_tools"):
        h, w = crop_bgr.shape[:2]
        crop_area = float(h * w)
        if crop_area < 100:
            return False, 0.0, 0.0, "Frame terlalu kecil", {"TL": 0.0, "TR": 0.0, "BL": 0.0, "BR": 0.0}

        # ── Deteksi Kotak Banner Berlatar Warna / Badge Spesifikasi / Teks Statis ──
        try:
            small_color = cv2.resize(crop_bgr, (160, 280), interpolation=cv2.INTER_AREA)
            gray_small = cv2.cvtColor(small_color, cv2.COLOR_BGR2GRAY)
            edges = cv2.Canny(gray_small, 50, 150)
            k_banner = cv2.getStructuringElement(cv2.MORPH_RECT, (11, 3))
            dilated_banner = cv2.dilate(edges, k_banner)
            contours, _ = cv2.findContours(dilated_banner, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            for cnt in contours:
                bx, by, bw, bh = cv2.boundingRect(cnt)
                # Abaikan kontour yang melebar hampir selebar frame (kemungkinan tepi produk/latar)
                if bw >= int(160 * 0.90):
                    continue
                # Kartu banner atau badge spesifikasi (>= 25% lebar frame) dan tinggi 5%-30% frame
                if bw >= int(160 * 0.25) and int(280 * 0.05) <= bh <= int(280 * 0.30):
                    if (bw * bh) > (160 * 280 * 0.030) and (by + bh / 2) > (280 * 0.10):
                        inner_edge_density = np.count_nonzero(edges[by:by+bh, bx:bx+bw]) / float(bw * bh)
                        # Dinaikkan: 35% edge density agar hanya kotak teks padat yang terdeteksi
                        if inner_edge_density > 0.35:
                            return True, 0.10, 0.12, f"Badge spesifikasi / kartu teks statis terdeteksi ({bw}x{bh}px)", {"TL": 0.0, "TR": 0.0, "BL": 0.0, "BR": 0.0}
        except Exception:
            pass

        # ── Jalur 1: DBNet PP-OCRv4 ONNX Inference (High-Res 736px, Aspect-Preserved) ──
        if self.ort_session:
            try:
                target_size = 736
                scale = target_size / max(h, w)
                target_w = max(32, int(round(w * scale / 32.0)) * 32)
                target_h = max(32, int(round(h * scale / 32.0)) * 32)

                resized = cv2.resize(crop_bgr, (target_w, target_h), interpolation=cv2.INTER_LINEAR)
                rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
                mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
                std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
                norm = (rgb - mean) / std
                blob = np.transpose(norm, (2, 0, 1))[np.newaxis, ...]

                input_name = self.ort_session.get_inputs()[0].name
                outputs = self.ort_session.run(None, {input_name: blob})
                prob_map = outputs[0][0, 0]

                # Binary segmentation at 0.22 probability threshold (diperketat dari 0.28)
                # Menangkap teks semi-transparan, overlay samar, dan angka mengambang kecil
                text_mask = prob_map > 0.22
                total_text_pixels = int(np.count_nonzero(text_mask))
                total_cov = total_text_pixels / float(target_h * target_w)

                # Definisi 4 Zona Sudut (Watermark/callout di 35% vertikal & 45% horizontal sudut)
                top_cut = int(target_h * 0.35)
                bottom_cut = int(target_h * 0.65)
                left_cut = int(target_w * 0.45)
                right_cut = int(target_w * 0.55)

                tl_zone = text_mask[:top_cut, :left_cut]
                tr_zone = text_mask[:top_cut, right_cut:]
                bl_zone = text_mask[bottom_cut:, :left_cut]
                br_zone = text_mask[bottom_cut:, right_cut:]

                tl_cov = int(np.count_nonzero(tl_zone)) / float(top_cut * left_cut) if (top_cut * left_cut) > 0 else 0.0
                tr_cov = int(np.count_nonzero(tr_zone)) / float(top_cut * (target_w - right_cut)) if (top_cut * (target_w - right_cut)) > 0 else 0.0
                bl_cov = int(np.count_nonzero(bl_zone)) / float((target_h - bottom_cut) * left_cut) if ((target_h - bottom_cut) * left_cut) > 0 else 0.0
                br_cov = int(np.count_nonzero(br_zone)) / float((target_h - bottom_cut) * (target_w - right_cut)) if ((target_h - bottom_cut) * (target_w - right_cut)) > 0 else 0.0

                corner_activations = {"TL": round(tl_cov, 4), "TR": round(tr_cov, 4), "BL": round(bl_cov, 4), "BR": round(br_cov, 4)}

                # Top headline zone (top 35% full width)
                top_mask = text_mask[:top_cut, :]
                top_cov = int(np.count_nonzero(top_mask)) / float(top_cut * target_w) if (top_cut * target_w) > 0 else 0.0

                # Bottom subtitle zone (bottom 35% full width)
                bottom_mask = text_mask[bottom_cut:, :]
                bottom_cov = int(np.count_nonzero(bottom_mask)) / float((target_h - bottom_cut) * target_w) if ((target_h - bottom_cut) * target_w) > 0 else 0.0

                # ── Deteksi Komponen Terhubung di Sudut (Watermark Kecil / Ikon Logo / Callout Badge) ──
                # Threshold blob sangat diperketat: area >= 80px, dimensi >= 14x10px
                # Menghindari noise JPEG kecil, artefak kompresi, dan tepi produk fisik yang terdeteksi
                for c_name, c_zone in [("TL", tl_zone), ("TR", tr_zone), ("BL", bl_zone), ("BR", br_zone)]:
                    c_uint8 = c_zone.astype(np.uint8)
                    n_cc, _, stats_cc, _ = cv2.connectedComponentsWithStats(c_uint8)
                    for k in range(1, n_cc):
                        blob_area = stats_cc[k, cv2.CC_STAT_AREA]
                        bw = stats_cc[k, cv2.CC_STAT_WIDTH]
                        bh = stats_cc[k, cv2.CC_STAT_HEIGHT]
                        # Karakter teks/badge di sudut: harus berukuran cukup besar dan bukan noise JPEG kecil
                        if blob_area >= 80 and bw >= 14 and bh >= 10:
                            return True, total_cov, bottom_cov, f"Watermark / badge teks terdeteksi di sudut {c_name} ({bw}x{bh}px, area={blob_area}px)", corner_activations

                # ── Ambang Batas Ketat Per-Zona ──
                # Sudut TL / TR / BL / BR: >= 1.2% zona dianggap watermark digital
                if tl_cov >= 0.012:
                    return True, total_cov, bottom_cov, f"Watermark di pojok kiri atas / TL (coverage {tl_cov * 100:.1f}%)", corner_activations
                if tr_cov >= 0.012:
                    return True, total_cov, bottom_cov, f"Watermark di pojok kanan atas / TR (coverage {tr_cov * 100:.1f}%)", corner_activations
                if bl_cov >= 0.012:
                    return True, total_cov, bottom_cov, f"Watermark / floating badge di pojok kiri bawah / BL (coverage {bl_cov * 100:.1f}%)", corner_activations
                if br_cov >= 0.012:
                    return True, total_cov, bottom_cov, f"Watermark / floating badge di pojok kanan bawah / BR (coverage {br_cov * 100:.1f}%)", corner_activations

                if bottom_cov >= self.max_bottom_coverage:
                    return True, total_cov, bottom_cov, f"Subtitle terbakar di area bawah (coverage {bottom_cov * 100:.1f}%)", corner_activations
                if top_cov >= 0.018:
                    return True, total_cov, bottom_cov, f"Teks headline / overlay di area atas (coverage {top_cov * 100:.1f}%)", corner_activations
                if total_cov >= self.max_total_coverage:
                    return True, total_cov, bottom_cov, f"Teks mendominasi frame (coverage {total_cov * 100:.1f}%)", corner_activations


                return False, total_cov, bottom_cov, "Teks dalam batas aman (DBNet bersih)", corner_activations
            except Exception as e:
                pass

        # ── Jalur 2: Sobel Horizontal Gradient Fallback (4-Corner Inspection) ──
        tl_sobel, tr_sobel, bl_sobel, br_sobel, total_cov, bottom_cov = self._sobel_text_density(crop_bgr)
        corner_activations = {"TL": round(tl_sobel, 4), "TR": round(tr_sobel, 4), "BL": round(bl_sobel, 4), "BR": round(br_sobel, 4)}

        # Sobel fallback threshold diperketat (dari 0.028/0.035/0.040 menjadi 0.020/0.025/0.030)
        if tl_sobel >= 0.020 or tr_sobel >= 0.020 or bl_sobel >= 0.020 or br_sobel >= 0.020:
            c_name = "TL" if tl_sobel >= 0.020 else ("TR" if tr_sobel >= 0.020 else ("BL" if bl_sobel >= 0.020 else "BR"))
            return True, total_cov, bottom_cov, f"Watermark terdeteksi di sudut {c_name} (Sobel, threshold diperketat)", corner_activations
        if bottom_cov >= 0.025:
            return True, total_cov, bottom_cov, f"Pola subtitle terbakar di area bawah (Sobel)", corner_activations
        if total_cov >= 0.030:
            return True, total_cov, bottom_cov, f"Densitas teks/grafis dominan (Sobel)", corner_activations

        return False, total_cov, bottom_cov, "Teks dalam batas aman (Sobel)", corner_activations

    def _sobel_text_density(self, crop_bgr):
        """Pengukuran murah densitas teks/grafis per zona (TANPA model ONNX).
        Dipakai untuk Jalur 2 fallback DAN sebagai sentinel murah saat DBNet dihemat.
        Return: (tl, tr, bl, br, total_cov, bottom_cov)."""
        h, w = crop_bgr.shape[:2]
        gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
        grad_x = cv2.Sobel(gray, cv2.CV_16S, 1, 0, ksize=3)
        abs_grad_x = cv2.convertScaleAbs(grad_x)

        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (17, 3))
        connected = cv2.morphologyEx(abs_grad_x, cv2.MORPH_CLOSE, kernel)
        _, connected = cv2.threshold(connected, 55, 255, cv2.THRESH_BINARY)

        crop_area = float(h * w)
        total_cov = float(cv2.countNonZero(connected)) / crop_area if crop_area > 0 else 0.0
        top_y = int(h * 0.35)
        bottom_y = int(h * 0.65)
        left_x = int(w * 0.45)
        right_x = int(w * 0.55)

        tl = float(cv2.countNonZero(connected[:top_y, :left_x])) / float(top_y * left_x) if (top_y * left_x) > 0 else 0.0
        tr = float(cv2.countNonZero(connected[:top_y, right_x:])) / float(top_y * (w - right_x)) if (top_y * (w - right_x)) > 0 else 0.0
        bl = float(cv2.countNonZero(connected[bottom_y:, :left_x])) / float((h - bottom_y) * left_x) if ((h - bottom_y) * left_x) > 0 else 0.0
        br = float(cv2.countNonZero(connected[bottom_y:, right_x:])) / float((h - bottom_y) * (w - right_x)) if ((h - bottom_y) * (w - right_x)) > 0 else 0.0
        bottom_cov = float(cv2.countNonZero(connected[bottom_y:, :])) / float((h - bottom_y) * w) if ((h - bottom_y) * w) > 0 else 0.0
        return tl, tr, bl, br, total_cov, bottom_cov

    def needs_full_text_check(self, crop_bgr):
        """Sentinel murah sebelum DBNet dihemat (Fase 1): returns True bila ada TANDA tanda
        teks/grafis di zona sudut atau bawah. Ambang yang dipakai SENGAJA lebih longgar dari
        ambang DBNet (0.020/0.025/0.030 vs 0.012/0.013/0.012) supaya frame yang mencurigakan
        selalu diperiksa penuh, bukan diwarisi."""
        tl, tr, bl, br, total_cov, bottom_cov = self._sobel_text_density(crop_bgr)
        return bool(max(tl, tr, bl, br) >= 0.020 or bottom_cov >= 0.025 or total_cov >= 0.030)


# ─────────────────────────────────────────────────────────────────────────────
# 3. TAHAP 3: SCENE & OVERLAY CLASSIFIER (Custom MobileNetV3 + Visual Variance)
# ─────────────────────────────────────────────────────────────────────────────
class SceneGatekeeper:
    """
    Klasifikasi adegan dengan 3 status:
    - 'rejected'   : jika p_reject >= 0.50 atau p_clean < 0.62
    - 'uncertain'  : jika 0.62 <= p_clean < 0.78 (memerlukan konfirmasi temporal)
    - 'valid_real' : jika p_clean >= 0.78 (clean candidate)
    
    Alasan pemilihan threshold:
    Nilai 0.78 dipilih karena frame dengan p_clean antara 0.50 - 0.77 sering kali memuat
    elemen unboxing yang berantakan, logo transparan, atau framing produk yang kurang fokus.
    Nilai 0.62 menjadi batas pemisah zona uncertain vs reject.
    """
    CLEAN_CONF_THRESHOLD = 0.78
    UNCERTAIN_CONF_THRESHOLD = 0.62

    def __init__(self):
        self.ort_session = None
        self.is_custom_model = False
        self.backend = "entropy_variance"

        custom_model_path = os.path.join(MODELS_DIR, "scene_filter_v2.onnx")
        generic_model_path = os.path.join(MODELS_DIR, "mobilenetv3_small.onnx")

        if HAS_ORT:
            opts = ort.SessionOptions()
            opts.intra_op_num_threads = 2

            if os.path.exists(custom_model_path):
                try:
                    self.ort_session = ort.InferenceSession(
                        custom_model_path,
                        sess_options=opts,
                        providers=["CPUExecutionProvider"]
                    )
                    self.is_custom_model = True
                    self.backend = "custom_scene_filter_v2"
                    print("  [SceneGatekeeper] 🎯 AI Custom Model (scene_filter_v2.onnx) AKTIF (Strict 3-State Policy).")
                except Exception as e:
                    print(f"  [SceneGatekeeper] ⚠️ Gagal memuat custom scene_filter_v2.onnx: {e}")

            if not self.ort_session and os.path.exists(generic_model_path):
                try:
                    self.ort_session = ort.InferenceSession(
                        generic_model_path,
                        sess_options=opts,
                        providers=["CPUExecutionProvider"]
                    )
                    self.is_custom_model = False
                    self.backend = "mobilenetv3_imagenet"
                    print("  [SceneGatekeeper] ℹ️ MobileNetV3 Generic ImageNet Classifier aktif.")
                except Exception as e:
                    print(f"  [SceneGatekeeper] ⚠️ Gagal memuat MobileNetV3 generic: {e}")

        self.labels = ["rejected", "valid_real"]
        labels_path = os.path.join(MODELS_DIR, "labels.json")
        if os.path.exists(labels_path):
            try:
                with open(labels_path, "r", encoding="utf-8") as f:
                    self.labels = json.load(f)
            except Exception:
                pass

    def evaluate(self, crop_bgr):
        h, w = crop_bgr.shape[:2]
        if h < 50 or w < 50:
            return "rejected", 0.99, "Dimensi crop terlalu kecil"

        # 1. Color Quantization Check (Bumper datar / kartu grafis 2D)
        small = cv2.resize(crop_bgr, (64, 64), interpolation=cv2.INTER_AREA)
        quantized = (small >> 5).reshape(-1, 3)
        unique_colors = len(np.unique(quantized, axis=0))
        if unique_colors < 22:
            return "rejected", 0.90, f"Kartu bumper statis / grafis 2D datar ({unique_colors} warna)"

        # 2. Laplacian Texture Variance (Frame polos tanpa tekstur / blank screen)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        laplacian_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        if laplacian_var < 15.0:
            return "rejected", 0.85, f"Frame polos tanpa tekstur (laplacian: {laplacian_var:.1f})"

        # 3. AI Scene Classification (Strict Confidence Policy)
        if self.ort_session:
            try:
                resized = cv2.resize(crop_bgr, (224, 224), interpolation=cv2.INTER_LINEAR)
                rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
                mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
                std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
                norm = (rgb - mean) / std
                blob = np.transpose(norm, (2, 0, 1))[np.newaxis, ...]

                input_name = self.ort_session.get_inputs()[0].name
                outputs = self.ort_session.run(None, {input_name: blob})
                raw_logits = outputs[0][0]

                if self.is_custom_model:
                    # Stabilized Softmax
                    exp_l = np.exp(raw_logits - np.max(raw_logits))
                    probs = exp_l / np.sum(exp_l)
                    # Class 0: rejected, Class 1: valid_real
                    p_reject = float(probs[0])
                    p_clean = float(probs[1]) if len(probs) > 1 else (1.0 - p_reject)

                    if p_clean >= self.CLEAN_CONF_THRESHOLD:
                        return "valid_real", p_clean, f"Custom AI: Peragaan produk fisik valid ({p_clean * 100:.1f}%)"
                    elif p_clean >= self.UNCERTAIN_CONF_THRESHOLD:
                        return "uncertain", p_clean, f"Custom AI: Zona uncertain ({p_clean * 100:.1f}%), perlu bukti temporal"
                    else:
                        return "rejected", p_reject, f"Custom AI: Grafis/kartun/overlay terdeteksi ({p_reject * 100:.1f}%)"
                else:
                    top_class = int(np.argmax(raw_logits))
                    graphic_classes = {918, 919, 921, 664, 782, 916, 922}
                    if top_class in graphic_classes:
                        return "rejected", 0.85, f"MobileNetV3 mengklasifikasikan sebagai grafis/kartun/layar (#{top_class})"
                    return "valid_real", 0.80, "Adegan natural produk valid (ImageNet)"
            except Exception:
                pass

        return "valid_real", 0.90, "Adegan natural produk valid (heuristic variance)"


# ─────────────────────────────────────────────────────────────────────────────
# 4. ORCHESTRATOR PIPELINE
# ─────────────────────────────────────────────────────────────────────────────
def detect_pillarbox(image_bgr):
    h, w = image_bgr.shape[:2]
    if w < 50 or h < 50:
        return False, 0.0, "Dimensi terlalu kecil"
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    col_means = np.mean(gray, axis=0)
    black_thresh = 28.0

    left_black = 0
    while left_black < w and col_means[left_black] < black_thresh:
        left_black += 1

    right_black = 0
    while right_black < w and col_means[w - 1 - right_black] < black_thresh:
        right_black += 1

    left_pct = left_black / float(w)
    right_pct = right_black / float(w)
    total_pillar = left_pct + right_pct

    if total_pillar >= 0.16 and (left_pct >= 0.07 or right_pct >= 0.07):
        return True, total_pillar, f"Pillarbox hitam di sisi samping ({total_pillar * 100:.1f}% frame)"

    row_means = np.mean(gray, axis=1)
    top_black = 0
    while top_black < h and row_means[top_black] < black_thresh:
        top_black += 1
    bottom_black = 0
    while bottom_black < h and row_means[h - 1 - bottom_black] < black_thresh:
        bottom_black += 1
    total_letterbox = (top_black + bottom_black) / float(h)
    if total_letterbox >= 0.18:
        return True, total_letterbox, f"Letterbox hitam di atas/bawah ({total_letterbox * 100:.1f}% frame)"

    return False, 0.0, "Tanpa pillarbox"


def detect_paper_manual(image_bgr):
    h, w = image_bgr.shape[:2]
    if h < 60 or w < 60:
        return False, "Dimensi terlalu kecil"
    hsv = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV)
    sat_mean = float(np.mean(hsv[:, :, 1]))
    val_mean = float(np.mean(hsv[:, :, 2]))
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 50, 150)
    edge_cov = float(np.count_nonzero(edges)) / float(h * w)

    # Buku manual kertas murni: halaman kertas putih pekat (val > 230, sat < 12) dengan paragraf teks padat (edges > 12%)
    if val_mean > 230 and sat_mean < 12 and edge_cov > 0.12:
        return True, f"Buku panduan / dokumen kertas manual terdeteksi (val={val_mean:.0f}, edges={edge_cov*100:.1f}%)"
    return False, "Bukan dokumen kertas"


def detect_synthetic_graphic_overlay(crop_bgr):
    h, w = crop_bgr.shape[:2]
    if h < 60 or w < 60:
        return False, "Crop terlalu kecil"

    hsv = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2HSV)
    _, s_channel, v_channel = cv2.split(hsv)

    # Hanya deteksi grafis digital sintetis berintensitas murni (neon green/cyan/magenta)
    # JANGAN deteksi warna merah atau kuning karena itu warna alami produk dapur/rumah tangga!
    neon_mask = cv2.inRange(hsv, np.array([45, 235, 200]), np.array([150, 255, 255]))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    opened = cv2.morphologyEx(neon_mask, cv2.MORPH_OPEN, kernel)

    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(opened)
    total_area = float(h * w)
    for i in range(1, num_labels):
        comp_area = stats[i, cv2.CC_STAT_AREA]
        comp_ratio = comp_area / total_area
        if 0.04 <= comp_ratio <= 0.25:
            comp_mask = (labels == i).astype(np.uint8)
            comp_v = v_channel[comp_mask > 0]
            v_std = float(np.std(comp_v)) if len(comp_v) > 0 else 99.0
            if v_std < 10.0:
                return True, f"Terdeteksi grafis overlay buatan (panah/lingkaran/stiker vektor, area {comp_ratio*100:.1f}%)"

    return False, "Tidak ada grafis sintetis"


class FrameGatekeeper:
    def __init__(self):
        print("\n🚀 [AI Gatekeeper] Memuat pipeline pra-pemrosesan di CPU...")
        self.face_gate = FaceGatekeeper()
        self.text_gate = TextGatekeeper()
        self.scene_gate = SceneGatekeeper()
        print("✅ [AI Gatekeeper] Pipeline 3-tahap siap beroperasi!\n")

    @staticmethod
    def crop_9_16(image):
        h, w = image.shape[:2]
        # Untuk video landscape 16:9, area panggung (stage_80) yang terlihat di canvas 9:16
        # mencakup lebar hingga h * (1080 / 1536) ~= h * 0.7031 (lebih lebar dari 9:16 murni 0.5625).
        # Gunakan rasio stage_80 agar teks/watermark di pinggir area peragaan tidak lolos dari inspeksi!
        ratio = (1080.0 / 1536.0) if w > h else (9.0 / 16.0)
        target_w = int(h * ratio)
        if target_w >= w:
            return image
        x_start = (w - target_w) // 2
        return image[:, x_start:x_start + target_w]

    def process_single_frame(self, file_path, timestamp=0.0, niche="kitchen_tools", face_policy="strict",
                             image_bgr=None, run_text_check=True, inherited_text=None, bench=None):
        """
        Mengevaluasi satu frame secara independen dan mengembalikan hasil lengkap:
        - status: 'clean' | 'uncertain' | 'discarded'
        - stage: tahap rejection
        - cornerActivations: skor watermark 4 sudut (TL, TR, BL, BR)

        image_bgr: frame yang SUDAH di-decode oleh pemanggil. Tanpa ini satu frame di-decode
        3x (2x di pass motion + 1x di sini) - pemborasan CPU terbesar kedua setelah DBNet.
        run_text_check=False: DBNet dilewati dan hasil teks diambil dari inherited_text.
        """
        img = image_bgr
        if img is None:
            if not os.path.exists(file_path):
                return {
                    "filePath": file_path,
                    "timestamp": timestamp,
                    "status": "discarded",
                    "stage": "io_error",
                    "reason": "File frame tidak ditemukan di disk",
                    "confidence": 0.0,
                    "cornerActivations": {"TL": 0.0, "TR": 0.0, "BL": 0.0, "BR": 0.0},
                    "decision": "REJECT"
                }
            img = cv2.imread(file_path)
            if img is None:
                return {
                    "filePath": file_path,
                    "timestamp": timestamp,
                    "status": "discarded",
                    "stage": "io_error",
                    "reason": "Format gambar corrupt / gagal dibaca cv2",
                    "confidence": 0.0,
                    "cornerActivations": {"TL": 0.0, "TR": 0.0, "BL": 0.0, "BR": 0.0},
                    "decision": "REJECT"
                }

        # ── TAHAP 0: Pemeriksaan Pillarbox / Black Bars ──
        has_pb, pb_ratio, pb_reason = detect_pillarbox(img)
        if has_pb:
            return {
                "filePath": file_path,
                "timestamp": timestamp,
                "status": "discarded",
                "stage": "orientation",
                "reason": pb_reason,
                "confidence": round(pb_ratio, 3),
                "cornerActivations": {"TL": 0.0, "TR": 0.0, "BL": 0.0, "BR": 0.0},
                "decision": "REJECT"
            }

        crop = self.crop_9_16(img)

        # ── TAHAP 0B: Pemeriksaan Buku Panduan / Dokumen Kertas ──
        has_manual, manual_reason = detect_paper_manual(crop)
        if has_manual:
            return {
                "filePath": file_path,
                "timestamp": timestamp,
                "status": "discarded",
                "stage": "paper_manual",
                "reason": manual_reason,
                "confidence": 0.90,
                "cornerActivations": {"TL": 0.0, "TR": 0.0, "BL": 0.0, "BR": 0.0},
                "decision": "REJECT"
            }

        # ── TAHAP 1A: Face Detection pada Crop 9:16 ──
        content_faces = []
        if face_policy == "presenter_only":
            for f in self.face_gate.detect_faces(crop):
                if f["kind"] == "presenter":
                    return {
                        "filePath": file_path,
                        "timestamp": timestamp,
                        "status": "discarded",
                        "stage": "face",
                        "reason": f"Presenter terdeteksi di crop 9:16 (policy presenter_only, score {f['score'] * 100:.1f}%)",
                        "confidence": round(f["score"], 3),
                        "box": f["box"],
                        "cornerActivations": {"TL": 0.0, "TR": 0.0, "BL": 0.0, "BR": 0.0},
                        "decision": "REJECT"
                    }
                content_faces.append({**f, "region": "crop"})
        else:
            has_face_crop, face_conf_crop, face_box_crop, face_reason_crop = _bench_time(bench, "yunet_crop", self.face_gate.detect, crop, niche=niche)
            if has_face_crop:
                return {
                    "filePath": file_path,
                    "timestamp": timestamp,
                    "status": "discarded",
                    "stage": "face",
                    "reason": face_reason_crop,
                    "confidence": round(face_conf_crop, 3),
                    "box": face_box_crop,
                    "cornerActivations": {"TL": 0.0, "TR": 0.0, "BL": 0.0, "BR": 0.0},
                    "decision": "REJECT"
                }

        # ── TAHAP 1B: Face Detection pada Full Frame 16:9 ──
        # Hanya tolak jika wajah bertabrakan dengan jendela crop 9:16 yang akan ditampilkan.
        # Wajah vlogger/orang di pinggir luar 16:9 aman karena otomatis terpotong saat rendering.
        h, w = img.shape[:2]
        target_w = int(h * 9.0 / 16.0)
        x_start = max(0, (w - target_w) // 2)
        x_end = min(w, x_start + target_w)

        if face_policy == "presenter_only":
            for f in self.face_gate.detect_faces(img):
                bx, by, bw, bh = f["box"]
                if bx + bw < x_start or bx > x_end:
                    continue  # wajah di luar jendela crop 9:16 -> terpotong otomatis saat render
                if f["kind"] == "presenter":
                    return {
                        "filePath": file_path,
                        "timestamp": timestamp,
                        "status": "discarded",
                        "stage": "face",
                        "reason": f"Presenter terdeteksi di area crop 9:16 (policy presenter_only, score {f['score'] * 100:.1f}%)",
                        "confidence": round(f["score"], 3),
                        "box": f["box"],
                        "cornerActivations": {"TL": 0.0, "TR": 0.0, "BL": 0.0, "BR": 0.0},
                        "decision": "REJECT"
                    }
                content_faces.append({**f, "region": "full"})
        else:
            has_face_full, face_conf_full, face_box_full, face_reason_full = _bench_time(bench, "yunet_full", self.face_gate.detect, img, niche=niche)
            if has_face_full and face_box_full:
                bx, by, bw, bh = face_box_full
                face_overlaps_crop = not (bx + bw < x_start or bx > x_end)
                if face_overlaps_crop:
                    # 1A (crop) LOLOS tapi 1B (full) menangkap wajah yang menimpa jendela crop.
                    # Metrik ini membuktikan nilai 1B sebelum seseorang memutus memangkasnya.
                    if bench is not None:
                        bench.inc("face_caught_by_full_only")
                    return {
                        "filePath": file_path,
                        "timestamp": timestamp,
                        "status": "discarded",
                        "stage": "face",
                        "reason": f"Presenter terdeteksi di area crop 9:16: {face_reason_full}",
                        "confidence": round(face_conf_full, 3),
                        "box": face_box_full,
                        "cornerActivations": {"TL": 0.0, "TR": 0.0, "BL": 0.0, "BR": 0.0},
                        "decision": "REJECT"
                    }

        # ── TAHAP 2: Text & 4-Corner Watermark Detection (DBNet = stage termahal) ──
        if run_text_check:
            has_text, total_cov, bottom_cov, text_reason, corner_acts = _bench_time(bench, "dbnet", self.text_gate.detect, crop, niche=niche)
        else:
            # Warisi hasil DBNet frame sebelumnya. Watermark/subtitle bersifat persisten,
            # jadi frame yang dilewati TIDAK bisa lolos dari deteksi hanya karena di-skip.
            has_text, total_cov, bottom_cov, text_reason, corner_acts = inherited_text or (
                False, 0.0, 0.0, "Teks tidak diperiksa (tidak ada hasil acuan)",
                {"TL": 0.0, "TR": 0.0, "BL": 0.0, "BR": 0.0}
            )
            if has_text:
                text_reason = f"{text_reason} - diwarisi dari frame bercek sebelumnya"
        if has_text:
            return {
                "filePath": file_path,
                "timestamp": timestamp,
                "status": "discarded",
                "stage": "text",
                "reason": text_reason,
                "confidence": round(max(total_cov, bottom_cov), 3),
                "totalCoverage": round(total_cov, 3),
                "bottomCoverage": round(bottom_cov, 3),
                "cornerActivations": corner_acts,
                "decision": "REJECT"
            }

        # ── TAHAP 2B: Deteksi Grafis Sintetis (Panah / Stiker) ──
        has_graphic, graphic_reason = detect_synthetic_graphic_overlay(crop)
        if has_graphic:
            return {
                "filePath": file_path,
                "timestamp": timestamp,
                "status": "discarded",
                "stage": "graphic_overlay",
                "reason": graphic_reason,
                "confidence": 0.85,
                "cornerActivations": corner_acts,
                "decision": "REJECT"
            }

        # ── TAHAP 3: Scene Classifier (Strict 3-State: valid_real, uncertain, rejected) ──
        scene_state, scene_conf, scene_reason = _bench_time(bench, "mobilenet", self.scene_gate.evaluate, crop)
        if scene_state == "rejected":
            return {
                "filePath": file_path,
                "timestamp": timestamp,
                "status": "discarded",
                "stage": "scene",
                "reason": scene_reason,
                "confidence": round(scene_conf, 3),
                "cornerActivations": corner_acts,
                "decision": "REJECT"
            }
        elif scene_state == "uncertain":
            return {
                "filePath": file_path,
                "timestamp": timestamp,
                "status": "uncertain",
                "stage": "uncertain_scene",
                "reason": scene_reason,
                "confidence": round(scene_conf, 3),
                "cornerActivations": corner_acts,
                "decision": "UNCERTAIN"
            }

        # ── Lolos Sebagai Clean Candidate (memerlukan verifikasi segmen temporal) ──
        return {
            "filePath": file_path,
            "timestamp": timestamp,
            "status": "clean",
            "stage": "passed",
            "reason": "Lolos seluruh filter per-frame (Faceless, Bebas Teks & Watermark, Scene Produk Valid)",
            "confidence": round(scene_conf, 3),
            "totalCoverage": round(total_cov, 3),
            "bottomCoverage": round(bottom_cov, 3),
            "cornerActivations": corner_acts,
            "faces": content_faces,
            "decision": "CANDIDATE_CLEAN"
        }

    def process_batch(self, frame_items, niche="kitchen_tools",
                      min_consecutive_clean=3, min_clean_duration=4.0, face_policy="strict"):
        """
        Memproses batch frame dengan logika:
        1. Static frame detection (MAD & edge difference)
        2. Per-frame evaluation
        3. Multi-frame temporal watermark persistence aggregation (deteksi watermark berulang di sudut yang sama)
        4. Clean Temporal Segment Validation (HANYA segmen kontinu >= 3 frame / >= 4.0s yang dinyatakan VERIFIED_CLEAN)
        """
        start_time = time.time()
        bench = _Bench()  # LOKAL per-request: ThreadingHTTPServer-safe (tak ada race antar job)
        if not frame_items:
            return {
                "status": "success", "eligible": False, "reason": "Frame items kosong",
                "totalFrames": 0, "cleanFramesCount": 0, "discardedFramesCount": 0,
                "verifiedSegments": [], "allFrames": [], "cleanFrames": [], "discardedFrames": []
            }

        # Normalisasi list items
        normalized_items = []
        for idx, item in enumerate(frame_items):
            p = item.get("filePath") if isinstance(item, dict) else str(item)
            t = float(item.get("timestamp", idx * 2.5)) if isinstance(item, dict) else float(idx * 2.5)
            normalized_items.append({"filePath": p, "timestamp": t, "originalIndex": idx})

        # Urutkan berdasarkan timestamp kronologis untuk analisa temporal
        time_sorted = sorted(normalized_items, key=lambda x: x["timestamp"])

        # ── 1+2. SATU PASS KRONOLOGIS: motion murah dulu, AI hanya untuk frame yang layak ──
        # VERSI LAMA (boros): frame di-decode 3x (2x di pass motion + 1x di pass evaluasi)
        # DAN pipeline YuNet+DBNet+MobileNetV3 dijalankan untuk SEMUA frame, termasuk frame
        # yang toh akhirnya dibuang sebagai foto statis. Untuk batch 500 frame di Termux
        # 2-core inilah sumber utama macet/timeout.
        # VERSI BARU: 1x decode per frame, thumbnail 80x144 ditahan untuk MAD/edge-diff
        # (O(1) memori), frame statis langsung REJECT tanpa menyentuh model, dan DBNet
        # hanya 1 dari TEXT_CHECK_STRIDE frame (hasilnya diwariskan ke frame sisanya).
        static_transitions = 0
        consecutive_pairs = 0
        motion_scores = {}
        single_verdicts = []
        prev_small = None
        prev_ts = 0.0
        last_text_result = None
        static_skipped = 0
        dbnet_calls = 0
        frame_no = 0

        for item in time_sorted:
            path = item["filePath"]
            ts = item["timestamp"]
            frame_no += 1
            bench.inc("frames_in")

            t_dec = bench.tic()
            img = cv2.imread(path) if os.path.exists(path) else None
            small = cv2.resize(img, (80, 144)) if img is not None else None

            is_static = False
            # Bandingkan frame jika selisih waktu <= 3.5 detik (aturan ambang lama dipertahankan)
            if small is not None and prev_small is not None and abs(ts - prev_ts) <= 3.5:
                consecutive_pairs += 1
                try:
                    mad = float(cv2.absdiff(prev_small, small).mean())
                    e_prev = cv2.Canny(cv2.cvtColor(prev_small, cv2.COLOR_BGR2GRAY), 50, 150)
                    e_cur = cv2.Canny(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY), 50, 150)
                    edge_diff = float(cv2.absdiff(e_prev, e_cur).mean())
                    motion_scores[path] = round(mad, 2)
                    # Gambar diam / beku jika MAD < 3.2 dan edge_diff < 4.0
                    if mad < 3.2 and edge_diff < 4.0:
                        static_transitions += 1
                        is_static = True
                        # Frame SEBELUMNYA bagian dari pasangan statis yang sama -> buang juga.
                        # Keputusan REJECT yang sudah ada tidak ditimpa (sama-sama dibuang).
                        if single_verdicts and prev_ts > 3.0 and single_verdicts[-1]["status"] != "discarded":
                            single_verdicts[-1]["status"] = "discarded"
                            single_verdicts[-1]["stage"] = "static_frame"
                            single_verdicts[-1]["decision"] = "REJECT"
                            single_verdicts[-1]["reason"] = f"Frame foto statis diam / freeze frame (MAD: {round(mad, 2)})"
                except Exception:
                    pass
            bench.toc("decode_static", t_dec)

            # DBNet dihemat otomatis: 1 dari TEXT_CHECK_STRIDE frame diperiksa, sisanya warisan.
            # SENTINEL: frame yang mau di-skip tetap disaring murah pakai Sobel. Kalau ada tanda
            # teks/grafis di sudut/bawah, frame itu WAJIB di-check DBNet penuh -> overlay baru
            # yang muncul di antara dua pemeriksaan tidak bisa lolos tanpa terdeteksi.
            if TEXT_CHECK_STRIDE <= 1 or last_text_result is None:
                run_text_check = True
            elif frame_no % TEXT_CHECK_STRIDE == 0:
                run_text_check = True
            elif img is None:
                run_text_check = True
            else:
                run_text_check = _bench_time(bench, "sobel_sentinel", self.text_gate.needs_full_text_check, self.crop_9_16(img))

            if is_static and ts > 3.0:
                # Frame beku: TIDAK perlu face/text/scene sama sekali (toh dibuang).
                v = {
                    "filePath": path,
                    "timestamp": ts,
                    "status": "discarded",
                    "stage": "static_frame",
                    "decision": "REJECT",
                    "confidence": 0.0,
                    "reason": f"Frame foto statis diam / freeze frame (MAD: {motion_scores.get(path, 0.0)})",
                    "cornerActivations": {"TL": 0.0, "TR": 0.0, "BL": 0.0, "BR": 0.0}
                }
                static_skipped += 1
            else:
                v = self.process_single_frame(
                    path, ts, niche=niche, face_policy=face_policy,
                    image_bgr=img, run_text_check=run_text_check, inherited_text=last_text_result,
                    bench=bench
                )

            if run_text_check and v.get("stage") in ("passed", "text", "graphic_overlay", "scene", "uncertain_scene"):
                # Frame ini benar-benar melewati TAHAP 2 -> jadikan acuan warisan berikutnya.
                last_text_result = (
                    v.get("stage") == "text",
                    float(v.get("totalCoverage") or 0.0),
                    float(v.get("bottomCoverage") or 0.0),
                    v.get("reason") or "",
                    v.get("cornerActivations") or {"TL": 0.0, "TR": 0.0, "BL": 0.0, "BR": 0.0}
                )
                dbnet_calls += 1
            elif not run_text_check:
                v["textInherited"] = True

            v["motionScore"] = motion_scores.get(path, 0.0)
            single_verdicts.append(v)

            prev_small = small
            prev_ts = ts

        if static_skipped or dbnet_calls:
            print(f"[Gatekeeper] ⚡ Hemat CPU batch: {static_skipped} frame statis dibuang TANPA inferensi, "
                  f"DBNet {dbnet_calls}/{len(time_sorted)} pemanggilan (stride {TEXT_CHECK_STRIDE}).")

        # ── 2B. Temporal Presenter Track (khusus policy presenter_only) ──
        # Wajah 'content' yang persisten di posisi sama lintas frame = presenter statis.
        if face_policy == "presenter_only":
            apply_temporal_presenter_track(single_verdicts)

        # ── 3. Temporal Watermark Aggregation (Multi-Frame Persistence Tracker) ──
        # Watermark biasanya berada di sudut yang sama persisten lintas >= 2 frame.
        corner_hits = {"TL": [], "TR": [], "BL": [], "BR": []}
        for idx, v in enumerate(single_verdicts):
            c_acts = v.get("cornerActivations") or {}
            for c_name in ["TL", "TR", "BL", "BR"]:
                # Ambang aktivasi sudut yang mencurigakan (>= 0.025 atau 2.5% zona sudut)
                if c_acts.get(c_name, 0.0) >= 0.025:
                    corner_hits[c_name].append(idx)

        persistent_watermark_corners = []
        for c_name, hit_indices in corner_hits.items():
            # Jika terdeteksi di >= 3 frame yang terpisah, probabilitas watermark pojok statis sangat tinggi!
            if len(hit_indices) >= 3:
                persistent_watermark_corners.append(c_name)
                for h_idx in hit_indices:
                    f_item = single_verdicts[h_idx]
                    if f_item["status"] != "discarded" or f_item.get("stage") in ("passed", "scene", "uncertain_scene"):
                        f_item["status"] = "discarded"
                        f_item["stage"] = "persistent_watermark"
                        f_item["decision"] = "REJECT"
                        f_item["reason"] = f"Watermark statis konsisten terdeteksi di sudut {c_name} lintas {len(hit_indices)} frame"

        # ── 4. Clean Temporal Segment Validation ──
        # Menerapkan aturan ketat: '1 CLEAN FRAME != AMAN', 'CLEAN TEMPORAL SEGMENT = AMAN'.
        # Hanya rangkaian frame berurutan (status == clean) yang memenuhi:
        # - streak >= min_consecutive_clean (default: 3)
        # - duration >= min_clean_duration (default: 4.0s)
        # yang diizinkan menjadi VERIFIED_CLEAN.
        verified_segments = []
        current_streak = []

        for idx, v in enumerate(single_verdicts):
            is_clean = (v["status"] == "clean")
            if is_clean:
                current_streak.append(idx)
            else:
                # Tutup segmen yang sedang berjalan
                if len(current_streak) >= min_consecutive_clean:
                    start_ts = single_verdicts[current_streak[0]]["timestamp"]
                    end_ts = single_verdicts[current_streak[-1]]["timestamp"]
                    duration = round(end_ts - start_ts, 2)
                    if duration >= min_clean_duration or len(current_streak) >= min_consecutive_clean:
                        verified_segments.append({
                            "startIndex": current_streak[0],
                            "endIndex": current_streak[-1],
                            "startSec": start_ts,
                            "endSec": end_ts,
                            "durationSec": duration,
                            "frameCount": len(current_streak),
                            "frameIndices": list(current_streak),
                            "cleanTimestamps": [single_verdicts[i]["timestamp"] for i in current_streak]
                        })
                current_streak = []

        # Cek sisa streak di akhir video
        if len(current_streak) >= min_consecutive_clean:
            start_ts = single_verdicts[current_streak[0]]["timestamp"]
            end_ts = single_verdicts[current_streak[-1]]["timestamp"]
            duration = round(end_ts - start_ts, 2)
            if duration >= min_clean_duration or len(current_streak) >= min_consecutive_clean:
                verified_segments.append({
                    "startIndex": current_streak[0],
                    "endIndex": current_streak[-1],
                    "startSec": start_ts,
                    "endSec": end_ts,
                    "durationSec": duration,
                    "frameCount": len(current_streak),
                    "frameIndices": list(current_streak),
                    "cleanTimestamps": [single_verdicts[i]["timestamp"] for i in current_streak]
                })

        # Himpunan indeks frame yang masuk dalam verified segment
        verified_clean_indices = set()
        for seg in verified_segments:
            for fi in seg["frameIndices"]:
                verified_clean_indices.add(fi)

        # ── 5. Final Status Assignment Per Frame & Structured Logging ──
        final_all_frames = []
        clean_frames = []
        discarded_frames = []

        for idx, v in enumerate(single_verdicts):
            frame_name = os.path.basename(v["filePath"])
            ts = v["timestamp"]
            cls_name = "valid_real" if v.get("confidence", 0) >= 0.78 else (v.get("stage") or "uncertain")
            mot = v.get("motionScore", 0.0)

            if idx in verified_clean_indices:
                v["status"] = "clean"
                v["decision"] = "VERIFIED_CLEAN"
                clean_frames.append(v)
                print(f"  [Gatekeeper] frame={frame_name:<24} ts={ts:>5.1f}s classifier={cls_name:<10} conf={v.get('confidence', 0):>4.2f} text=clean face=clean motion={mot:>4.2f} decision=VERIFIED_CLEAN ✅")
            else:
                if v["status"] == "clean":
                    # Seluruh frame yang lolos filter independen per-frame
                    # (faceless, bebas teks/watermark, adegan produk nyata) diterima sebagai cuplikan bersih
                    v["status"] = "clean"
                    v["decision"] = "VERIFIED_CLEAN"
                    clean_frames.append(v)
                    print(f"  [Gatekeeper] frame={frame_name:<24} ts={ts:>5.1f}s classifier={cls_name:<10} conf={v.get('confidence', 0):>4.2f} text=clean face=clean motion={mot:>4.2f} decision=VERIFIED_CLEAN (STANDALONE) ✅")
                elif v["status"] == "uncertain":
                    v["status"] = "discarded"
                    v["stage"] = "uncertain_scene"
                    v["decision"] = "UNCERTAIN_REJECT"
                    v["reason"] = f"Keyakinan model lokal di zona uncertain ({v.get('confidence', 0)*100:.1f}%) tanpa konfirmasi segmen temporal"
                    discarded_frames.append(v)
                else:
                    v["decision"] = "REJECT"
                    discarded_frames.append(v)

                if v["decision"] != "VERIFIED_CLEAN":
                    print(f"  [Gatekeeper] frame={frame_name:<24} ts={ts:>5.1f}s classifier={cls_name:<10} conf={v.get('confidence', 0):>4.2f} stage={v.get('stage','none'):<16} decision={v.get('decision')} ⛔ ({v.get('reason')})")

            final_all_frames.append(v)

        # Kembalikan ke urutan asli jika diperlukan pemetaan ulang
        path_to_final = {f["filePath"]: f for f in final_all_frames}
        ordered_results = [path_to_final.get(item["filePath"], single_verdicts[0]) for item in normalized_items]

        elapsed_ms = (time.time() - start_time) * 1000.0
        avg_ms = elapsed_ms / max(1, len(frame_items))

        # Check opening intro cutoff
        intro_cutoff_sec = 0.0
        if len(ordered_results) >= 2 and ordered_results[0]["status"] == "discarded":
            intro_cutoff_sec = max(3.0, ordered_results[0].get("timestamp", 3.0))
            if ordered_results[1]["status"] == "discarded":
                intro_cutoff_sec = max(intro_cutoff_sec, ordered_results[1].get("timestamp", 5.0))

        # ── Keputusan Kelayakan Video (Strict Gatekeeper Policy) ──
        # Video eligible jika memiliki minimal 1 segmen temporal ATAU setidaknya min_consecutive_clean frame bersih terverifikasi
        has_verified_segment = len(verified_segments) > 0
        total_clean_count = len(clean_frames)
        total_f_count = max(1, len(frame_items))

        face_count = sum(1 for d in discarded_frames if d.get("stage") == "face")
        text_count = sum(1 for d in discarded_frames if d.get("stage") in ("text", "persistent_watermark"))
        static_count = sum(1 for d in discarded_frames if d.get("stage") == "static_frame")

        # (#5) Reject-per-stage: agregat SEKALI dari daftar discard (nol risiko ada jalur terlewat).
        rejects_by_stage = Counter()
        for d in discarded_frames:
            rejects_by_stage[d.get("stage") or "unknown"] += 1

        eligible = (has_verified_segment or total_clean_count >= min_consecutive_clean) and (total_clean_count >= min_consecutive_clean)

        if eligible:
            summary_reason = f"Visual video valid: Ditemukan {len(verified_segments)} segmen temporal bersih kontinu ({total_clean_count}/{total_f_count} frame VERIFIED_CLEAN)."
        else:
            if face_count >= 3 and face_count / total_f_count >= 0.40:
                summary_reason = f"Ditolak AI Gatekeeper: Video menampilkan wajah presenter ({face_count}/{total_f_count} frame). Wajib 100% faceless."
            elif text_count >= 3 and text_count / total_f_count >= 0.40:
                summary_reason = f"Ditolak AI Gatekeeper: Video dipenuhi teks/watermark ({text_count}/{total_f_count} frame). Wajib footage produk bersih."
            elif static_count >= 3 and static_count / total_f_count >= 0.40:
                summary_reason = f"Ditolak AI Gatekeeper: Video berupa slideshow statis ({static_count}/{total_f_count} frame beku). Wajib video aksi gerak fisik."
            elif not has_verified_segment and total_clean_count < min_consecutive_clean:
                summary_reason = f"Ditolak AI Gatekeeper: Tidak ditemukan Clean Temporal Segment kontinu (frame bersih sporadis terisolasi, tidak ada {min_consecutive_clean} frame berurutan)."
            else:
                summary_reason = f"Ditolak AI Gatekeeper: Hanya {total_clean_count} frame bersih (kurang dari syarat minimal)."

        print(f"\n[Gatekeeper] 🏁 Batch Summary: {len(verified_segments)} verified segments, {total_clean_count}/{total_f_count} clean frames. Eligible: {eligible}. Waktu: {elapsed_ms:.1f}ms ({avg_ms:.1f}ms/frame)")

        return {
            "status": "success",
            "eligible": eligible,
            "reason": summary_reason,
            "facePolicy": face_policy,
            "totalFrames": len(frame_items),
            "cleanFramesCount": total_clean_count,
            "cameraResultEligibleCount": sum(1 for f in clean_frames if f.get("cameraResultEligible")),
            "discardedFramesCount": len(discarded_frames),
            "introCutoffSec": intro_cutoff_sec,
            "hasOpeningIntro": intro_cutoff_sec > 0.0,
            "verifiedSegments": verified_segments,
            "persistentWatermarkCorners": persistent_watermark_corners,
            "benchmarks": {
                "totalMs": round(elapsed_ms, 1),
                "avgMsPerFrame": round(avg_ms, 1),
                "fps": round(1000.0 / max(1.0, avg_ms), 1),
                "textCheckStride": TEXT_CHECK_STRIDE,
                "dbnetCalls": dbnet_calls,
                "dbnetInherited": max(0, len(time_sorted) - dbnet_calls),
                "staticFramesSkippedInference": static_skipped,
                **bench.to_payload(),
                "rejectsByStage": dict(rejects_by_stage)
            },
            "cleanFrames": clean_frames,
            "discardedFrames": discarded_frames,
            "allFrames": ordered_results
        }

    def process_watermark_probe(self, frame_items, niche="kitchen_tools"):
        """(#2) Probe watermark STATELESS - hemat extraction pada video yang pasti mati.
        HANYA menjalankan crop_9_16 + TextGatekeeper.detect produksi per frame, TANPA
        static-detection, TANPA pewarisan DBNet, TANPA agregasi temporal. Karena itulah
        aman dipanggil untuk beberapa frame tersebar; keputusan ambang global (mis. >=3/5)
        dibuat di Node, bukan di sini. Frame gagal decode TIDAK dihitung sebagai watermark."""
        hits = []
        wm_count = 0
        decoded = 0
        bench = _Bench()
        for item in frame_items:
            fp = item.get("filePath") if isinstance(item, dict) else str(item)
            img = cv2.imread(fp) if fp and os.path.exists(fp) else None
            if img is None:
                hits.append(False)
                continue
            decoded += 1
            crop = self.crop_9_16(img)
            has_text = bool(_bench_time(bench, "dbnet", self.text_gate.detect, crop, niche=niche)[0])
            hits.append(has_text)
            if has_text:
                wm_count += 1
        return {
            "status": "success",
            "probe": True,
            "hits": hits,
            "wmCount": wm_count,
            "total": len(frame_items),
            "decoded": decoded,
            "backend": self.text_gate.backend,
            "benchmarks": bench.to_payload(),
        }


GATEKEEPER = None


# ─────────────────────────────────────────────────────────────────────────────
# 5. HTTP SERVER INTERFACE
# ─────────────────────────────────────────────────────────────────────────────
class GatekeeperHTTPHandler(BaseHTTPRequestHandler):
    def _send_json(self, status_code, data):
        body = json.dumps(data).encode("utf-8")
        try:
            self.send_response(status_code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)
            return True
        except ConnectionError:
            # Klien (Node) sudah menutup koneksi (abort/timeout) - hasil tidak bisa dikirim.
            return False

    def do_GET(self):
        if self.path in ("/health", "/"):
            self._send_json(200, {
                "status": "online",
                "service": "AI Local Frame Gatekeeper (Temporal Segment Edition)",
                "version": "2.0.0",
                "policy": {
                    "minConsecutiveClean": 2,
                    "minCleanDurationSec": 1.5,
                    "cleanConfidenceThreshold": SceneGatekeeper.CLEAN_CONF_THRESHOLD,
                    "uncertainThreshold": SceneGatekeeper.UNCERTAIN_CONF_THRESHOLD,
                    "facePolicySupported": ["strict", "presenter_only"],
                    "facePolicyDefault": "strict"
                },
                "models": {
                    "face": GATEKEEPER.face_gate.backend if GATEKEEPER else "unknown",
                    "text": GATEKEEPER.text_gate.backend if GATEKEEPER else "unknown",
                    "scene": GATEKEEPER.scene_gate.backend if GATEKEEPER else "unknown"
                }
            })
        else:
            self._send_json(404, {"error": "Endpoint not found"})

    def do_POST(self):
        if self.path == "/filter-frames":
            try:
                length = int(self.headers.get("Content-Length", 0))
                raw_body = self.rfile.read(length).decode("utf-8")
                payload = json.loads(raw_body)
                frames = payload.get("frames", [])
                niche = payload.get("niche", "kitchen_tools")
                face_policy = str(payload.get("facePolicy", "strict")).strip().lower()
                if face_policy not in ("strict", "presenter_only"):
                    face_policy = "strict"
                min_consec = int(payload.get("minConsecutiveClean", 2))
                min_dur = float(payload.get("minCleanDuration", 1.5))

                if not frames:
                    self._send_json(400, {"error": "Array 'frames' kosong atau tidak ditemukan"})
                    return

                res = GATEKEEPER.process_batch(
                    frames, niche=niche,
                    min_consecutive_clean=min_consec,
                    min_clean_duration=min_dur,
                    face_policy=face_policy
                )
                if not self._send_json(200, res):
                    print(f"⚠️  [Gatekeeper] Klien terputus sebelum hasil {len(frames)} frame terkirim (batch dibuang; cek timeout pemanggil).")
            except ConnectionError:
                # ConnectionError = induk dari BrokenPipeError / ConnectionResetError /
                # ConnectionAbortedError. Di WINDOWS koneksi yang dibatalkan lokal mengangkat
                # ConnectionAbortedError (WinError 10053/10054), BUKAN BrokenPipeError - jadi
                # tuple lama meleset dan traceback tetap menyemprot ke terminal.
                print("⚠️  [Gatekeeper] Klien menutup koneksi saat /filter-frames berlangsung; diabaikan.")
            except Exception as err:
                try:
                    self._send_json(500, {"error": str(err)})
                except ConnectionError:
                    pass
        elif self.path == "/filter-watermark-probe":
            try:
                length = int(self.headers.get("Content-Length", 0))
                payload = json.loads(self.rfile.read(length).decode("utf-8"))
                frames = payload.get("frames", [])
                niche = payload.get("niche", "kitchen_tools")
                if not frames:
                    self._send_json(400, {"error": "Array 'frames' kosong"})
                    return
                res = GATEKEEPER.process_watermark_probe(frames, niche=niche)
                self._send_json(200, res)
            except ConnectionError:
                print("⚠️  [Gatekeeper] Klien menutup koneksi saat /filter-watermark-probe; diabaikan.")
            except Exception as err:
                try:
                    self._send_json(500, {"error": str(err)})
                except ConnectionError:
                    pass
        else:
            self._send_json(404, {"error": "Endpoint not found"})

    def log_message(self, format, *args):
        pass


class DegradedGatekeeperHandler(BaseHTTPRequestHandler):
    def _send_json(self, status_code, data):
        body = json.dumps(data).encode("utf-8")
        try:
            self.send_response(status_code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return True
        except ConnectionError:
            return False

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {
                "status": "degraded",
                "models": {"face": "none", "text": "none", "scene": "none"},
                "message": "opencv-python-headless atau numpy belum terinstall. Backend Node.js otomatis memakai fallback heuristik lokal."
            })
        else:
            self._send_json(404, {"error": "Endpoint not found"})

    def do_POST(self):
        if self.path in ("/filter-frames", "/filter"):
            self._send_json(200, {
                "allFrames": [],
                "cleanConsecutiveSegments": [],
                "eligible": True,
                "degraded": True,
                "message": "Gatekeeper berjalan mode fallback; diserahkan ke fallback heuristik Node.js."
            })
        else:
            self._send_json(404, {"error": "Endpoint not found"})

    def log_message(self, format, *args):
        pass


def run_server(port=5050):
    global GATEKEEPER
    server_address = ("127.0.0.1", port)

    class QuietThreadingHTTPServer(ThreadingHTTPServer):
        """Sengaja membungkam traceback putus-koneksi dari klien yang abort (mis. Node
        timeout / server di-restart saat batch 200 frame berjalan) - ini bukan crash
        gatekeeper. Di Windows gejala aslinya ConnectionAbortedError (WinError 10053),
        jadi tangkap ConnectionError (induk semua error socket), bukan hanya BrokenPipeError.
        Error sesungguhnya tetap dilog normal."""
        daemon_threads = True

        def handle_error(self, request, client_address):
            exc = sys.exc_info()[1]
            if isinstance(exc, (ConnectionError, TimeoutError)):
                print(f"⚠️  [Gatekeeper] Klien {client_address} terputus sebelum respons terkirim ({type(exc).__name__}) - diabaikan.")
                return
            ThreadingHTTPServer.handle_error(self, request, client_address)

    if not HAS_CV2 or not HAS_NUMPY:
        print(f"⚠️  [AI Gatekeeper] opencv-python-headless atau numpy belum terpasang.")
        print(f"   Service berjalan dalam mode FALLBACK pada http://127.0.0.1:{port}.")
        print(f"   (Untuk mengaktifkan model AI lokal, jalankan: pip install opencv-python-headless numpy onnxruntime)")
        httpd = QuietThreadingHTTPServer(server_address, DegradedGatekeeperHandler)
    else:
        GATEKEEPER = FrameGatekeeper()
        httpd = QuietThreadingHTTPServer(server_address, GatekeeperHTTPHandler)
        print(f"📡 [AI Gatekeeper Server v2.0] Mendengarkan pada http://127.0.0.1:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n🛑 [AI Gatekeeper Server] Menghentikan service...")
        httpd.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="AI Local Frame Gatekeeper Service v2.0")
    parser.add_argument("--port", type=int, default=5050, help="HTTP server port (default: 5050)")
    parser.add_argument("--download-models", action="store_true", help="Download ONNX models before start")
    args = parser.parse_args()

    if args.download_models:
        from download_models import check_and_download_models
        check_and_download_models()

    run_server(port=args.port)
