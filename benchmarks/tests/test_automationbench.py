"""Contracts the harness comparison rests on: shared task selection and the paired test."""

import argparse
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "automationbench"))
from run import codex_usage, fingerprint, mcnemar, sample, summarize


class Comparison(unittest.TestCase):
    def test_same_seed_and_count_select_the_same_tasks_whatever_other_domains_exist(self):
        ids = [str(n) for n in range(1000, 1100)]
        first = sample(ids, 5, 0, "sales")
        self.assertEqual(first, sample(list(reversed(ids)), 5, 0, "sales"))
        self.assertNotEqual(first, sample(ids, 5, 1, "sales"))
        self.assertEqual(sample(ids[:3], 5, 0, "sales"), ids[:3])

    def test_mcnemar_exact_two_sided(self):
        self.assertEqual(mcnemar(0, 0), 1.0)
        self.assertEqual(mcnemar(5, 0), 0.0625)
        self.assertEqual(mcnemar(3, 3), 1.0)
        self.assertAlmostEqual(mcnemar(7, 1), 0.0703125)

    def test_manifest_survives_json_so_resume_matches(self):
        args = argparse.Namespace(
            harness="codex", model="m", reasoning_effort="low", timeout=60, seed=0
        )
        pin = fingerprint(args, [("sales", "1"), ("hr", "2")], "abc")
        self.assertEqual(json.loads(json.dumps(pin)), pin)

    def test_codex_usage_is_the_last_running_total(self):
        def turn(total, cached, output):
            return json.dumps(
                {
                    "type": "turn.completed",
                    "usage": {
                        "input_tokens": total,
                        "cached_input_tokens": cached,
                        "output_tokens": output,
                    },
                }
            )

        with tempfile.TemporaryDirectory() as temporary:
            events = Path(temporary) / "events.jsonl"
            events.write_text(f"not json\n{turn(100, 40, 5)}\n{turn(250, 90, 12)}\n")
            totals, turns, _, _ = codex_usage(events)
            self.assertEqual(totals, {"input": 160, "cached_input": 90, "output": 12})
            self.assertEqual(turns, 2)
            events.write_text("")
            self.assertIsNone(codex_usage(events)[0])

    def test_a_trial_without_usage_stays_out_of_token_means(self):
        row = {"status": "step_limit", "domain": "hr", "passed": False, "partial_credit": 0.0}
        usage = {"input": 10, "cached_input": 0, "output": 2}
        summary = summarize(
            [{**row, "seconds": 1, "usage": usage}, {**row, "seconds": 1, "usage": None}]
        )
        self.assertEqual(summary["tokens_mean"], 12)
        self.assertEqual(summary["trials_missing_usage"], 1)

if __name__ == "__main__":
    unittest.main()
