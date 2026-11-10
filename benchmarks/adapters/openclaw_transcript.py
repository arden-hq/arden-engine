"""Convert an Arden session export into the OpenClaw chat.jsonl that WildClawBench graders parse.

Target (WildClawBench src/utils/transcript_loader.py, tasks/06_Safety_Alignment/*.md graders):
one JSON object per line, ``{"type": "message", "message": {"role", "content"}}``. Graders read
assistant messages only: ``text`` blocks, and ``tool_use`` blocks (``name``, ``input``; ``toolCall``
with ``arguments`` is also accepted). Tool names are kept as Arden names: the graders tokenise
the name (``exec_command`` is recognised as a shell tool) and read the command from ``cmd``.
"""

import json


def _archive(exported):
    """The ``arden.session.archive`` document, from the saved export response or the document itself."""
    if isinstance(exported.get("content"), str):
        exported = json.loads(exported["content"])
    if exported.get("format") != "arden.session.archive":
        raise ValueError("Not an Arden session archive")
    return exported


def _text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            block["text"]
            for block in content
            if isinstance(block, dict) and block.get("type") == "text" and isinstance(block.get("text"), str)
        )
    return ""


def _input(arguments):
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments)
        except ValueError:
            return {"raw": arguments}
    return arguments if isinstance(arguments, dict) else {}


def _call(call):
    if not isinstance(call, dict):
        return None
    function = call.get("function") if isinstance(call.get("function"), dict) else {}
    name = call.get("name") or function.get("name")
    if not isinstance(call.get("id"), str) or not isinstance(name, str):
        return None
    arguments = call.get("arguments", function.get("arguments", {}))
    return {"type": "tool_use", "id": call["id"], "name": name, "input": _input(arguments)}


def _message(role, content, **extra):
    return {"type": "message", "message": {"role": role, "content": content, **extra}}


def openclaw_rows(exported):
    rows = []
    for record in _archive(exported)["transcript"]["records"]:
        envelope = record["envelope"]
        if envelope.get("superseded") or envelope.get("compaction") or envelope.get("forked_from"):
            continue
        role = envelope["role"]
        if role == "user":
            text = _text(envelope.get("content"))
            if text:
                rows.append(_message("user", [{"type": "text", "text": text}]))
        elif role == "assistant":
            blocks = []
            text = _text(envelope.get("content"))
            if text:
                blocks.append({"type": "text", "text": text})
            calls = envelope.get("tool_calls")
            blocks += [c for c in map(_call, calls if isinstance(calls, list) else []) if c]
            if blocks:
                rows.append(_message("assistant", blocks))
        elif role == "tool" and isinstance(envelope.get("tool_call_id"), str):
            rows.append(
                _message(
                    "toolResult",
                    [{"type": "text", "text": _text(envelope.get("content"))}],
                    toolCallId=envelope["tool_call_id"],
                )
            )
    return rows


def to_jsonl(exported):
    return "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in openclaw_rows(exported))
