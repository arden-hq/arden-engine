"""Suite-specific input adapters. Gold never enters candidate jobs."""

import base64
import hashlib
import csv
import json
from datetime import datetime, timezone
from pathlib import Path

SUITES = ("swe-bench-pro", "longmemeval", "browsecomp", "deepresearch")


def read_rows(path):
    path = Path(path)
    if path.suffix == ".csv":
        with path.open(newline="") as source:
            return list(csv.DictReader(source))
    text = path.read_text()
    return (
        json.loads(text)
        if text.lstrip().startswith("[")
        else [json.loads(line) for line in text.splitlines() if line.strip()]
    )


def required_text(row, name):
    value = row.get(name)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Missing nonempty {name}")
    return value


def case_for(suite, row):
    if suite == "swe-bench-pro":
        return {
            "id": required_text(row, "instance_id"),
            "prompts": [required_text(row, "problem_statement")],
        }
    if suite == "longmemeval":
        histories, dates, ids = (
            row[key]
            for key in ("haystack_sessions", "haystack_dates", "haystack_session_ids")
        )
        if not (len(histories) == len(dates) == len(ids)):
            raise ValueError("History, date and ID lengths differ")
        history = []
        for source, date, source_id in zip(histories, dates, ids):
            # Released classic data uses YYYY/MM/DD (weekday) HH:MM.
            try:
                parsed = datetime.fromisoformat(date.replace("Z", "+00:00"))
            except ValueError:
                parsed = datetime.strptime(date, "%Y/%m/%d (%a) %H:%M")
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            history.append(
                {
                    "id": str(source_id),
                    "date": parsed.isoformat(),
                    "messages": [
                        {"role": message["role"], "content": message["content"]}
                        for message in source
                    ],
                }
            )
        history.sort(key=lambda item: item["date"])
        return {
            "id": required_text(row, "question_id"),
            "prompts": [
                f"Question date: {row['question_date']}\n{required_text(row, 'question')}"
            ],
            "history": history,
        }
    if suite == "browsecomp":
        problem = required_text(row, "problem")
        if row.get("canary"):
            encrypted = base64.b64decode(problem, validate=True)
            key = hashlib.sha256(required_text(row, "canary").encode()).digest()
            problem = bytes(
                value ^ key[index % len(key)] for index, value in enumerate(encrypted)
            ).decode()
        prompt = (
            f"{problem}\n\nYour response should be in the following format:\n"
            "Explanation: {your explanation for your final answer}\n"
            "Exact Answer: {your succinct, final answer}\n"
            "Confidence: {your confidence score between 0% and 100% for your answer}"
        )
        return {
            "id": str(row.get("id", row.get("problem_id", ""))),
            "prompts": [prompt],
        }
    if suite == "deepresearch":
        return {"id": str(row["id"]), "prompts": [required_text(row, "prompt")]}
    raise ValueError(f"Unsupported suite: {suite}")


def official_prediction(suite, case_id, result, profile, patch=None):
    if suite == "swe-bench-pro":
        return {"instance_id": case_id, "prefix": profile, "patch": patch or ""}
    if suite == "longmemeval":
        return {"question_id": case_id, "hypothesis": result.get("text", "")}
    if suite == "deepresearch":
        return {
            "id": case_id,
            "prompt": result["prompt"],
            "article": result.get("text", ""),
        }
    return {"id": case_id, "response": result.get("text", "")}
