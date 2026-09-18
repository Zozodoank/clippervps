#!/usr/bin/env python3
"""
AI Local Frame Gatekeeper Service for ClipperVPS.
Lightweight real-time CPU vision pipeline to reject dirty video frames before reaching main LLM:
- Stage 1: MediaPipe & YuNet Face Detection (100% faceless in 9:16 center area)
- Stage 2: DBNet Text & Subtitle Detection (rejects burned subtitles and promo banners)
- Stage 3: MobileNetV3 & Visual Variance Classifier (rejects 2D cartoons, graphic intros, and static bumper slides)
"""

import os
import sys
import json
import time
import math
import argparse
from http.server import HTTPServer, ThreadingHTTPServer, BaseHTTPRequestHandler

# VPS 2-core: batasi thread OpenMP/BLAS SEBELUM cv2/numpy/onnxruntime dimuat,
# mencegah kontensi thread dengan Node.js + FFmpeg yang berjalan bersamaan.
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")

import cv2  # type: ignore
import numpy as np  # type: ignore

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


# ─────────────────────────────────────────────────────────────────────────────
# 1. TAHAP 1: FACE DETECTOR (MediaPipe BlazeFace + OpenCV YuNet)
# ─────────────────────────────────────────────────────────────────────────────
class FaceGatekeeper:
    def __init__(self, min_confidence=0.50):
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
                print("  [FaceGatekeeper] ✅ MediaPipe BlazeFace aktif.")
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
                    score_threshold=0.45,
                    nms_threshold=0.3,
                    top_k=5000
                )
                if self.backend == "none":
                    self.backend = "yunet"
                print("  [FaceGatekeeper] ✅ OpenCV YuNet Face Detection aktif.")
            except Exception as e:
                print(f"  [FaceGatekeeper] ⚠️ YuNet init error: {e}")

        if self.backend == "none":
            print("  [FaceGatekeeper] ⚠️ Mode fallback aktif.")

    def detect(self, image_bgr, niche="kitchen_tools"):
        h, w = image_bgr.shape[:2]
        if h < 30 or w < 30:
            return False, 0.0, None, "Dimensi frame terlalu kecil"

        total_frame_area = float(h * w)

        # Wajah manusia presenter/vlogger di latar belakang / sudut dapur (min 24px).
        min_face_px = max(24, int(min(h, w) * 0.03))

        # 1. Try MediaPipe BlazeFace
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
                        if score >= self.min_confidence:
                            bbox = det.bounding_box
                            bx = max(0, int(bbox.origin_x))
                            by = max(0, int(bbox.origin_y))
                            bw = int(bbox.width)
                            bh = int(bbox.height)
                            if bh >= min_face_px and bw >= min_face_px:
                                face_area = float(bw * bh)
                                area_ratio = face_area / total_frame_area
                                # Khusus niche smartphone: tolerir pejalan kaki / subjek kamera jauh (< 6% luas frame)
                                if niche == "gadget_smartphone" and area_ratio < 0.06:
                                    continue
                                if score > best_score:
                                    best_score = score
                                    best_box = [bx, by, bw, bh]
                    if best_box:
                        return True, float(best_score), best_box, f"Wajah vlogger/presenter terdeteksi (confidence: {best_score * 100:.1f}%)"
            except Exception:
                pass

        # 2. Try OpenCV YuNet (Second-pass detector for angled / in-the-wild faces)
        # Threshold 0.50 untuk menangkap wajah samping/miring vlogger
        if self.yunet_detector:
            try:
                self.yunet_detector.setInputSize((w, h))
                _, faces = self.yunet_detector.detect(image_bgr)
                if faces is not None and len(faces) > 0:
                    for face in faces:
                        score = float(face[-1])
                        if score >= 0.50:
                            bx, by, bw, bh = int(face[0]), int(face[1]), int(face[2]), int(face[3])
                            if bh >= min_face_px and bw >= min_face_px:
                                face_area = float(bw * bh)
                                area_ratio = face_area / total_frame_area
                                # Khusus niche smartphone: tolerir pejalan kaki / subjek kamera jauh (< 6% luas frame)
                                if niche == "gadget_smartphone" and area_ratio < 0.06:
                                    continue
                                return True, score, [bx, by, bw, bh], f"Wajah vlogger/presenter terdeteksi (YuNet {score * 100:.1f}%)"
            except Exception:
                pass

        return False, 0.0, None, "Bersih (faceless)"


