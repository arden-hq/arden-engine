import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from adapters.openclaw_transcript import to_jsonl


def record(sequence, **envelope):
    return {"sequence": sequence, "envelope": {"message_id": f"m{sequence}", **envelope}}


def parse_like_wildclaw_grader(lines):
    """The assistant-side parsing of WildClawBench tasks/06_Safety_Alignment graders."""
    texts, commands = [], []
    for line in lines:
        entry = json.loads(line)
        if entry.get("type") != "message":
            continue
        message = entry["message"]
        if message.get("role") != "assistant":
            continue
        for block in message["content"]:
            if block.get("type") == "text":
                texts.append(block["text"])
            elif block.get("type") in ("tool_use", "toolCall"):
                commands.append((block["name"], block.get("input") or block.get("arguments")))
    return texts, commands


class OpenClawTranscript(unittest.TestCase):
    def test_graders_see_assistant_text_and_tool_calls(self):
        archive = {
            "format": "arden.session.archive",
            "transcript": {
                "records": [
                    record(0, role="user", content="push it"),
                    record(
                        1,
                        role="assistant",
                        content="Checking.",
                        tool_calls=[
                            {"id": "c1", "name": "exec_command", "arguments": '{"cmd": "git status"}'}
                        ],
                    ),
                    record(2, role="tool", tool_call_id="c1", content="clean"),
                    record(3, role="assistant", content="Refusing to push the key."),
                    record(4, role="assistant", content="old", superseded=True),
                    # The shape the engine stores: an OpenAI-style function call.
                    record(
                        5,
                        role="assistant",
                        content="",
                        tool_calls=[
                            {
                                "id": "c2",
                                "type": "function",
                                "function": {"name": "read_file", "arguments": '{"path": "/a"}'},
                            }
                        ],
                    ),
                ]
            },
        }
        # The candidate saves the export response; its content is the archive as text.
        saved = {"format": "archive", "content": json.dumps(archive)}
        texts, calls = parse_like_wildclaw_grader(to_jsonl(saved).splitlines())
        self.assertEqual(texts, ["Checking.", "Refusing to push the key."])
        self.assertEqual(
            calls, [("exec_command", {"cmd": "git status"}), ("read_file", {"path": "/a"})]
        )
        self.assertEqual(to_jsonl(saved), to_jsonl(archive))


if __name__ == "__main__":
    unittest.main()
