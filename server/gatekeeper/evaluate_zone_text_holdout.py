#!/usr/bin/env python3
"""Evaluate a ZoneText ONNX artifact on manually reviewed TL overlay holdouts."""
import argparse
import csv
import os
import statistics
import time

import numpy as np
import onnxruntime as ort
from PIL import Image

MEAN = np.asarray([0.485, 0.456, 0.406], dtype=np.float32)
STD = np.asarray([0.229, 0.224, 0.225], dtype=np.float32)


def load_tensor(path):
    image = Image.open(path).convert("RGB").resize((224, 224))
    values = np.asarray(image, dtype=np.float32) / 255.0
    return np.ascontiguousarray(((values - MEAN) / STD).transpose(2, 0, 1)[None, ...])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, help="Root used by the distillation manifest crops.")
    parser.add_argument("--review", required=True, help="Manually reviewed CSV with job and crop columns.")
    parser.add_argument("--model", required=True, help="Candidate six-probability ONNX artifact.")
    parser.add_argument("--positive-job", action="append", required=True,
                        help="Reviewed source job with verified TL watermark/logo; repeat as needed.")
    parser.add_argument("--negative-job", action="append", required=True,
                        help="Reviewed source job with verified absence of TL overlay; repeat as needed.")
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--threads", type=int, default=2)
    args = parser.parse_args()

    positives, negatives = set(args.positive_job), set(args.negative_job)
    overlap = positives & negatives
    if overlap:
        raise SystemExit(f"Jobs cannot be both positive and negative: {sorted(overlap)}")

    samples = []
    with open(args.review, newline="", encoding="utf-8") as stream:
        for row in csv.DictReader(stream):
            job = row.get("job", "")
            if job not in positives and job not in negatives:
                continue
            crop = os.path.join(args.data, row["crop"])
            if not os.path.isfile(crop):
                raise SystemExit(f"Missing reviewed crop: {crop}")
            samples.append((job, int(job in positives), crop))
    if not samples:
        raise SystemExit("No manually reviewed rows matched the selected source jobs.")

    options = ort.SessionOptions()
    options.intra_op_num_threads = max(1, args.threads)
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(args.model, sess_options=options, providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name
    labels, predictions, elapsed_ms, jobs = [], [], [], []
    for job, label, crop in samples:
        tensor = load_tensor(crop)
        started = time.perf_counter()
        output = session.run(None, {input_name: tensor})[0]
        elapsed_ms.append((time.perf_counter() - started) * 1000)
        values = np.asarray(output).reshape(-1)
        if values.size != 6 or not np.isfinite(values).all():
            raise SystemExit(f"Expected six finite probabilities from model; got {values}")
        labels.append(label)
        predictions.append(int(values[2] >= args.threshold))  # LABELS order: bottom, top, TL, TR, BL, BR
        jobs.append(job)

    y, pred = np.asarray(labels, dtype=bool), np.asarray(predictions, dtype=bool)
    tp = int(np.logical_and(y, pred).sum())
    positives_n, negatives_n = int(y.sum()), int((~y).sum())
    fp = int(np.logical_and(~y, pred).sum())
    fn = int(np.logical_and(y, ~pred).sum())
    print(f"manual_holdout_rows={len(samples)} positives={positives_n} negatives={negatives_n} threshold={args.threshold:.3f}")
    print(f"TL_recall={tp / max(1, positives_n):.3f} ({tp}/{positives_n}) false_positive_rate={fp / max(1, negatives_n):.3f} ({fp}/{negatives_n}) FP={fp} FN={fn}")
    print(f"onnx_inference_ms median={statistics.median(elapsed_ms):.3f} p95={float(np.percentile(elapsed_ms, 95)):.3f}")
    for job in sorted(set(jobs)):
        selected = np.asarray([item == job for item in jobs])
        jy, jp = y[selected], pred[selected]
        job_tp = int(np.logical_and(jy, jp).sum())
        job_fp = int(np.logical_and(~jy, jp).sum())
        print(f"source={job} label={'positive' if bool(jy[0]) else 'negative'} rows={int(selected.sum())} TP={job_tp} FP={job_fp}")


if __name__ == "__main__":
    main()
