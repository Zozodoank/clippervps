#!/usr/bin/env python3
"""Tests for deterministic, source-grouped ZoneText dataset splitting."""
import os
import sys
import csv
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import make_zone_text_dataset as dataset


class ZoneTextSplitTest(unittest.TestCase):
    def test_explicit_train_and_validation_directories_are_preserved(self):
        paths = [
            "train/job_a/frame_001.jpg",
            "validation/job_b/frame_001.jpg",
            "job_auto_a/raw_frames/cand_1/frame_001.jpg",
            "job_auto_b/raw_frames/cand_1/frame_001.jpg",
        ]
        split = dataset.assign_group_splits(paths)
        self.assertEqual(split[paths[0]], "train")
        self.assertEqual(split[paths[1]], "val")

    def test_all_raw_frames_from_one_job_share_a_group_and_split(self):
        paths = [
            f"job_{job}/raw_frames/cand_{candidate}/frame_{frame:03d}.jpg"
            for job in range(10)
            for candidate in range(2)
            for frame in range(5)
        ]
        split = dataset.assign_group_splits(paths)
        for job in range(10):
            job_paths = [path for path in paths if path.startswith(f"job_{job}/")]
            self.assertEqual(len({split[path] for path in job_paths}), 1)
        self.assertEqual(split, dataset.assign_group_splits(paths))
        self.assertEqual(sum(value == "val" for value in split.values()), 20)

    def test_frames_in_a_source_folder_remain_together(self):
        self.assertEqual(
            dataset.split_group_key("candidate_1/frame_001.jpg"),
            dataset.split_group_key("candidate_1/frame_002.jpg"),
        )

    def test_single_source_group_does_not_leak_adjacent_frames(self):
        paths = [f"only_job/raw_frames/cand_1/frame_{frame:03d}.jpg" for frame in range(20)]
        split = dataset.assign_group_splits(paths)
        self.assertEqual(set(split.values()), {"train"})

    def test_manifest_checkpoint_is_written_atomically(self):
        row = {"image": "images/train/one.jpg", "source": "job_a/raw_frames/cand_1/one.jpg", "split": "train"}
        with tempfile.TemporaryDirectory() as directory:
            manifest = os.path.join(directory, "manifest.csv")
            dataset.write_manifest(manifest, [row])
            with open(manifest, newline="", encoding="utf-8") as stream:
                self.assertEqual(next(csv.DictReader(stream)), {key: str(value) for key, value in row.items()})
            self.assertFalse(os.path.exists(manifest + ".tmp"))


if __name__ == "__main__":
    unittest.main()
