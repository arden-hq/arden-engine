import base64
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from datasets import case_for, official_prediction
import cli
from cli import export_predictions, write_json


class Adapters(unittest.TestCase):
    def test_memory_excludes_gold_and_retains_roles(self):
        row = {
            "question_id": "q",
            "question_date": "2025-01-03",
            "question": "Name?",
            "answer": "SECRET",
            "haystack_sessions": [
                [
                    {"role": "user", "content": "Project A", "has_answer": True},
                    {"role": "assistant", "content": "Okay"},
                ]
            ],
            "haystack_dates": ["2025/01/02 (Thu) 12:00"],
            "haystack_session_ids": ["s"],
            "answer_session_ids": ["s"],
        }
        candidate = case_for("longmemeval", row)
        self.assertNotIn("SECRET", json.dumps(candidate))
        self.assertNotIn("has_answer", json.dumps(candidate))
        self.assertEqual(candidate["history"][0]["messages"][1]["role"], "assistant")
        row["haystack_dates"] = []
        with self.assertRaises(ValueError):
            case_for("longmemeval", row)

    def test_memory_rejects_a_session_the_importer_cannot_store(self):
        row = {
            "question_id": "q",
            "question_date": "2025-01-03",
            "question": "Name?",
            "haystack_sessions": [[{"role": "assistant", "content": "Hello"}]],
            "haystack_dates": ["2025/01/02 (Thu) 12:00"],
            "haystack_session_ids": ["s"],
        }
        with self.assertRaisesRegex(ValueError, "session s"):
            case_for("longmemeval", row)

    def test_deepresearch_prediction_keeps_the_upstream_integer_id(self):
        case = case_for("deepresearch", {"id": 7, "prompt": "Write"})
        prediction = official_prediction(
            "deepresearch", case["id"], {"prompt": "Write", "text": "Done"}, "p"
        )
        self.assertEqual(prediction["id"], 7)

    def test_browsecomp_decrypts_only_question(self):
        text = "Who made this?"
        canary = "fixture"
        key = hashlib.sha256(canary.encode()).digest()
        encrypted = base64.b64encode(
            bytes(
                value ^ key[index % len(key)]
                for index, value in enumerate(text.encode())
            )
        ).decode()
        result = case_for(
            "browsecomp", {"problem": encrypted, "canary": canary, "answer": "SECRET"}
        )
        self.assertTrue(result["prompts"][0].startswith(text))
        self.assertNotIn("SECRET", json.dumps(result))
        self.assertIn("Exact Answer:", result["prompts"][0])

    def test_swe_pro_contract(self):
        self.assertEqual(
            official_prediction("swe-bench-pro", "x", {}, "p", "diff"),
            {"instance_id": "x", "prefix": "p", "patch": "diff"},
        )

    def test_errors_remain_in_denominator_and_repeats_separate(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for repeat in [0, 1]:
                write_json(
                    root / f"trials/x/{repeat}/receipt.json",
                    {
                        "id": "q",
                        "repeat": repeat,
                        "status": "error",
                        "prediction": {"id": "q", "response": ""},
                    },
                )
            self.assertEqual(len(export_predictions(root)), 2)
            self.assertEqual(
                len((root / "predictions-0.jsonl").read_text().splitlines()), 1
            )


class ScorerContract(unittest.TestCase):
    def test_browsecomp_parser_preserves_yes_and_no(self):
        from grade import normalize_browse_grade

        self.assertEqual(normalize_browse_grade("correct: yes"), "yes")
        self.assertEqual(normalize_browse_grade("correct: no"), "no")
        self.assertEqual(normalize_browse_grade("no"), "no")
        with self.assertRaises(ValueError):
            normalize_browse_grade("unexpected")


class PatchExport(unittest.TestCase):
    def test_new_committed_files_are_diffed_against_original_base(self):
        import argparse
        import subprocess
        from unittest.mock import patch
        from cli import single

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace = root / "repo"
            workspace.mkdir()

            def git(*args):
                return subprocess.run(
                    ["git", *args],
                    cwd=workspace,
                    check=True,
                    capture_output=True,
                    text=True,
                )

            git("init")
            git("config", "user.name", "Fixture")
            git("config", "user.email", "fixture@example.invalid")
            (workspace / "base.txt").write_text("base\n")
            git("add", ".")
            git("commit", "-m", "base")
            (root / "prompt").write_text("Implement fixture")
            (root / "profile.json").write_text('{"name":"fixture"}')

            def fake_candidate(profile, job, directory, **options):
                (workspace / "new.txt").write_text("implemented\n")
                git("add", ".")
                git("commit", "-m", "candidate commit")
                write_json(
                    directory / "observations/result.json",
                    {"status": "completed", "text": "done"},
                )
                return 0

            args = argparse.Namespace(
                allow_model_calls=True,
                output=str(root / "out"),
                prompt_file=str(root / "prompt"),
                workspace=str(workspace),
                id="case",
                profile=str(root / "profile.json"),
                patch=True,
                keep_home=False,
            )
            with patch("cli.invoke_candidate", fake_candidate):
                self.assertEqual(single(args), 0)
            result = json.loads((root / "out/prediction.json").read_text())
            self.assertIn("+implemented", result[0]["patch"])
            self.assertEqual(git("status", "--porcelain").stdout, "")

    def test_a_timed_out_trial_still_exports_a_patch_that_is_not_utf8(self):
        import argparse
        import subprocess
        from unittest.mock import patch
        from cli import single

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace = root / "repo"
            workspace.mkdir()

            def git(*args):
                subprocess.run(["git", *args], cwd=workspace, check=True, capture_output=True)

            git("init")
            git("config", "user.name", "Fixture")
            git("config", "user.email", "fixture@example.invalid")
            (workspace / "base.txt").write_bytes(b"caf\xe9\n")
            git("add", ".")
            git("commit", "-m", "base")
            (root / "prompt").write_text("Implement fixture")
            (root / "profile.json").write_text('{"name":"fixture"}')

            def fake_candidate(profile, job, directory, **options):
                (workspace / "base.txt").write_bytes(b"caf\xe9 au lait\n")
                raise subprocess.TimeoutExpired("node", 1)

            args = argparse.Namespace(
                allow_model_calls=True,
                output=str(root / "out"),
                prompt_file=str(root / "prompt"),
                workspace=str(workspace),
                id="case",
                profile=str(root / "profile.json"),
                patch=True,
                keep_home=False,
            )
            with patch("cli.invoke_candidate", fake_candidate):
                self.assertEqual(single(args), 124)
            self.assertIn(b"+caf\xe9 au lait", (root / "out/patch.diff").read_bytes())
            self.assertIn("au lait", json.loads((root / "out/prediction.json").read_text())[0]["patch"])


class HarborReport(unittest.TestCase):
    def test_ungraded_trials_count_and_utc_times_parse(self):
        import argparse
        import contextlib
        import io
        from cli import harbor_report

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            times = {"started_at": "2026-01-01T00:00:00Z", "finished_at": "2026-01-01T00:01:00Z"}
            write_json(
                root / "a/result.json",
                {"trial_name": "a", "verifier_result": {"rewards": {"reward": 1.0}}, **times},
            )
            write_json(
                root / "b/result.json",
                {
                    "trial_name": "b",
                    "verifier_result": None,
                    "exception_info": {"exception_type": "AgentTimeoutError"},
                    **times,
                },
            )
            printed = io.StringIO()
            with contextlib.redirect_stdout(printed):
                harbor_report(argparse.Namespace(jobs_dir=str(root), prices=None))
            report = json.loads(printed.getvalue())
            self.assertEqual(report["reward_mean"], 1.0)
            self.assertEqual(report["reward_mean_ungraded_as_zero"], 0.5)
            self.assertEqual(report["rows"][0]["seconds"], 60)


class RunnerProcess(unittest.TestCase):
    """invoke_candidate against a stand-in runner: a shell script, no server."""

    def invoke(self, script, timeout_ms, **options):
        root = Path(self.enterContext(tempfile.TemporaryDirectory())).resolve()
        runner = root / "runner.sh"
        runner.write_text("#!/bin/sh\n" + script)
        runner.chmod(0o700)
        (root / "profile.json").write_text(
            json.dumps({"apiKeyEnv": "BENCH_FIXTURE_KEY", "timeoutMs": timeout_ms})
        )
        trial = root / "trial"
        trial.mkdir()
        variables = {
            "ARDEN_BENCH_NODE": str(runner),
            "BENCH_FIXTURE_KEY": "fixture-not-a-secret",
            "HOME": str(root),
            "BENCH_UNRELATED": "must-not-pass",
        }
        with patch.dict(os.environ, variables), patch.object(cli, "EXPORT_GRACE_S", 0):
            try:
                code = cli.invoke_candidate(
                    root / "profile.json", trial / "job.json", trial, **options
                )
            except subprocess.TimeoutExpired:
                code = "timeout"
        return root, trial, code

    def test_a_runner_past_its_time_limit_is_stopped_with_its_children(self):
        script = (
            'trap "echo stopped > $(dirname $ARDEN_DIR)/stopped; exit 1" TERM\n'
            "sleep 60 & echo $! > $(dirname $ARDEN_DIR)/child.pid\nwait\n"
        )
        started = time.monotonic()
        _, trial, code = self.invoke(script, 1500)
        self.assertEqual(code, "timeout")
        self.assertLess(time.monotonic() - started, 20)
        self.assertEqual((trial / "stopped").read_text().strip(), "stopped")
        child = int((trial / "child.pid").read_text())
        time.sleep(0.2)
        with self.assertRaises(ProcessLookupError):
            os.kill(child, 0)

    def test_the_runner_gets_an_empty_home_unless_told_to_keep_it(self):
        script = 'echo "$HOME|${BENCH_UNRELATED:-}|$BENCH_FIXTURE_KEY"\n'
        root, trial, code = self.invoke(script, 5000)
        self.assertEqual(code, 0)
        self.assertEqual(
            (trial / "candidate.log").read_text().strip(),
            f"{trial / 'home'}||fixture-not-a-secret",
        )
        root, trial, code = self.invoke(script, 5000, keep_home=True)
        self.assertEqual((trial / "candidate.log").read_text().split("|")[0], str(root))
        self.assertFalse((trial / "home").exists())


if __name__ == "__main__":
    unittest.main()
