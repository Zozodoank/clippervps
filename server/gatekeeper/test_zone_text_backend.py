#!/usr/bin/env python3
"""Contract test for the optional zonemob backend; no model artifact required."""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import service


class ZoneTextContractTest(unittest.TestCase):
    def test_zonemob_preserves_text_gatekeeper_return_shape(self):
        # bottom, top, TL, TR, BL, BR probabilities
        result = service.format_zonemob_verdict([0.91, 0.04, 0.12, 0.08, 0.03, 0.02])
        self.assertEqual(len(result), 5)
        suspicious, total_cov, bottom_cov, reason, corners = result
        self.assertTrue(suspicious)
        self.assertAlmostEqual(total_cov, 0.91)
        self.assertAlmostEqual(bottom_cov, 0.91)
        self.assertIn("zonemob", reason)
        self.assertEqual(set(corners), {"TL", "TR", "BL", "BR"})
        self.assertEqual(corners["TL"], 0.12)

    def test_clean_probabilities_pass_and_bad_shape_fails_closed(self):
        result = service.format_zonemob_verdict([[0.08, 0.05, 0.1, 0.12, 0.09, 0.11]])
        self.assertFalse(result[0])
        with self.assertRaises(ValueError):
            service.format_zonemob_verdict([0.1, 0.2])


if __name__ == "__main__":
    unittest.main()
