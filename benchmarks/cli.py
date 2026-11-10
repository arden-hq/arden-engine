#!/usr/bin/env python3
"""Developer benchmark entrypoint; official suites retain scoring ownership."""

import argparse
import hashlib
import json
import os
import signal
import subprocess
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path

from datasets import SUITES, case_for, official_prediction, read_rows
from mcp_env import mcp_environment

ROOT = Path(__file__).resolve().parent.parent


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.chmod(0o600)
    temporary.replace(path)


def checked(command, **kwargs):
    return subprocess.run(command, check=True, text=True, **kwargs)


def billed_tokens(usage):
    """An Arden usage.json in billing buckets; promptTokens is the uncached input."""
    return {
        "input": usage["promptTokens"],
        "cached_input": usage["cacheReadTokens"],
        "output": usage["completionTokens"],
        "cache_write": usage["cacheWriteTokens"],
    }


def dollars(tokens, prices):
    """Prices are $ per million tokens; cache writes cost input unless priced."""
    return (
        tokens["input"] * prices["input"]
        + tokens["cached_input"] * prices["cached_input"]
        + tokens["output"] * prices["output"]
        + tokens.get("cache_write", 0) * prices.get("cache_write", prices["input"])
    ) / 1e6


def moment(text):
    """An ISO time; Python before 3.11 does not read a trailing Z."""
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def harbor_report(args):
    """Per-trial reward, tokens, $ and seconds for an Arden Harbor jobs folder."""
    prices = json.loads(Path(args.prices).read_text()) if args.prices else None
    rows = []
    for result_path in sorted(Path(args.jobs_dir).resolve().rglob("result.json")):
        result = json.loads(result_path.read_text())
        if "verifier_result" not in result or "trial_name" not in result:
            continue
        usage_files = list(result_path.parent.rglob("arden/observations/usage.json"))
        tokens = billed_tokens(json.loads(usage_files[0].read_text())) if usage_files else None
        rewards = (result.get("verifier_result") or {}).get("rewards") or {}
        started, finished = result.get("started_at"), result.get("finished_at")
        rows.append(
            {
                "trial": result["trial_name"],
                # Harbor's `reward`, WildClawBench's `overall_score`, or a sole score.
                "reward": rewards.get(
                    "reward",
                    rewards.get(
                        "overall_score",
                        next(iter(rewards.values())) if len(rewards) == 1 else None,
                    ),
                ),
                "error": (result.get("exception_info") or {}).get("exception_type"),
                "tokens": tokens,
                "dollars": dollars(tokens, prices) if tokens and prices else None,
                "seconds": (
                    (moment(finished) - moment(started)).total_seconds()
                    if started and finished
                    else None
                ),
            }
        )
    graded = [row["reward"] for row in rows if row["reward"] is not None]
    costs = [row["dollars"] for row in rows if row["dollars"] is not None]
    print(
        json.dumps(
            {
                "trials": len(rows),
                "graded": len(graded),
                "reward_mean": sum(graded) / len(graded) if graded else None,
                # A trial with no reward (an error or a timeout) counts as zero here.
                "reward_mean_ungraded_as_zero": sum(graded) / len(rows) if rows else None,
                "dollars_mean": sum(costs) / len(costs) if costs else None,
                "dollars_total": sum(costs) if costs else None,
                "rows": rows,
            },
            indent=2,
        )
    )


def fingerprint(args, selection):
    profile = Path(args.profile).read_bytes()
    # An experiment written under benchmarks/ is not part of the code it ran.
    output = Path(args.output).resolve()
    adapters = b"".join(
        str(path.relative_to(ROOT)).encode() + b"\0" + path.read_bytes()
        for path in sorted((ROOT / "benchmarks").rglob("*"))
        if path.is_file()
        and path.suffix in (".py", ".mjs", ".json")
        and "__pycache__" not in path.parts
        and "results" not in path.parts
        and not path.name.startswith("local")
        and output not in path.parents
    )
    return {
        "version": 1,
        "runtime_image": args.image,
        "suite": args.suite,
        "dataset_sha256": digest(Path(args.data).read_bytes()),
        "profile_sha256": digest(profile),
        "adapter_sha256": digest(adapters),
        "selection": selection,
        "repeats": args.repeats,
    }