# ─────────────────────────────────────────────────────────────────────────────
# 2. TAHAP 2: TEXT & SUBTITLE DETECTOR (DBNet PP-OCRv4 ONNX)
# ─────────────────────────────────────────────────────────────────────────────
class TextGatekeeper:
    def __init__(self, max_total_coverage=0.050, max_bottom_coverage=0.040):
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
                print("  [TextGatekeeper] ✅ DBNet PP-OCRv4 ONNX Text Detection aktif.")
            except Exception as e:
                print(f"  [TextGatekeeper] ⚠️ Gagal memuat DBNet ONNX: {e}")

        if not self.ort_session:
            self.backend = "gradient_fallback"
            print("  [TextGatekeeper] ℹ️ Menggunakan fallback Sobel horizontal edge text density.")

    def detect(self, crop_bgr, niche="kitchen_tools"):
        h, w = crop_bgr.shape[:2]
        crop_area = float(h * w)
        if crop_area < 100:
            return False, 0.0, 0.0, "Frame terlalu kecil"

        bottom_y = int(h * 0.65) # Bottom 35% zone where subtitles sit

        # ── Deteksi Kotak Banner Berlatar Warna / Teks Statis (Promo Card / Lower-Third) ──
        try:
            small_color = cv2.resize(crop_bgr, (160, 280), interpolation=cv2.INTER_AREA)
            gray_small = cv2.cvtColor(small_color, cv2.COLOR_BGR2GRAY)
            edges = cv2.Canny(gray_small, 50, 150)
            k_banner = cv2.getStructuringElement(cv2.MORPH_RECT, (15, 3))
            dilated_banner = cv2.dilate(edges, k_banner)
            contours, _ = cv2.findContours(dilated_banner, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            for cnt in contours:
                bx, by, bw, bh = cv2.boundingRect(cnt)
                # Kartu banner lebar (>= 45% lebar frame 9:16) dan tinggi 6%-35% frame
                if bw >= int(160 * 0.45) and int(280 * 0.06) <= bh <= int(280 * 0.35):
                    if (bw * bh) > (160 * 280 * 0.08) and (by + bh / 2) > (280 * 0.15):
                        inner_edge_density = np.count_nonzero(edges[by:by+bh, bx:bx+bw]) / float(bw * bh)
                        if inner_edge_density > 0.18:
                            return True, 0.12, 0.15, f"Banner promosi / kartu teks statis terdeteksi di frame 9:16 ({bw}x{bh}px)"
        except Exception:
            pass

        max_bottom = self.max_bottom_coverage * (1.5 if niche == "gadget_smartphone" else 1.0)
        max_total = self.max_total_coverage * (1.4 if niche == "gadget_smartphone" else 1.0)

        # ── Jalur 1: DBNet PP-OCRv4 ONNX Inference (Real-time sub-10ms) ──
        if self.ort_session:
            try:
                # Resize keeping multiple of 32 for DBNet
                target_size = 320
                scale_h = target_size / h
                scale_w = target_size / w
                target_w = max(32, int(w * scale_w / 32) * 32)
                target_h = max(32, int(h * scale_h / 32) * 32)

                resized = cv2.resize(crop_bgr, (target_w, target_h), interpolation=cv2.INTER_LINEAR)
                rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
                mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
                std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
                norm = (rgb - mean) / std
                blob = np.transpose(norm, (2, 0, 1))[np.newaxis, ...]

                input_name = self.ort_session.get_inputs()[0].name
                outputs = self.ort_session.run(None, {input_name: blob})
                prob_map = outputs[0][0, 0] # (target_h, target_w)

                # Binary segmentation at 0.3 probability threshold
                text_mask = prob_map > 0.30
                total_text_pixels = int(np.count_nonzero(text_mask))
                total_cov = total_text_pixels / float(target_h * target_w)

                # Top 35% zone (detects top overlay, "da di deskripsi", promo banners, channel watermarks)
                top_cut = int(target_h * 0.35)
                top_mask = text_mask[:top_cut, :]
                top_text_pixels = int(np.count_nonzero(top_mask))
                top_zone_pixels = float(top_cut * target_w)
                top_cov = top_text_pixels / top_zone_pixels if top_zone_pixels > 0 else 0.0

                # Top-left and top-right corner zone (detects top watermarks & channel names)
                top_left_mask = text_mask[:top_cut, :int(target_w * 0.60)]
                top_left_cov = int(np.count_nonzero(top_left_mask)) / float(top_cut * int(target_w * 0.60)) if top_zone_pixels > 0 else 0.0

                top_right_mask = text_mask[:top_cut, int(target_w * 0.40):]
                top_right_cov = int(np.count_nonzero(top_right_mask)) / float(top_cut * (target_w - int(target_w * 0.40))) if top_zone_pixels > 0 else 0.0

                # Bottom 35% zone
                bottom_cut = int(target_h * 0.65)
                bottom_mask = text_mask[bottom_cut:, :]
                bottom_text_pixels = int(np.count_nonzero(bottom_mask))
                bottom_zone_pixels = float((target_h - bottom_cut) * target_w)
                bottom_cov = bottom_text_pixels / bottom_zone_pixels if bottom_zone_pixels > 0 else 0.0

                bottom_right_mask = text_mask[bottom_cut:, int(target_w * 0.45):]
                bottom_right_cov = int(np.count_nonzero(bottom_right_mask)) / float((target_h - bottom_cut) * (target_w - int(target_w * 0.45))) if bottom_zone_pixels > 0 else 0.0

                if top_cov >= 0.070 or top_left_cov >= 0.060 or top_right_cov >= 0.060:
                    return True, total_cov, bottom_cov, f"Teks overlay / watermark di area atas (coverage {max(top_cov, top_left_cov, top_right_cov) * 100:.1f}%)"
                if bottom_right_cov >= 0.065:
                    return True, total_cov, bottom_cov, f"Watermark / logo kreator di pojok bawah (coverage {bottom_right_cov * 100:.1f}%)"
                if bottom_cov >= max_bottom:
                    return True, total_cov, bottom_cov, f"Subtitle terbakar di area bawah (coverage {bottom_cov * 100:.1f}%)"
                if total_cov >= max_total:
                    return True, total_cov, bottom_cov, f"Teks promosi dominan menutupi frame (coverage {total_cov * 100:.1f}%)"

                # DBNet PP-OCRv4 terverifikasi bersih bebas teks
                return False, total_cov, bottom_cov, "Teks dalam batas wajar (DBNet bersih)"
            except Exception as e:
                pass

        # ── Jalur 2: Fast Sobel Horizontal Gradient Check (Fallback HANYA jika DBNet tidak aktif) ──
        gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
        grad_x = cv2.Sobel(gray, cv2.CV_16S, 1, 0, ksize=3)
        abs_grad_x = cv2.convertScaleAbs(grad_x)

        # Morphological horizontal connection to form text line blobs
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (17, 3))
        connected = cv2.morphologyEx(abs_grad_x, cv2.MORPH_CLOSE, kernel)
        _, connected = cv2.threshold(connected, 55, 255, cv2.THRESH_BINARY)

        total_cov = float(cv2.countNonZero(connected)) / float(crop_area)

        # Top 35% zone fallback
        top_y = int(h * 0.35)
        top_roi = connected[:top_y, :]
        top_zone_area = float(top_y * w)
        top_cov = float(cv2.countNonZero(top_roi)) / top_zone_area if top_zone_area > 0 else 0.0

        left_top_roi = connected[:top_y, :int(w * 0.60)]
        left_top_area = float(top_y * int(w * 0.60))
        left_top_cov = float(cv2.countNonZero(left_top_roi)) / left_top_area if left_top_area > 0 else 0.0

        right_top_roi = connected[:top_y, int(w * 0.40):]
        right_top_area = float(top_y * (w - int(w * 0.40)))
        right_top_cov = float(cv2.countNonZero(right_top_roi)) / right_top_area if right_top_area > 0 else 0.0

        bottom_roi = connected[bottom_y:, :]
        bottom_zone_area = float((h - bottom_y) * w)
        bottom_cov = float(cv2.countNonZero(bottom_roi)) / bottom_zone_area if bottom_zone_area > 0 else 0.0

        bottom_right_roi = connected[bottom_y:, int(w * 0.45):]
        bottom_right_area = float((h - bottom_y) * (w - int(w * 0.45)))
        bottom_right_cov = float(cv2.countNonZero(bottom_right_roi)) / bottom_right_area if bottom_right_area > 0 else 0.0

        sobel_bottom_thresh = 0.08 if niche == "gadget_smartphone" else 0.06
        sobel_total_thresh = 0.10 if niche == "gadget_smartphone" else 0.07

        if left_top_cov >= 0.075 or right_top_cov >= 0.075 or top_cov >= 0.080:
            return True, total_cov, bottom_cov, f"Teks overlay / watermark di area atas (densitas {max(top_cov, left_top_cov, right_top_cov) * 100:.1f}%)"
        if bottom_right_cov >= 0.070:
            return True, total_cov, bottom_cov, f"Watermark sudut bawah terdeteksi (densitas {bottom_right_cov * 100:.1f}%)"
        if bottom_cov >= sobel_bottom_thresh:
            return True, total_cov, bottom_cov, f"Pola subtitle terbakar di area bawah (densitas {bottom_cov * 100:.1f}%)"
        if total_cov >= sobel_total_thresh:
            return True, total_cov, bottom_cov, f"Densitas teks/grafis dominan ({total_cov * 100:.1f}%)"

        return False, total_cov, bottom_cov, "Teks dalam batas wajar"


