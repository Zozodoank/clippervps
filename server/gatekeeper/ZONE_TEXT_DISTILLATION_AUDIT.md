# ZoneText distillation review — 2026-10-07

## Data and reproducibility

- Source: retained Termux raw candidate frames under `/root/clippervps/server/temp/job_*/raw_frames/cand_*`.
- Available at audit time: 4,202 JPEG frames from 10 jobs and 18 job/candidate groups.
- A fixed-seed sample produced 400 frames, grouped by job into 300 train / 100 validation examples so frames from the same job did not cross splits.
- DBNet pseudo-label generation completed using `make_zone_text_dataset.py`; output stayed outside the repository at `/tmp/zone-distilled`.
- A fixed-seed visual sample of 200 rows was inspected in four contact sheets under `%TEMP%\clipper-zone-review`.

## Finding

The six-zone DBNet pseudo-labels are not reliable enough to train a replacement classifier. Several visibly present top-left creator/account overlays (including the recurring Instagram-style account label) had `TL=0`; many such frames had all six labels set to zero. This is a false-negative pattern in the teacher labels, so training on this sample would teach the same blind spot the student is meant to address. Product packaging also contains dense ordinary text, making manual review necessary to separate overlays from scene text.

## Decision

- ZoneText training is deferred until the source labels are curated or the missed top-left overlays are independently annotated. No model was exported and production continues to use DBNet.
- The 200-frame review does not certify the full dataset, model recall, the `<100 ms/frame` target, or parity against Kaggle.
- The existing backend contract tests cover response shape only; they do not establish model quality.

## Follow-up threshold investigation (2026-10-07)

- Zoomed the reviewed top-left zones for the validation frames. The recurring Instagram handle is visually legible, while DBNet zone coverage is consistently 0.015-0.022; the old 0.035 corner threshold labels these frames as negative.
- Lowered only the offline distillation script's corner pseudo-label threshold to 0.015. This is a dataset-labeling change only; it does not change the production DBNet detector or activate ZoneMob.
- At that point, the first 400-frame split put nearly all examples from that watermark source into validation (99/100 val examples; none of those frames were positives under the old threshold). The updated balanced split and its current limitations are recorded below. No ZoneMob model was exported.

## Balanced resplit and current gate (2026-10-07)

- Regenerated the subset with the 0.015 threshold and staged a balanced 300/100 train/validation split at `/tmp/zone-distilled-balanced` in the Ubuntu container. The manifest was read back from the device to verify the split.
- Train has 86 TL positives among 300 frames across 7 jobs; validation has 18 among 100 across 9 jobs. The watermark-bearing job contributes 79 train and 20 validation frames, so validation contains a same-source holdout, not an independent watermark-style holdout.
- Several TL-positive training samples are ordinary packaging text rather than creator overlays. The threshold therefore improves recall for the known overlay but also creates teacher-label false positives. The six-zone pseudo-labels are not curated ground truth.
- Manually reviewed the 10 TL-positive examples outside the known watermark-bearing job; they show product/packaging text rather than creator overlays. A separate temporary copy of the manifest has those TL labels corrected to zero. The DBNet labels for the other five zones remain pseudo-labels.
- An exploratory 12-epoch model was trained from that corrected copy in an isolated Ubuntu ARM64 venv using the official PyTorch CPU wheel. It was exported only to `/tmp/zonetext_v1_experimental.onnx` on the device (6,109,460 bytes); no model was copied into the repository or production model directory.
- Artifact validation with the Gatekeeper preprocessing and ONNX Runtime 1.30 on 100 validation frames passed the six-output shape check. At the current 0.5 thresholds, exact-match was 0.55; zone support `[bottom, top, TL, TR, BL, BR]` was `[16, 1, 18, 2, 18, 6]`; recall was `[0.938, 0.000, 0.944, 0.000, 0.889, 0.667]`; precision was `[0.882, 0.000, 0.944, 0.000, 0.800, 0.190]`. The validation holdout comes from the same watermark source, and the top/TR supports are too small for a quality claim.
- The same ONNX validation measured preprocessing plus inference at median 47.53 ms and p95 51.46 ms per frame with the service's two-thread ONNX Runtime settings. This meets the latency target on this device/sample, but the recall results fail the quality gate. The number is not a full Gatekeeper stage benchmark.
- The training script previously selected checkpoints by exact-match alone, which can choose a checkpoint that misses rare zones. It now selects by macro-F1, then mean per-zone recall, then exact-match; this exploratory artifact predates that change and needs a new run on better labels before comparison.
- Verification after that metric change: `py_compile` passed, a deterministic metric fixture confirmed unsupported zones are excluded from macro-F1 and sparse-zone misses reduce recall, and `test_zone_text_backend.py` passed both contract tests on the Ubuntu container.
- Windows training remains unavailable because Torch and ONNX Runtime imports fail on the missing desktop VC runtime. An attempt to invoke the official Microsoft Visual C++ Redistributable installer was rejected by command policy before execution; no installer ran and no system runtime changed. Device-side CPU training provided a local path without modifying system packages. Microsoft documents the [latest supported VC++ Redistributable](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist?view=msvc-170) and [app-local deployment](https://learn.microsoft.com/en-us/cpp/windows/deployment-in-visual-cpp?view=msvc-170).
- `GK_TEXT_BACKEND` remains `dbnet`; Kaggle remains the final production oracle. The candidate is not suitable for production until label review and an independent source/style holdout establish quality.