def invoke_candidate(profile, job, directory, image=None):
    environment = {
        key: value
        for key, value in os.environ.items()
        if key in ("PATH", "LANG", "LC_ALL", "SYSTEMROOT")
    }
    config = json.loads(Path(profile).read_text())
    if config["apiKeyEnv"] not in os.environ:
        raise ValueError(f"Missing {config['apiKeyEnv']}")
    environment[config["apiKeyEnv"]] = os.environ[config["apiKeyEnv"]]
    if config.get("accountIdEnv"):
        if config["accountIdEnv"] not in os.environ:
            raise ValueError(f"Missing {config['accountIdEnv']}")
        environment[config["accountIdEnv"]] = os.environ[config["accountIdEnv"]]
    mcp_values = mcp_environment(config, os.environ.get)
    environment.update(mcp_values)
    environment["ARDEN_DIR"] = str(directory / "state")
    # Do not inherit the user's home/configuration or search credentials implicitly.
    environment["HOME"] = str(directory / "home")
    Path(environment["HOME"]).mkdir(mode=0o700)
    container = "arden-benchmark-" + uuid.uuid4().hex
    command = [
        os.environ.get("ARDEN_BENCH_NODE", "node"),
        str(ROOT / "benchmarks/candidate.mjs"),
        str(Path(profile).resolve()),
        str(job),
    ]
    if image:
        command = [
            "docker",
            "run",
            "--rm",
            "--name",
            container,
            "--security-opt",
            "seccomp=unconfined",
            "--security-opt",
            "systempaths=unconfined",
            "--mount",
            f"type=bind,src={directory},dst=/trial",
            "--mount",
            f"type=bind,src={Path(profile).resolve()},dst=/profile.json,readonly",
            "--env",
            config["apiKeyEnv"],
            *(["--env", config["accountIdEnv"]] if config.get("accountIdEnv") else []),
            *(part for source in mcp_values for part in ("--env", source)),
            "--env",
            "ARDEN_DIR=/trial/state",
            "--env",
            "HOME=/trial/home",
            "--workdir",
            "/opt/arden",
            image,
            "node",
            "benchmarks/candidate.mjs",
            "/profile.json",
            "/trial/job.json",
        ]
        # Docker's connection configuration is host-owned; it is not forwarded into the container.
        environment = {**os.environ}
    with (directory / "candidate.log").open("w") as log:
        process = subprocess.Popen(
            command,
            cwd=ROOT,
            env=environment,
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        # The runner's own stop (signal.SIGTERM) lets it export what it has.
        (directory / "candidate.pid").write_text(str(process.pid))
        try:
            # The runner stops itself at timeoutMs, counted from its start, then
            # exports the transcript; the extra minute is for that export.
            return process.wait(timeout=config["timeoutMs"] / 1000 + 60)
        except (subprocess.TimeoutExpired, KeyboardInterrupt):
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            raise
        finally:
            if image:
                try:
                    subprocess.run(
                        ["docker", "rm", "-f", container],
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        timeout=20,
                    )
                except subprocess.TimeoutExpired:
                    print(f"Could not remove container {container}", file=sys.stderr)


def run(args):
    if not args.allow_model_calls:
        raise ValueError("Model calls require --allow-model-calls; use inspect first")
    if args.suite == "swe-bench-pro":
        raise ValueError(
            "Run SWE-bench Pro per instance inside its official image using single; the batch driver cannot fabricate repository environments"
        )
    # Resolve once: parallel source edits or rebuilding the tag cannot change this experiment.
    args.image = checked(
        ["docker", "image", "inspect", "--format", "{{.Id}}", args.image],
        capture_output=True,
    ).stdout.strip()
    rows = read_rows(args.data)
    cases = []
    for index, row in enumerate(rows):
        case = case_for(args.suite, row)
        if not case["id"] and args.suite == "browsecomp":
            case["id"] = str(index)
        if args.ids and case["id"] not in args.ids:
            continue
        cases.append(case)
    if args.limit:
        cases = cases[: args.limit]
    ids = [case["id"] for case in cases]
    if not cases or len(ids) != len(set(ids)):
        raise ValueError("Selection must be nonempty with unique IDs")
    if args.ids and not set(args.ids).issubset(ids):
        raise ValueError("Some requested IDs were missing or excluded by limit")
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    pin = fingerprint(args, ids)
    manifest = output / "manifest.json"
    if manifest.exists():
        if not args.resume or json.loads(manifest.read_text()) != pin:
            raise ValueError("Existing experiment differs or --resume was not supplied")
    else:
        write_json(manifest, pin)
    for case in cases:
        for repeat in range(args.repeats):
            trial = output / "trials" / digest(case["id"].encode())[:20] / str(repeat)
            if (trial / "receipt.json").exists():
                continue
            trial.mkdir(parents=True, exist_ok=True, mode=0o700)
            # An incomplete attempt is never resumed against freshly reset state.
            attempts = trial / "attempts"
            attempts.mkdir(exist_ok=True)
            directory = attempts / str(len(list(attempts.iterdir())))
            directory.mkdir(mode=0o700)
            workspace = directory / "workspace"
            workspace.mkdir()
            job = {
                **case,
                "workspace": "/trial/workspace",
                "output": "/trial/observations",
            }
            job_path = directory / "job.json"
            write_json(job_path, job)
            started = time.monotonic()
            try:
                try:
                    code = invoke_candidate(args.profile, job_path, directory, args.image)
                except subprocess.TimeoutExpired:
                    # Killed after its time limit: an error trial, not a retry.
                    write_json(directory / "interruption.json", {"type": "TimeoutExpired"})
                    code = None
                result_path = directory / "observations/result.json"
                result = (
                    json.loads(result_path.read_text())
                    if result_path.exists()
                    else {"status": "error", "error": "Candidate produced no result"}
                )
                receipt = {
                    "id": case["id"],
                    "repeat": repeat,
                    "exit_code": code,
                    "status": result["status"] if code == 0 else "error",
                    "seconds": time.monotonic() - started,
                    "attempt": str(directory.relative_to(output)),
                    "prediction": official_prediction(
                        args.suite,
                        case["id"],
                        {**result, "prompt": case["prompts"][-1]},
                        pin["profile_sha256"],
                    ),
                }
            except KeyboardInterrupt:
                write_json(directory / "interruption.json", {"type": "KeyboardInterrupt"})
                raise
            write_json(trial / "receipt.json", receipt)
            print(f"{case['id']} repeat={repeat} {receipt['status']}", flush=True)
    export_predictions(output)


def export_predictions(output):
    receipts = [
        json.loads(path.read_text())
        for path in sorted(output.glob("trials/*/*/receipt.json"))
    ]
    for repeat in sorted({item["repeat"] for item in receipts}):
        target = output / f"predictions-{repeat}.jsonl"
        target.write_text(
            "".join(
                json.dumps(item["prediction"]) + "\n"
                for item in receipts
                if item["repeat"] == repeat
            )
        )
        target.chmod(0o600)
    return receipts


def single(args):
    """A candidate invocation for benchmark-owned sandboxes; upstream owns reset/scoring."""
    if not args.allow_model_calls:
        raise ValueError("Model calls require --allow-model-calls")
    directory = Path(args.output).resolve()
    directory.mkdir(parents=True, exist_ok=False, mode=0o700)
    prompt = Path(args.prompt_file).read_text()
    workspace = Path(args.workspace).resolve()
    job = {
        "id": args.id,
        "prompts": [prompt],
        "workspace": str(workspace),
        "output": str(directory / "observations"),
    }
    write_json(directory / "job.json", job)
    base = None
    if args.patch:
        base = checked(
            ["git", "rev-parse", "HEAD"], cwd=workspace, capture_output=True
        ).stdout.strip()
        if checked(
            ["git", "status", "--porcelain"], cwd=workspace, capture_output=True
        ).stdout:
            raise ValueError("Patch trials require a clean benchmark checkout")
        write_json(directory / "base.json", {"commit": base})
    try:
        code = invoke_candidate(args.profile, directory / "job.json", directory)
    except subprocess.TimeoutExpired:
        # Killed after its time limit; the patch below is still what it left.
        write_json(directory / "interruption.json", {"type": "TimeoutExpired"})
        code = 124
    if args.patch:
        # Include new files without touching the task's index.
        env = {**os.environ, "GIT_INDEX_FILE": str(directory / "patch.index")}
        checked(["git", "read-tree", base], cwd=workspace, env=env)
        checked(["git", "add", "-A"], cwd=workspace, env=env)
        # Bytes: a diff of a file that is not UTF-8 must not stop the export.
        raw = subprocess.run(
            ["git", "diff", "--cached", "--binary", base],
            cwd=workspace,
            env=env,
            capture_output=True,
            check=True,
        ).stdout
        (directory / "patch.diff").write_bytes(raw)
        patch = raw.decode("utf-8", errors="replace")
        result_path = directory / "observations/result.json"
        result = (
            json.loads(result_path.read_text())
            if result_path.exists()
            else {"status": "error"}
        )
        write_json(
            directory / "prediction.json",
            [
                official_prediction(
                    "swe-bench-pro",
                    args.id,
                    result,
                    json.loads(Path(args.profile).read_text())["name"],
                    patch,
                )
            ],
        )
    return code


def regrade(args):
    output = Path(args.output).resolve()
    export_predictions(output)
    if not args.command:
        raise ValueError(
            "Pass the official grader command after --; {predictions} expands to one repeat's output"
        )
    folder = output / "grading" / str(time.time_ns())
    folder.mkdir(parents=True)
    write_json(folder / "command.json", args.command)
    for prediction in sorted(output.glob("predictions-*.jsonl")):
        command = [
            part.replace("{predictions}", str(prediction)) for part in args.command
        ]
        with (folder / f"{prediction.stem}.log").open("w") as log:
            checked(command, stdout=log, stderr=subprocess.STDOUT)
    print(folder)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    inspect = sub.add_parser("inspect")
    inspect.add_argument("--suite", choices=SUITES, required=True)
    inspect.add_argument("--data", required=True)
    batch = sub.add_parser("run")
    batch.add_argument("--suite", choices=SUITES, required=True)
    batch.add_argument("--data", required=True)
    batch.add_argument(
        "--image",
        required=True,
        help="Built runtime image; resolved to immutable image ID before trials",
    )
    batch.add_argument("--profile", required=True)
    batch.add_argument("--output", required=True)
    batch.add_argument("--limit", type=int)
    batch.add_argument("--ids", nargs="+")
    batch.add_argument("--repeats", type=int, default=1)
    batch.add_argument("--resume", action="store_true")
    batch.add_argument("--allow-model-calls", action="store_true")
    one = sub.add_parser("single")
    for field in ("profile", "prompt-file", "workspace", "output", "id"):
        one.add_argument("--" + field, required=True)
    one.add_argument("--patch", action="store_true")
    one.add_argument("--allow-model-calls", action="store_true")
    harbor = sub.add_parser("harbor-report")
    harbor.add_argument("--jobs-dir", required=True)
    harbor.add_argument("--prices", help="JSON of $ per million input, cached_input, output tokens")
    report = sub.add_parser("report")
    report.add_argument("--output", required=True)
    grader = sub.add_parser("regrade")
    grader.add_argument("--output", required=True)
    grader.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.action == "inspect":
        rows = read_rows(args.data)
        cases = [case_for(args.suite, row) for row in rows]
        for index, case in enumerate(cases):
            if args.suite == "browsecomp" and not case["id"]:
                case["id"] = str(index)
        print(
            json.dumps(
                {
                    "suite": args.suite,
                    "cases": len(cases),
                    "dataset_sha256": digest(Path(args.data).read_bytes()),
                    "ids": [case["id"] for case in cases],
                },
                indent=2,
            )
        )
    elif args.action == "run":
        if args.repeats < 1 or (args.limit is not None and args.limit < 1):
            raise ValueError("Repeats and limit must be positive")
        run(args)
    elif args.action == "single":
        return single(args)
    elif args.action == "harbor-report":
        harbor_report(args)
    elif args.action == "regrade":
        if args.command[:1] == ["--"]:
            args.command = args.command[1:]
        regrade(args)
    else:
        receipts = export_predictions(Path(args.output).resolve())
        totals = {
            "modelRequests": 0,
            "promptTokens": 0,
            "completionTokens": 0,
            "cacheReadTokens": 0,
            "cacheWriteTokens": 0,
        }
        missing_usage = 0
        for row in receipts:
            usage_file = (
                Path(args.output).resolve() / row["attempt"] / "observations/usage.json"
            )
            if not usage_file.exists():
                missing_usage += 1
                continue
            usage = json.loads(usage_file.read_text())
            for key in totals:
                totals[key] += usage.get(key, 0)
        print(
            json.dumps(
                {
                    "usage": totals,
                    "trials_missing_usage": missing_usage,
                    "trials": len(receipts),
                    "execution_completed": sum(
                        row["status"] == "completed" for row in receipts
                    ),
                    "execution_errors": sum(
                        row["status"] != "completed" for row in receipts
                    ),
                    "seconds": sum(row["seconds"] for row in receipts),
                    "note": "Execution completion is not benchmark success; see official grader output.",
                },
                indent=2,
            )
        )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
