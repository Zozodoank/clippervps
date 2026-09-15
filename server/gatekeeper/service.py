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

import cv2
import numpy as np

try:
    cv2.setNumThreads(1)
except Exception:
    pass

# ONNX runtime & MediaPipe
try:
    import onnxruntime as ort
    HAS_ORT = True
except ImportError:
    ort = None
    HAS_ORT = False

try:
    import mediapipe as mp
    from mediapipe.tasks import python as mp_tasks
    from mediapipe.tasks.python import vision as mp_vision
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

    def detect(self, image_bgr):
        h, w = image_bgr.shape[:2]
        if h < 30 or w < 30:
            return False, 0.0, None, "Dimensi frame terlalu kecil"

        min_face_px = max(10, int(min(h, w) * 0.025))

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
                                if score > best_score:
                                    best_score = score
                                    best_box = [bx, by, bw, bh]
                    if best_box:
                        return True, float(best_score), best_box, f"Wajah manusia terdeteksi (confidence: {best_score * 100:.1f}%)"
            except Exception:
                pass

        # 2. Try OpenCV YuNet (Second-pass detector for angled / in-the-wild faces)
        if self.yunet_detector:
            try:
                self.yunet_detector.setInputSize((w, h))
                _, faces = self.yunet_detector.detect(image_bgr)
                if faces is not None and len(faces) > 0:
                    for face in faces:
                        score = float(face[-1])
                        if score >= 0.45:
                            bx, by, bw, bh = int(face[0]), int(face[1]), int(face[2]), int(face[3])
                            if bh >= min_face_px and bw >= min_face_px:
                                return True, score, [bx, by, bw, bh], f"Wajah manusia terdeteksi (YuNet {score * 100:.1f}%)"
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

    def detect(self, crop_bgr):
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
                        if inner_edge_density > 0.06:
                            return True, 0.12, 0.15, f"Banner promosi / kartu teks statis terdeteksi di frame 9:16 ({bw}x{bh}px)"
        except Exception:
            pass

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

                # Bottom 35% zone
                bottom_cut = int(target_h * 0.65)
                bottom_mask = text_mask[bottom_cut:, :]
                bottom_text_pixels = int(np.count_nonzero(bottom_mask))
                bottom_zone_pixels = float((target_h - bottom_cut) * target_w)
                bottom_cov = bottom_text_pixels / bottom_zone_pixels if bottom_zone_pixels > 0 else 0.0

                if bottom_cov >= self.max_bottom_coverage:
                    return True, total_cov, bottom_cov, f"Subtitle terbakar di area bawah (coverage {bottom_cov * 100:.1f}%)"
                if total_cov >= self.max_total_coverage:
                    return True, total_cov, bottom_cov, f"Teks promosi dominan menutupi frame (coverage {total_cov * 100:.1f}%)"

                return False, total_cov, bottom_cov, "Teks minimal / bersih"
            except Exception as e:
                pass

        # ── Jalur 2: Fast Sobel Horizontal Gradient Fallback ──
        gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
        grad_x = cv2.Sobel(gray, cv2.CV_16S, 1, 0, ksize=3)
        abs_grad_x = cv2.convertScaleAbs(grad_x)
        _, thresh = cv2.threshold(abs_grad_x, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)

        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (9, 3))
        connected = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)

        total_cov = float(cv2.countNonZero(connected)) / crop_area
        bottom_roi = connected[bottom_y:, :]
        bottom_zone_area = float((h - bottom_y) * w)
        bottom_cov = float(cv2.countNonZero(bottom_roi)) / bottom_zone_area if bottom_zone_area > 0 else 0.0

        if bottom_cov >= 0.08:
            return True, total_cov, bottom_cov, f"Pola subtitle terbakar di area bawah (densitas {bottom_cov * 100:.1f}%)"
        if total_cov >= 0.07:
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
                    print("  [SceneGatekeeper] 🎯 AI Custom Model (scene_filter_v2.onnx) AKTIF (Class 0: Real, Class 1: Reject).")
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

    def process_single_frame(self, file_path, timestamp=0.0):
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

        crop = self.crop_9_16(img)

        # ── TAHAP 1A: Face Detection pada Crop 9:16 (Area Tengah Fokus Klip) ──
        has_face_crop, face_conf_crop, face_box_crop, face_reason_crop = self.face_gate.detect(crop)
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
        has_face_full, face_conf_full, face_box_full, face_reason_full = self.face_gate.detect(img)
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
        has_text, total_cov, bottom_cov, text_reason = self.text_gate.detect(crop)
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
            "reason": "Lolos 3 tahap filter (Faceless, Bebas Teks, Adegan Natural)",
            "totalCoverage": round(total_cov, 3),
            "bottomCoverage": round(bottom_cov, 3)
        }

    def process_batch(self, frame_items):
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
            verdict = self.process_single_frame(path, ts)

            # Jika frame terdeteksi statis diam di badan video, buang frame tersebut
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
        if len(results) >= 2 and results[0]["status"] == "discarded" and results[0]["stage"] in ("text", "scene", "static_frame"):
            intro_cutoff_sec = max(3.0, results[0].get("timestamp", 3.0))
            if results[1]["status"] == "discarded" and results[1]["stage"] in ("text", "scene", "static_frame"):
                intro_cutoff_sec = max(intro_cutoff_sec, results[1].get("timestamp", 5.0))

        # Eligible if at least 4 clean frames and clean frames represent >= 35% of video
        # AND not a static slideshow (static transitions < 35% and static_transitions < 3)
        static_ratio = float(static_transitions) / max(1, len(frame_items) - 1)
        is_static_slideshow = (static_transitions >= 3) or (static_ratio >= 0.35)

        eligible = (not is_static_slideshow) and len(clean_frames) >= 4 and (len(clean_frames) / max(1, len(frame_items)) >= 0.35)

        summary_reason = "Visual video bersih dan fokus pada produk natural."
        if not eligible:
            face_discards = sum(1 for d in discarded_frames if d["stage"] == "face")
            text_discards = sum(1 for d in discarded_frames if d["stage"] == "text")
            scene_discards = sum(1 for d in discarded_frames if d["stage"] == "scene")
            static_discards = sum(1 for d in discarded_frames if d["stage"] == "static_frame")

            if is_static_slideshow or static_discards >= 3:
                summary_reason = f"Ditolak AI Gatekeeper: Video terdeteksi berupa slideshow foto statis / gambar diam ({static_transitions} transisi beku). Wajib video dengan gerakan fisik nyata."
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

                if not frames:
                    self._send_json(400, {"error": "Array 'frames' kosong atau tidak ditemukan"})
                    return

                res = GATEKEEPER.process_batch(frames)
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