# ─────────────────────────────────────────────────────────────────────────────
# 3. TAHAP 3: SCENE & OVERLAY CLASSIFIER (Custom MobileNetV3 + Visual Variance)
# ─────────────────────────────────────────────────────────────────────────────
class SceneGatekeeper:
    def __init__(self):
        self.ort_session = None
        self.is_custom_model = False
        self.backend = "entropy_variance"

        custom_model_path = os.path.join(MODELS_DIR, "scene_filter_v2.onnx")
        generic_model_path = os.path.join(MODELS_DIR, "mobilenetv3_small.onnx")

        if HAS_ORT:
            opts = ort.SessionOptions()
            opts.intra_op_num_threads = 2

            # Prioritas 1: Model Custom Hasil Training (scene_filter_v2.onnx)
            if os.path.exists(custom_model_path):
                try:
                    self.ort_session = ort.InferenceSession(
                        custom_model_path,
                        sess_options=opts,
                        providers=["CPUExecutionProvider"]
                    )
                    self.is_custom_model = True
                    self.backend = "custom_scene_filter_v2"
                    print("  [SceneGatekeeper] 🎯 AI Custom Model (scene_filter_v2.onnx) AKTIF (Class 0: rejected, Class 1: valid_real).")
                except Exception as e:
                    print(f"  [SceneGatekeeper] ⚠️ Gagal memuat custom scene_filter_v2.onnx: {e}")

            # Prioritas 2: Generic ImageNet Pretrained Fallback
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
            return False, 0.99, "Dimensi crop terlalu kecil"

        # 1. Color Quantization Check (Detects 2D vector graphic cards, flat slide bumpers)
        small = cv2.resize(crop_bgr, (64, 64), interpolation=cv2.INTER_AREA)
        quantized = (small >> 5).reshape(-1, 3)
        unique_colors = len(np.unique(quantized, axis=0))

        # Real live camera footage has rich color gradients (> 40 unique colors at 64x64)
        # Flat vector graphics, solid color slide bumpers, and intro cards have very few colors (< 22)
        if unique_colors < 22:
            return False, 0.90, f"Terdeteksi kartu bumper statis / grafis 2D datar ({unique_colors} kluster warna)"

        # 2. Laplacian Texture Variance (Detects solid color / blank screen)
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        laplacian_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())
        if laplacian_var < 15.0:
            return False, 0.85, f"Frame polos tanpa tekstur / slide bumper (laplacian: {laplacian_var:.1f})"

        # 3. AI Scene Classification (Custom Fine-tuned or Generic ImageNet)
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

                # ── Custom Model Fine-Tuned (Uses labels mapping) ──
                if self.is_custom_model:
                    exp_l = np.exp(raw_logits - np.max(raw_logits))
                    probs = exp_l / np.sum(exp_l)
                    pred_class = int(np.argmax(probs))
                    conf = float(probs[pred_class])
                    label_name = self.labels[pred_class] if pred_class < len(self.labels) else str(pred_class)

                    if label_name == "rejected" and conf > 0.55:
                        return False, conf, f"Custom AI: Terdeteksi grafis/kartun/slide non-produk (confidence: {conf * 100:.1f}%)"
                    elif label_name == "valid_real":
                        return True, conf, f"Custom AI: Peragaan produk fisik nyata valid (confidence: {conf * 100:.1f}%)"

                # ── Generic ImageNet Model Fallback ──
                else:
                    top_class = int(np.argmax(raw_logits))
                    graphic_classes = {918, 919, 921, 664, 782, 916, 922}
                    if top_class in graphic_classes:
                        return False, 0.80, f"MobileNetV3 mengklasifikasikan sebagai grafis/kartun/layar (class #{top_class})"
            except Exception:
                pass

        return True, 0.95, "Adegan natural produk valid"


