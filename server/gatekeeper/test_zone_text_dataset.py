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
        self.assertEqual(dataset.split_for("train/job_a/frame_001.jpg"), "train")
        self.assertEqual(dataset.split_for("validation/job_b/frame_001.jpg"), "val")

    def test_all_raw_frames_from_one_job_share_a_group_and_split(self):
        first = "job_auto_a/raw_frames/cand_1/frame_001.jpg"
        second = "job_auto_a/raw_frames/cand_6/frame_499.jpg"
        other_job = "job_auto_b/raw_frames/cand_1/frame_001.jpg"
        self.assertEqual(dataset.split_group_key(first), dataset.split_group_key(second))
        self.assertNotEqual(dataset.split_group_key(first), dataset.split_group_key(other_job))
        self.assertEqual(dataset.split_for(first), dataset.split_for(second))
        self.assertEqual(dataset.split_for(first), dataset.split_for(first))

    def test_frames_in_a_source_folder_remain_together(self):
        self.assertEqual(
            dataset.split_group_key("candidate_1/frame_001.jpg"),
            dataset.split_group_key("candidate_1/frame_002.jpg"),
        )

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
