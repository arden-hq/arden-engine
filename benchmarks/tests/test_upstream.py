"""Optional native scorer contract: point BROWSECOMP_CHECKOUT at the pinned checkout."""

import argparse
import base64
import hashlib
import importlib
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from grade import grade_browse


@unittest.skipUnless(
    os.environ.get("BROWSECOMP_CHECKOUT"),
    "optional pinned upstream checkout not configured",
)
class NativeBrowseComp(unittest.TestCase):
    def test_native_aggregation_with_fake_judge(self):
        checkout = Path(os.environ["BROWSECOMP_CHECKOUT"]).resolve()
        package = types.ModuleType("arden_simple_evals")
        package.__path__ = [str(checkout)]
        sys.modules[package.__name__] = package
        sampler = importlib.import_module(
            "arden_simple_evals.sampler.chat_completion_sampler"
        )
        native = importlib.import_module("arden_simple_evals.types")

        class FakeJudge:
            def __init__(self, **kwargs):
                pass

            def _pack_message(self, role, content):
                return {"role": role, "content": content}

            def __call__(self, messages):
                return native.SamplerResponse("correct: yes", messages, {})

        def encrypt(text):
            key = hashlib.sha256(b"fixture").digest()
            return base64.b64encode(
                bytes(
                    value ^ key[index % len(key)]
                    for index, value in enumerate(text.encode())
                )
            ).decode()

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "data.json").write_text(
                json.dumps(
                    [
                        {
                            "id": "q",
                            "problem": encrypt("Who?"),
                            "answer": encrypt("Ada"),
                            "canary": "fixture",
                        }
                    ]
                )
            )
            (root / "predictions.jsonl").write_text(
                '{"id":"q","response":"Exact Answer: Ada"}\n'
            )
            args = argparse.Namespace(
                upstream=checkout,
                predictions=root / "predictions.jsonl",
                data=root / "data.json",
                judge="fake",
            )
            with patch.object(sampler, "ChatCompletionSampler", FakeJudge):
                grade_browse(args, root)
            result = json.loads((root / "score.json").read_text())
            self.assertEqual(result["result"]["score"], 1)
            self.assertEqual(
                result["scorer_variant"], "upstream-with-correct-label-parser-v1"
            )


if __name__ == "__main__":
    unittest.main()