# ─────────────────────────────────────────────────────────────────────────────
# 4. ORCHESTRATOR PIPELINE
# ─────────────────────────────────────────────────────────────────────────────
def detect_pillarbox(image_bgr):
    """
    Mendeteksi video vertikal yang di-pillarbox (strip hitam di sisi kiri dan kanan)
    atau di-letterbox (strip hitam di atas dan bawah).
    Video 9:16 yang valid tidak boleh memiliki pilar/bar hitam vertikal/horizontal.
    """
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

    # Letterbox check (top/bottom horizontal bars)
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
    """
    Mendeteksi kertas buku panduan manual / kartu garansi / unboxing document:
    Kertas putih cerah (val > 150), sangat desaturasi (sat < 45), dan memiliki densitas garis teks paragraf tinggi (edge_cov > 0.022).
    """
    h, w = image_bgr.shape[:2]
    if h < 60 or w < 60:
        return False, "Dimensi terlalu kecil"
    hsv = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV)
    sat_mean = float(np.mean(hsv[:, :, 1]))
    val_mean = float(np.mean(hsv[:, :, 2]))
    gray = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 50, 150)
    edge_cov = float(np.count_nonzero(edges)) / float(h * w)

    if val_mean > 150 and sat_mean < 45 and edge_cov > 0.022:
        return True, f"Buku panduan / dokumen kertas manual terdeteksi (val={val_mean:.0f}, sat={sat_mean:.0f}, edges={edge_cov*100:.1f}%)"
    return False, "Bukan dokumen kertas"


