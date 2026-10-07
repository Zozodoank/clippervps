#!/usr/bin/env python3
"""Distill DBNet detections into six coarse text-zone labels for MobileNetV3.

Run after adding watermark examples. This is pseudo-label generation, so review a
random sample against the source frame before using the exported model.
"""
import argparse
import csv
import hashlib
import os
import shutil

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}
ZONE_NAMES = ("bottom", "top", "TL", "TR", "BL", "BR")


def split_group_key(relative_path):
    parts = [p.lower() for p in relative_path.replace("\\", "/").split("/")]
    # Raw candidate frames are temporally adjacent samples from one source job.
    # Keep every candidate/frame in that job together to avoid validation leakage.
    if "raw_frames" in parts:
        raw_frames_index = parts.index("raw_frames")
        if raw_frames_index > 0:
            return parts[raw_frames_index - 1]
    # A directory of frames is one source group; a flat collection falls back to
    # per-file hashing so unrelated examples can still populate both splits.
    if len(parts) > 1:
        return "/".join(parts[:-1])
    return parts[0]


def split_for(relative_path):
    parts = [p.lower() for p in relative_path.replace("\\", "/").split("/")]
    for name in ("train", "val", "valid", "validation"):
        if name in parts:
            return "val" if name in ("val", "valid", "validation") else "train"
    group_key = split_group_key(relative_path)
    return "val" if int(hashlib.sha1(group_key.encode()).hexdigest()[:8], 16) % 5 == 0 else "train"


def write_manifest(path, rows):
    if not rows:
        return
    temporary_path = path + ".tmp"
    with open(temporary_path, "w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    os.replace(temporary_path, path)


def detect_zones(session, image):
    height, width = image.shape[:2]
    scale = 736 / max(height, width)
    target_w = max(32, int(round(width * scale / 32.0)) * 32)
    target_h = max(32, int(round(height * scale / 32.0)) * 32)
    resized = cv2.resize(image, (target_w, target_h), interpolation=cv2.INTER_LINEAR)
    rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    mean = np.array([0.485, 0.456, 0.406], dtype=np.float32)
    std = np.array([0.229, 0.224, 0.225], dtype=np.float32)
    blob = np.transpose((rgb - mean) / std, (2, 0, 1))[None, ...]
    prob = session.run(None, {session.get_inputs()[0].name: blob})[0][0, 0] > 0.22
    y1, y2 = int(target_h * 0.35), int(target_h * 0.65)
    x1, x2 = int(target_w * 0.45), int(target_w * 0.55)
    zones = [prob[y2:, :], prob[:y1, :], prob[:y1, :x1], prob[:y1, x2:], prob[y2:, :x1], prob[y2:, x2:]]
    cov = [float(np.count_nonzero(z) / max(1, z.size)) for z in zones]
    # Audit manual 200 frame (2026-10-07) menemukan watermark akun di sudut kiri
    # atas dengan coverage DBNet 0.015-0.022; ambang 0.035 memberi label negatif
    # pada semua contoh tersebut. Gunakan ambang yang lebih peka untuk enam zona
    # sudut sambil tetap meminta pemeriksaan manusia sebelum data dipakai training.
    labels = [int(cov[0] >= 0.040), int(cov[1] >= 0.018)] + [int(v >= 0.015) for v in cov[2:]]
    return labels, cov


def main():
    import onnxruntime as ort

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", default=os.path.join(HERE, "dataset"))
    parser.add_argument("--dbnet", default=os.path.join(HERE, "models", "ch_PP-OCRv4_det.onnx"))
    parser.add_argument("--output", default=os.path.join(HERE, "dataset", "zone_text_distilled"))
    parser.add_argument("--checkpoint-every", type=int, default=100, help="Simpan manifest setiap N frame agar run panjang dapat dilanjutkan.")
    parser.add_argument("--intra-op-threads", type=int, default=2, help="Thread CPU ONNX Runtime untuk distilasi.")
    args = parser.parse_args()
    if not os.path.isfile(args.dbnet):
        raise SystemExit(f"DBNet model tidak ada: {args.dbnet}; jalankan download_models.py lebih dulu.")
    os.makedirs(args.output, exist_ok=True)
    session_options = ort.SessionOptions()
    session_options.intra_op_num_threads = max(1, args.intra_op_threads)
    session_options.inter_op_num_threads = 1
    session_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session = ort.InferenceSession(args.dbnet, sess_options=session_options, providers=["CPUExecutionProvider"])
    manifest = os.path.join(args.output, "manifest.csv")
    rows = []
    completed_sources = set()
    if os.path.isfile(manifest):
        with open(manifest, newline="", encoding="utf-8") as stream:
            rows = list(csv.DictReader(stream))
        completed_sources = {row["source"].replace("\\", "/") for row in rows}
        print(f"Melanjutkan manifest: {len(rows)} frame sudah tersimpan.")
    processed_since_checkpoint = 0
    out_abs = os.path.abspath(args.output)
    for root, dirs, files in os.walk(args.source):
        dirs[:] = [d for d in dirs if os.path.abspath(os.path.join(root, d)) != out_abs]
        for name in files:
            src = os.path.join(root, name)
            if os.path.splitext(name)[1].lower() not in IMAGE_EXTS:
                continue
            relative = os.path.relpath(src, args.source)
            normalized_relative = relative.replace("\\", "/")
            if normalized_relative in completed_sources:
                continue
            image = cv2.imread(src)
            if image is None or image.size == 0:
                print(f"[skip] gambar tidak terbaca: {relative}")
                continue
            labels, coverage = detect_zones(session, image)
            split = split_for(relative)
            file_id = hashlib.sha1(relative.encode("utf-8")).hexdigest()[:16] + ".jpg"
            destination = os.path.join(args.output, "images", split, file_id)
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            crop = cv2.resize(image, (224, 224), interpolation=cv2.INTER_AREA)
            cv2.imwrite(destination, crop, [cv2.IMWRITE_JPEG_QUALITY, 92])
            row = {"image": os.path.relpath(destination, args.output).replace("\\", "/"), "source": normalized_relative, "split": split}
            row.update({name: labels[i] for i, name in enumerate(ZONE_NAMES)})
            row.update({name + "_coverage": round(coverage[i], 6) for i, name in enumerate(ZONE_NAMES)})
            rows.append(row)
            completed_sources.add(normalized_relative)
            processed_since_checkpoint += 1
            if args.checkpoint_every > 0 and processed_since_checkpoint >= args.checkpoint_every:
                write_manifest(manifest, rows)
                processed_since_checkpoint = 0
                print(f"[checkpoint] {len(rows)} frame tersimpan; lanjut distilasi.")
    if not rows:
        raise SystemExit(f"Tidak ada gambar untuk distilasi di {args.source}. Tambahkan gambar train/val terlebih dahulu.")
    write_manifest(manifest, rows)
    print(f"Selesai: {len(rows)} frame berlabel DBNet; train={sum(r['split']=='train' for r in rows)}, val={sum(r['split']=='val' for r in rows)}")
    print(f"Manifest: {manifest}")


if __name__ == "__main__":
    main()
