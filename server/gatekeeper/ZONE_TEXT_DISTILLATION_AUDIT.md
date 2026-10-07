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
- The current 400-frame subset puts nearly all examples from that watermark source into validation (99/100 val examples; none of those frames were positives under the old threshold). The dataset must be regenerated with the updated script and reviewed for train/validation balance before training. No ZoneMob model was exported.