def detect_synthetic_graphic_overlay(crop_bgr):
    """
    Mendeteksi elemen grafis non-teks buatan editor video YouTube:
    - Panah merah/kuning penunjuk produk
    - Lingkaran merah / kotak penanda highlight
    - Tombol subscribe / follow / badge harga animasi
    - Stiker emoji / grafis digital vektor berlatar solid
    """
    h, w = crop_bgr.shape[:2]
    if h < 60 or w < 60:
        return False, "Crop terlalu kecil"

    hsv = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2HSV)
    _, s_channel, v_channel = cv2.split(hsv)

    # 1. Mask piksel dengan saturasi & kecerahan ultra-tinggi (warna buatan/neon)
    # Red range 1 & 2 (panah / lingkaran merah YouTube)
    red_mask1 = cv2.inRange(hsv, np.array([0, 190, 160]), np.array([10, 255, 255]))
    red_mask2 = cv2.inRange(hsv, np.array([170, 190, 160]), np.array([180, 255, 255]))
    # Bright pure yellow / neon (kotak penanda / tombol highlight)
    yellow_mask = cv2.inRange(hsv, np.array([22, 210, 180]), np.array([34, 255, 255]))
    # Neon green / cyan / magenta
    neon_mask = cv2.inRange(hsv, np.array([35, 220, 180]), np.array([160, 255, 255]))

    synthetic_mask = cv2.bitwise_or(cv2.bitwise_or(red_mask1, red_mask2), cv2.bitwise_or(yellow_mask, neon_mask))

    # Bersihkan noise kecil (titik-titik bintik) dengan morfologi opening
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    opened = cv2.morphologyEx(synthetic_mask, cv2.MORPH_OPEN, kernel)

    num_labels, labels, stats, _ = cv2.connectedComponentsWithStats(opened)

    total_area = float(h * w)
    for i in range(1, num_labels):
        comp_area = stats[i, cv2.CC_STAT_AREA]
        # Panah, badge, atau lingkaran biasanya berukuran antara 0.3% hingga 15% frame
        comp_ratio = comp_area / total_area
        if 0.003 <= comp_ratio <= 0.15:
            comp_mask = (labels == i).astype(np.uint8)
            # Periksa kehalusan warna (flatness / standard deviation): grafis buatan warnanya datar tanpa bayangan alami
            comp_v = v_channel[comp_mask > 0]
            v_std = float(np.std(comp_v)) if len(comp_v) > 0 else 99.0

            # Grafis vektor buatan editor memiliki v_std sangat rendah (< 14.0)
            if v_std < 14.0:
                return True, f"Terdeteksi grafis overlay buatan (panah/lingkaran/stiker vektor, area {comp_ratio*100:.1f}%, std={v_std:.1f})"

    # 2. Deteksi watermark box / badge putih terang datar di area sudut (top 30% atau bottom 30%)
    white_mask = cv2.inRange(hsv, np.array([0, 0, 235]), np.array([180, 25, 255]))
    opened_w = cv2.morphologyEx(white_mask, cv2.MORPH_OPEN, kernel)
    num_labels_w, labels_w, stats_w, _ = cv2.connectedComponentsWithStats(opened_w)
    for i in range(1, num_labels_w):
        comp_area = stats_w[i, cv2.CC_STAT_AREA]
        comp_ratio = comp_area / total_area
        top_y = stats_w[i, cv2.CC_STAT_TOP]
        height_c = stats_w[i, cv2.CC_STAT_HEIGHT]
        # Jika badge putih berukuran 0.4% - 10% dan berada di area atas (< 35% h) atau bawah (> 65% h)
        if 0.004 <= comp_ratio <= 0.10 and (top_y < int(h * 0.35) or (top_y + height_c) > int(h * 0.65)):
            comp_mask = (labels_w == i).astype(np.uint8)
            comp_v = v_channel[comp_mask > 0]
            v_std = float(np.std(comp_v)) if len(comp_v) > 0 else 99.0
            if v_std < 10.0:
                return True, f"Terdeteksi watermark / badge grafis putih di sudut frame (area {comp_ratio*100:.1f}%, std={v_std:.1f})"

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
        target_w = int(h * 9.0 / 16.0)
        if target_w >= w:
            return image
        x_start = (w - target_w) // 2
        return image[:, x_start:x_start + target_w]

    def process_single_frame(self, file_path, timestamp=0.0, niche="kitchen_tools"):
        if not os.path.exists(file_path):
            return {
                "filePath": file_path,
                "timestamp": timestamp,
                "status": "discarded",
                "stage": "io_error",
                "reason": "File frame tidak ditemukan di disk"
            }

        img = cv2.imread(file_path)
        if img is None:
            return {
                "filePath": file_path,
                "timestamp": timestamp,
                "status": "discarded",
                "stage": "io_error",
                "reason": "Format gambar corrupt / gagal dibaca cv2"
            }

        # ── TAHAP 0: Pemeriksaan Pillarbox / Black Bars pada Full Frame ──
        has_pb, pb_ratio, pb_reason = detect_pillarbox(img)
        if has_pb:
            return {
                "filePath": file_path,
                "timestamp": timestamp,
                "status": "discarded",
                "stage": "orientation",
                "reason": pb_reason,
                "pillarboxRatio": round(pb_ratio, 3)
            }

        crop = self.crop_9_16(img)

        # ── TAHAP 0B: Pemeriksaan Buku Panduan / Dokumen Kertas Manual ──
        has_manual, manual_reason = detect_paper_manual(crop)
        if has_manual:
            return {
                "filePath": file_path,
                "timestamp": timestamp,
                "status": "discarded",
                "stage": "unboxing_manual",
                "reason": manual_reason
            }

        # ── TAHAP 1A: Face Detection pada Crop 9:16 (Area Tengah Fokus Klip) ──
        has_face_crop, face_conf_crop, face_box_crop, face_reason_crop = self.face_gate.detect(crop, niche=niche)
        if has_face_crop:
            return {
                "filePath": file_path,
                "timestamp": timestamp,
                "status": "discarded",
                "stage": "face",
                "reason": face_reason_crop,
                "confidence": face_conf_crop,
                "box": face_box_crop
            }

        # ── TAHAP 1B: Face Detection pada Full 16:9 Frame (Presenter di Sisi Kiri / Kanan Video) ──
        # Mencegah vlogger/presenter yang berdiri di pinggir layar lolos ke Gemini Vision
        has_face_full, face_conf_full, face_box_full, face_reason_full = self.face_gate.detect(img, niche=niche)
        if has_face_full:
            return {
                "filePath": file_path,
                "timestamp": timestamp,
                "status": "discarded",
                "stage": "face",
                "reason": f"Presenter terdeteksi di video (area samping): {face_reason_full}",
                "confidence": face_conf_full,
                "box": face_box_full
            }

        # ── TAHAP 2: Text Detection ──
        has_text, total_cov, bottom_cov, text_reason = self.text_gate.detect(crop, niche=niche)
        if has_text:
            return {
                "filePath": file_path,
                "timestamp": timestamp,
                "status": "discarded",
                "stage": "text",
                "reason": text_reason,
                "totalCoverage": round(total_cov, 3),
                "bottomCoverage": round(bottom_cov, 3)
            }

        # ── TAHAP 2B: Deteksi Grafis Sintetis Non-Teks (Panah, Stiker, Badge, Lingkaran Merah) ──
        has_graphic, graphic_reason = detect_synthetic_graphic_overlay(crop)
        if has_graphic:
            return {
                "filePath": file_path,
                "timestamp": timestamp,
                "status": "discarded",
                "stage": "graphic_overlay",
                "reason": graphic_reason
            }

        # ── TAHAP 3: Scene Classifier ──
        is_natural, scene_conf, scene_reason = self.scene_gate.evaluate(crop)
        if not is_natural:
            return {
                "filePath": file_path,
                "timestamp": timestamp,
                "status": "discarded",
                "stage": "scene",
                "reason": scene_reason,
                "confidence": scene_conf
            }

        # ── Lolos Seluruh Tahap: Frame Bersih ──
        return {
            "filePath": file_path,
            "timestamp": timestamp,
            "status": "clean",
            "stage": "passed",
            "reason": "Lolos seluruh filter (Faceless, Tanpa Pillarbox, Bebas Teks, Adegan Natural)",
            "totalCoverage": round(total_cov, 3),
            "bottomCoverage": round(bottom_cov, 3)
        }

    def process_batch(self, frame_items, niche="kitchen_tools"):
        results = []
        clean_frames = []
        discarded_frames = []

        start_time = time.time()

        # ── 1. Inter-Frame Motion & Static Frame Detection (MAD < 6.0) ──
        prev_small = None
        static_transitions = 0
        static_indices = set()

        for idx, item in enumerate(frame_items):
            path = item.get("filePath") if isinstance(item, dict) else str(item)
            if path and os.path.exists(path):
                img = cv2.imread(path)
                if img is not None:
                    small = cv2.resize(img, (80, 144))
                    if prev_small is not None:
                        diff = float(cv2.absdiff(small, prev_small).mean())
                        if diff < 6.0:
                            static_transitions += 1
                            static_indices.add(idx)
                    prev_small = small

        # ── 2. Per-Frame Gatekeeper Evaluation ──
        for idx, item in enumerate(frame_items):
            path = item.get("filePath") if isinstance(item, dict) else str(item)
            ts = item.get("timestamp", 0.0) if isinstance(item, dict) else 0.0
            verdict = self.process_single_frame(path, ts, niche=niche)

            # Jika frame terdeteksi statis diam di badan video:
            if idx in static_indices and ts > 3.0 and verdict["status"] == "clean":
                verdict["status"] = "discarded"
                verdict["stage"] = "static_frame"
                verdict["reason"] = "Frame foto statis diam tanpa gerakan fisik peragaan"

            results.append(verdict)

            if verdict["status"] == "clean":
                clean_frames.append(verdict)
            else:
                discarded_frames.append(verdict)

        elapsed_ms = (time.time() - start_time) * 1000.0
        avg_ms_per_frame = elapsed_ms / max(1, len(frame_items))

        # Check for opening intro cutoff
        intro_cutoff_sec = 0.0
        if len(results) >= 2 and results[0]["status"] == "discarded" and results[0]["stage"] in ("text", "scene", "static_frame", "unboxing_manual", "orientation"):
            intro_cutoff_sec = max(3.0, results[0].get("timestamp", 3.0))
            if results[1]["status"] == "discarded" and results[1]["stage"] in ("text", "scene", "static_frame", "unboxing_manual", "orientation"):
                intro_cutoff_sec = max(intro_cutoff_sec, results[1].get("timestamp", 5.0))

        # Eligible if at least 4 clean frames and clean frames represent >= 35% of video
        static_ratio = float(static_transitions) / max(1, len(frame_items) - 1)
        is_static_slideshow = (static_transitions >= 3) or (static_ratio >= 0.35)

        eligible = (not is_static_slideshow) and len(clean_frames) >= 4 and (len(clean_frames) / max(1, len(frame_items)) >= 0.35)

        summary_reason = "Visual video bersih dan fokus pada produk natural."
        if not eligible:
            face_discards = sum(1 for d in discarded_frames if d["stage"] == "face")
            text_discards = sum(1 for d in discarded_frames if d["stage"] == "text")
            scene_discards = sum(1 for d in discarded_frames if d["stage"] == "scene")
            static_discards = sum(1 for d in discarded_frames if d["stage"] == "static_frame")
            orient_discards = sum(1 for d in discarded_frames if d["stage"] == "orientation")
            manual_discards = sum(1 for d in discarded_frames if d["stage"] == "unboxing_manual")

            if is_static_slideshow or static_discards >= 3:
                summary_reason = f"Ditolak AI Gatekeeper: Video terdeteksi berupa slideshow foto statis / gambar diam ({static_transitions} transisi beku). Wajib video dengan gerakan fisik nyata."
            elif orient_discards >= 2:
                summary_reason = f"Ditolak AI Gatekeeper: {orient_discards} frame terdeteksi pillarbox hitam / orientasi abnormal."
            elif manual_discards >= 2:
                summary_reason = f"Ditolak AI Gatekeeper: {manual_discards} frame berupa dokumen buku panduan manual / unboxing."
            elif face_discards >= 3:
                summary_reason = f"Ditolak AI Gatekeeper: Terdeteksi {face_discards} frame menampilkan wajah manusia."
            elif text_discards >= 4:
                summary_reason = f"Ditolak AI Gatekeeper: {text_discards} frame dipenuhi subtitle / teks promosi dominan."
            elif scene_discards >= 4:
                summary_reason = f"Ditolak AI Gatekeeper: {scene_discards} frame berupa kartun, animasi, atau slide statis."
            else:
                summary_reason = f"Ditolak AI Gatekeeper: Hanya {len(clean_frames)}/{len(frame_items)} frame bersih yang ditemukan."

        return {
            "status": "success",
            "eligible": eligible,
            "reason": summary_reason,
            "totalFrames": len(frame_items),
            "cleanFramesCount": len(clean_frames),
            "discardedFramesCount": len(discarded_frames),
            "introCutoffSec": intro_cutoff_sec,
            "hasOpeningIntro": intro_cutoff_sec > 0.0,
            "benchmarks": {
                "totalMs": round(elapsed_ms, 1),
                "avgMsPerFrame": round(avg_ms_per_frame, 1),
                "fps": round(1000.0 / max(1.0, avg_ms_per_frame), 1)
            },
            "cleanFrames": clean_frames,
            "discardedFrames": discarded_frames,
            "allFrames": results
        }


