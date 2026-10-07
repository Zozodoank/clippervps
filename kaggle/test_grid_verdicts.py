"""Fast offline contract tests for strict 2x2 Oracle cell mapping."""
import ast
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("vlm_oracle_qwen.py")
TREE = ast.parse(MODULE_PATH.read_text(encoding="utf-8"))
FUNCTION = next(node for node in TREE.body
                if isinstance(node, ast.FunctionDef) and node.name == "resolve_grid_cell_verdicts")
NAMESPACE = {}
exec(compile(ast.Module(body=[FUNCTION], type_ignores=[]), str(MODULE_PATH), "exec"), NAMESPACE)


class GridVerdictTests(unittest.TestCase):
    def test_preserves_original_indexes_and_individually_verifies_missing_cells(self):
        expected = {
            11: ({"index": 2}, {"index": 11, "cell": 0}),
            24: ({"index": 6}, {"index": 24, "cell": 3}),
        }
        called = []

        def infer(index, location):
            called.append((index, location[1]["cell"]))
            return {"safe": False, "text": True, "reason": "subtitle"}

        verdicts = NAMESPACE["resolve_grid_cell_verdicts"](
            expected,
            [{"index": 11, "safe": True, "face": False, "text": False}],
            infer,
        )
        self.assertEqual([v["index"] for v in verdicts], [11, 24])
        self.assertEqual(called, [(24, 3)])
        self.assertTrue(verdicts[0]["safe"])
        self.assertTrue(verdicts[1]["verified"])
        self.assertTrue(verdicts[1]["text"])

    def test_invalid_and_unknown_model_indexes_do_not_cover_expected_cells(self):
        expected = {4: ({"index": 0}, {"index": 4, "cell": 0})}
        verdicts = NAMESPACE["resolve_grid_cell_verdicts"](
            expected,
            [{"index": 999, "safe": True}, {"index": "bad", "safe": True}],
            lambda _index, _location: {"safe": True, "text": False},
        )
        self.assertEqual(len(verdicts), 1)
        self.assertEqual(verdicts[0]["index"], 4)
        self.assertTrue(verdicts[0]["verified"])

    def test_unverifiable_cell_is_marked_unverified(self):
        expected = {8: ({"index": 2}, {"index": 8, "cell": 1})}
        verdicts = NAMESPACE["resolve_grid_cell_verdicts"](
            expected,
            [],
            lambda _index, _location: (_ for _ in ()).throw(RuntimeError("crop parse failed")),
        )
        self.assertFalse(verdicts[0]["verified"])
        self.assertIn("crop parse failed", verdicts[0]["reason"])


if __name__ == "__main__":
    unittest.main()