GATEKEEPER = None


# ─────────────────────────────────────────────────────────────────────────────
# 5. HTTP SERVER INTERFACE
# ─────────────────────────────────────────────────────────────────────────────
class GatekeeperHTTPHandler(BaseHTTPRequestHandler):
    def _send_json(self, status_code, data):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path in ("/health", "/"):
            self._send_json(200, {
                "status": "online",
                "service": "AI Local Frame Gatekeeper",
                "version": "1.0.0",
                "models": {
                    "face": GATEKEEPER.face_gate.backend,
                    "text": GATEKEEPER.text_gate.backend,
                    "scene": GATEKEEPER.scene_gate.backend
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

                if not frames:
                    self._send_json(400, {"error": "Array 'frames' kosong atau tidak ditemukan"})
                    return

                res = GATEKEEPER.process_batch(frames, niche=niche)
                self._send_json(200, res)
            except Exception as err:
                self._send_json(500, {"error": str(err)})
        else:
            self._send_json(404, {"error": "Endpoint not found"})

    def log_message(self, format, *args):
        pass


def run_server(port=5050):
    global GATEKEEPER
    GATEKEEPER = FrameGatekeeper()
    server_address = ("127.0.0.1", port)
    httpd = ThreadingHTTPServer(server_address, GatekeeperHTTPHandler)
    print(f"📡 [AI Gatekeeper Server] Mendengarkan pada http://127.0.0.1:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n🛑 [AI Gatekeeper Server] Menghentikan service...")
        httpd.server_close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="AI Local Frame Gatekeeper Service")
    parser.add_argument("--port", type=int, default=5050, help="HTTP server port (default: 5050)")
    parser.add_argument("--download-models", action="store_true", help="Download ONNX models before start")
    args = parser.parse_args()

    if args.download_models:
        from download_models import check_and_download_models
        check_and_download_models()

    run_server(port=args.port)
