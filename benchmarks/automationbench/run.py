#!/usr/bin/env python3
"""Run AutomationBench (api toolset) tasks through Arden or Codex and grade with the upstream rubric."""

import argparse
import json
import math
import os
import random
import shutil
import signal
import threading
import subprocess
import sys
import time
from math import comb
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from cli import (  # noqa: E402
    ROOT,
    billed_tokens,
    checked,
    digest,
    dollars,
    invoke_candidate,
    write_json,
)

PUBLIC_DOMAINS = ["sales", "marketing", "operations", "support", "finance", "hr"]
TOOLS = ["mcp__ab__api_search", "mcp__ab__api_fetch", "mcp__ab__base64_encode"]
STEP_CAP = 50
GRADED = ("completed", "step_limit")


def sample(ids, count, seed, domain):
    ids = sorted(ids)
    if count is None or count >= len(ids):
        return ids
    return sorted(random.Random(f"{seed}:{domain}").sample(ids, count))


def mcnemar(a_only, b_only):
    """Exact two-sided McNemar p-value from the two discordant counts."""
    total = a_only + b_only
    if total == 0:
        return 1.0
    tail = sum(comb(total, k) for k in range(min(a_only, b_only) + 1)) / 2**total
    return min(1.0, 2 * tail)


def helper(args, action, domain, task_id, out, state=None):
    command = [
        args.python,
        str(HERE / "upstream.py"),
        action,
        "--upstream",
        str(Path(args.upstream).resolve()),
        "--domain",
        domain,
        "--out",
        str(out),
    ]
    if task_id:
        command += ["--task-id", task_id]
    if state:
        command += ["--state", str(state)]
    checked(command, cwd=HERE, stdout=subprocess.DEVNULL)
    return json.loads(Path(out).read_text())


def upstream_commit(args):
    commit = checked(
        ["git", "-C", str(Path(args.upstream).resolve()), "rev-parse", "HEAD"],
        capture_output=True,
    ).stdout.strip()
    pinned = json.loads((ROOT / "benchmarks/upstreams.json").read_text())["automationbench"]
    if commit != pinned["commit"]:
        raise ValueError(f"Upstream is at {commit}, pinned {pinned['commit']}")
    dirty = checked(
        ["git", "-C", str(Path(args.upstream).resolve()), "status", "--porcelain"],
        capture_output=True,
    ).stdout.strip()
    if dirty:
        raise ValueError("Upstream clone has uncommitted changes")
    return commit


def select(args, scratch):
    domains = args.domains or PUBLIC_DOMAINS
    listed = {
        domain: helper(args, "list", domain, None, scratch / f"{domain}.json")
        for domain in domains
    }
    if args.ids:
        found = [
            (domain, task)
            for domain in domains
            for task in listed[domain]
            if task in args.ids
        ]
        if sorted(task for _, task in found) != sorted(args.ids):
            raise ValueError("Some requested IDs are missing or ambiguous")
        return found
    return [
        (domain, task)
        for domain in domains
        for task in sample(listed[domain], args.per_domain, args.seed, domain)
    ]


def setup(args):
    """Model, effort, step cap and timeout this harness runs with; the comparable settings."""
    if args.harness == "arden":
        profile = json.loads(Path(args.profile).read_text())
        return {
            "harness": "arden",
            "model": profile["model"],
            "reasoning_effort": profile["reasoningEffort"],
            "step_cap": min(profile["maxModelRequests"], STEP_CAP),
            "timeout_s": profile["timeoutMs"] / 1000,
        }
    return {
        "harness": "codex",
        "model": args.model,
        "reasoning_effort": args.reasoning_effort,
        "step_cap": STEP_CAP,
        "timeout_s": args.timeout,
    }


def fingerprint(args, selection, commit):
    if args.harness == "arden":
        configuration = digest(Path(args.profile).read_bytes())
    else:
        configuration = digest(
            json.dumps([args.model, args.reasoning_effort]).encode()
        )
    code = b"".join(
        path.name.encode() + path.read_bytes()
        for path in [
            *sorted(HERE.glob("*.py")),
            *(
                ROOT / "benchmarks" / name
                for name in (
                    "cli.py",
                    "mcp_env.py",
                    "candidate.mjs",
                    "profile.mjs",
                    "provider.mjs",
                    "history.mjs",
                )
            ),
        ]
    )
    return {
        "version": 1,
        "suite": "automationbench-api",
        "upstream_commit": commit,
        **setup(args),
        "configuration_sha256": configuration,
        "adapter_sha256": digest(code),
        "seed": args.seed,
        # Lists, as JSON reads them back, so --resume compares equal.
        "selection": [list(pair) for pair in selection],
    }


def bridge_command(args, domain, task_id, state):
    return [
        # absolute(), not resolve(): a venv's python is a symlink, and resolving
        # it starts the base interpreter without the venv's packages.
        str(Path(args.python).absolute()),
        str(HERE / "bridge.py"),
        "--upstream",
        str(Path(args.upstream).resolve()),
        "--domain",
        domain,
        "--task-id",
        task_id,
        "--state-out",
        str(state),
    ]


def run_arden(args, directory, domain, task_id, prompt):
    profile = json.loads(Path(args.profile).read_text())
    command = bridge_command(args, domain, task_id, directory / "world.json")
    profile["mcpServers"] = [
        {
            "name": "ab",
            "command": command[0],
            "args": command[1:],
            "cwd": str(directory),
            "environment": {},
        }
    ]
    profile["tools"] = TOOLS
    profile["maxModelRequests"] = min(profile["maxModelRequests"], STEP_CAP)
    write_json(directory / "profile.json", profile)
    workspace = directory / "workspace"
    workspace.mkdir()
    job = {
        "id": f"{domain}-{task_id}",
        "prompts": [prompt],
        # The task uses no files: Arden gets the prompt Codex gets, byte for byte.
        "nameWorkspace": False,
        "workspace": str(workspace),
        "output": str(directory / "observations"),
    }
    write_json(directory / "job.json", job)
    try:
        code = invoke_candidate(directory / "profile.json", directory / "job.json", directory)
    except subprocess.TimeoutExpired:
        # The runner was killed after its time limit; recorded as an error trial.
        code = None
    observations = directory / "observations"
    result = read_json(observations / "result.json", {"status": "error"})
    usage = read_json(observations / "usage.json", None)
    if code == 0 and result["status"] == "completed":
        status = "completed"
    elif usage and usage.get("budgetExhausted"):
        status = "step_limit"
    else:
        status = "error"
    return {
        "exit_code": code,
        "status": status,
        "model_requests": usage["modelRequests"] if usage else None,
        "usage": usage and billed_tokens(usage),
    }


def codex_config(args, command, directory):
    quote = json.dumps
    features = [
        "shell_tool",
        "unified_exec",
        "apps",
        "plugins",
        "memories",
        "multi_agent",
        "multi_agent_v2",
        "image_generation",
        "view_image",
        "computer_use",
        "browser_use",
        "in_app_browser",
        "goals",
    ]
    lines = [
        f"model = {quote(args.model)}",
        f"model_reasoning_effort = {quote(args.reasoning_effort)}",
        'approval_policy = "never"',
        'sandbox_mode = "read-only"',
        'web_search = "disabled"',
        'cli_auth_credentials_store = "file"',
        "",
        "[features]",
        *(f"{name} = false" for name in features),
        "",
        "[mcp_servers.ab]",
        f"command = {quote(command[0])}",
        f"args = {quote(command[1:])}",
        f"cwd = {quote(str(directory))}",
        "tool_timeout_sec = 120",
        # With approval_policy "never", a tool that still needs approval fails;
        # Arden's trial approves its benchmark tools the same way.
        'default_tools_approval_mode = "approve"',
    ]
    return "\n".join(lines) + "\n"


def codex_usage(events):
    totals = None
    turns = 0
    succeeded = 0
    failed = []
    for line in events.read_text().splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        item = event.get("item") or {}
        if event.get("type") == "item.completed" and item.get("type") == "mcp_tool_call":
            if item.get("status") == "failed" or item.get("error"):
                error = item.get("error")
                failed.append(
                    (error.get("message") if isinstance(error, dict) else error) or "unknown error"
                )
            else:
                succeeded += 1
        if event.get("type") == "turn.completed":
            turns += 1
            usage = event.get("usage", {})
            # Codex reports the thread's running total, with cached tokens inside
            # input_tokens: the last event is the trial's usage.
            cached = usage.get("cached_input_tokens", 0)
            totals = {
                "input": usage.get("input_tokens", 0) - cached,
                "cached_input": cached,
                "output": usage.get("output_tokens", 0),
            }
    return totals, turns, succeeded, failed


def run_codex(args, directory, domain, task_id, prompt):
    home = directory / "codex-home"
    home.mkdir(mode=0o700)
    (directory / "home").mkdir(mode=0o700)
    workspace = directory / "workspace"
    workspace.mkdir()
    command = bridge_command(args, domain, task_id, directory / "world.json")
    (home / "config.toml").write_text(codex_config(args, command, directory))
    # A link keeps the credential in one place; it is never copied.
    (home / "auth.json").symlink_to(Path.home() / ".codex/auth.json")
    environment = {
        key: value
        for key, value in os.environ.items()
        if key in ("PATH", "LANG", "LC_ALL")
    }
    environment["CODEX_HOME"] = str(home)
    environment["HOME"] = str(directory / "home")
    events = directory / "codex-events.jsonl"
    capped = False
    with events.open("w") as out, (directory / "codex.log").open("w") as log:
        process = subprocess.Popen(
            [
                shutil.which("codex"),
                "exec",
                "--json",
                "--skip-git-repo-check",
                "--strict-config",
                "--ignore-rules",
                "--ephemeral",
                "-s",
                "read-only",
                "-C",
                str(workspace),
                "-",
            ],
            cwd=workspace,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=log,
            text=True,
            start_new_session=True,
        )
        # The leaderboards stop every model after 50 model responses. Codex
        # does not report its responses, only its tool calls; a response makes
        # at least one call, so stopping at call 51 never lets Codex go further.
        timer = threading.Timer(args.timeout, lambda: os.killpg(process.pid, signal.SIGKILL))
        timer.start()
        try:
            process.stdin.write(prompt)
            process.stdin.close()
            calls = 0
            for line in process.stdout:
                out.write(line)
                out.flush()
                if '"mcp_tool_call"' in line and '"item.started"' in line:
                    calls += 1
                    if calls > STEP_CAP:
                        capped = True
                        os.killpg(process.pid, signal.SIGKILL)
                        break
            process.wait()
        except KeyboardInterrupt:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise
        finally:
            timer.cancel()
    usage, turns, succeeded, failed = codex_usage(events)
    status = "completed" if process.returncode == 0 and turns else "error"
    reason = None
    if capped:
        # Graded as it stands, like an Arden trial that spends its 50 requests.
        # Codex reports tokens only at the end of a turn, so usage is None here
        # and the trial is left out of token and dollar means.
        status = "step_limit"
    elif status == "completed" and not succeeded and failed:
        status = "error"
        reason = f"tool calls failed: {failed[0]}"
    return {
        "exit_code": process.returncode,
        "status": status,
        **({"error": reason} if reason else {}),
        "model_requests": None,
        "turns": turns,
        "usage": usage,
    }


def read_json(path, default):
    return json.loads(path.read_text()) if path.exists() else default


def count_calls(directory):
    calls = directory / "world.calls.jsonl"
    return len(calls.read_text().splitlines()) if calls.exists() else 0


def run_trial(args, trial, domain, task_id):
    attempts = trial / "attempts"
    attempts.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory = attempts / str(len(list(attempts.iterdir())))
    directory.mkdir(mode=0o700)
    prompt = helper(args, "prompt", domain, task_id, directory / "prompt.json")
    (directory / "prompt.txt").write_text(prompt)
    started = time.monotonic()
    runner = run_arden if args.harness == "arden" else run_codex
    receipt = runner(args, directory, domain, task_id, prompt)
    receipt.update(
        {
            "id": task_id,
            "domain": domain,
            "harness": args.harness,
            "seconds": time.monotonic() - started,
            "bridge_calls": count_calls(directory),
            **{k: v for k, v in setup(args).items() if k != "harness"},
            "attempt": str(directory.relative_to(trial.parent.parent)),
        }
    )
    world = directory / "world.json"
    if receipt["status"] in GRADED and world.exists():
        graded = helper(args, "grade", domain, task_id, directory / "grade.json", world)
        receipt["passed"] = graded["passed"]
        receipt["partial_credit"] = graded["partial_credit"]
    else:
        receipt["status"] = "error"
        receipt["passed"] = None
        receipt["partial_credit"] = None
    return receipt


def run(args):
    if not args.allow_model_calls:
        raise ValueError("Model calls require --allow-model-calls")
    if args.harness == "arden" and not args.profile:
        raise ValueError("--profile is required for arden")
    if args.harness == "codex" and not (args.model and args.reasoning_effort):
        raise ValueError("--model and --reasoning-effort are required for codex")
    if args.harness == "codex" and not shutil.which("codex"):
        raise ValueError("The codex command is not on PATH")
    if args.ids and args.per_domain:
        raise ValueError("Use --ids or --per-domain, not both")
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    commit = upstream_commit(args)
    scratch = output / "scratch"
    scratch.mkdir(exist_ok=True)
    selection = select(args, scratch)
    pin = fingerprint(args, selection, commit)
    manifest = output / "manifest.json"
    if manifest.exists():
        if not args.resume or json.loads(manifest.read_text()) != pin:
            raise ValueError("Existing experiment differs or --resume was not supplied")
    else:
        write_json(manifest, pin)
    for domain, task_id in selection:
        trial = output / "trials" / f"{domain}-{task_id}"
        receipt_path = trial / "receipt.json"
        previous = read_json(receipt_path, None)
        if previous and previous["status"] != "error":
            continue
        receipt = run_trial(args, trial, domain, task_id)
        write_json(receipt_path, receipt)
        print(f"{domain}-{task_id} {receipt['status']} passed={receipt['passed']}", flush=True)


def load(output):
    return [
        json.loads(path.read_text())
        for path in sorted(Path(output).resolve().glob("trials/*/receipt.json"))
    ]


def rate(passes, total):
    p = passes / total if total else 0.0
    return {
        "passed": passes,
        "of": total,
        "rate": p,
        "standard_error": math.sqrt(p * (1 - p) / total) if total else None,
    }


def summarize(receipts, prices=None):
    graded = [row for row in receipts if row["status"] in GRADED]
    spent = [row for row in receipts if row.get("usage")]
    tokens = [sum(row["usage"][k] for k in ("input", "cached_input", "output")) for row in spent]
    per_domain = {}
    for row in graded:
        entry = per_domain.setdefault(row["domain"], [0, 0])
        entry[0] += bool(row["passed"])
        entry[1] += 1
    summary = {
        "trials": len(receipts),
        "errors": sum(row["status"] == "error" for row in receipts),
        "step_limit": sum(row["status"] == "step_limit" for row in receipts),
        "pass_graded": rate(sum(bool(r["passed"]) for r in graded), len(graded)),
        "pass_errors_as_fail": rate(
            sum(bool(r["passed"]) for r in graded), len(receipts)
        ),
        "partial_credit_mean": (
            sum(r["partial_credit"] for r in graded) / len(graded) if graded else None
        ),
        "per_domain": {k: f"{v[0]}/{v[1]}" for k, v in sorted(per_domain.items())},
        "trials_missing_usage": len(receipts) - len(spent),
        "tokens_total": sum(tokens),
        "tokens_mean": sum(tokens) / len(tokens) if tokens else None,
        "seconds_mean": (
            sum(r["seconds"] for r in receipts) / len(receipts) if receipts else None
        ),
    }
    if prices and spent:
        costs = [dollars(row["usage"], prices) for row in spent]
        summary["dollars_total"] = sum(costs)
        summary["dollars_mean"] = sum(costs) / len(costs)
    return summary


def report(args):
    prices = json.loads(Path(args.prices).read_text()) if args.prices else None
    print(json.dumps(summarize(load(args.output), prices), indent=2))


def compare(args):
    a, b = (
        {(r["domain"], r["id"]): r for r in load(path)} for path in (args.a, args.b)
    )
    commits = {
        json.loads((Path(path) / "manifest.json").read_text())["upstream_commit"]
        for path in (args.a, args.b)
    }
    if len(commits) != 1:
        raise ValueError("Experiments ran different upstream commits")
    manifests = [json.loads((Path(path) / "manifest.json").read_text()) for path in (args.a, args.b)]
    if not args.allow_mismatch:
        # Arden names a Codex model with its provider prefix (openai-codex/…).
        same = {
            "model": lambda value: str(value).rsplit("/", 1)[-1],
            "reasoning_effort": lambda value: value,
        }
        for key, normal in same.items():
            if normal(manifests[0].get(key)) != normal(manifests[1].get(key)):
                raise ValueError(
                    f"Experiments differ in {key}: {manifests[0].get(key)!r} vs "
                    f"{manifests[1].get(key)!r} (--allow-mismatch to compare anyway)"
                )
    shared = sorted(
        key
        for key in a.keys() & b.keys()
        if a[key]["status"] in GRADED and b[key]["status"] in GRADED
    )
    a_only = sum(a[k]["passed"] and not b[k]["passed"] for k in shared)
    b_only = sum(b[k]["passed"] and not a[k]["passed"] for k in shared)
    print(
        json.dumps(
            {
                "settings": {
                    side: {
                        k: m.get(k)
                        for k in ("harness", "model", "reasoning_effort", "step_cap", "timeout_s")
                    }
                    for side, m in zip("ab", manifests)
                },
                "shared": len(shared),
                "excluded_by_error_or_absence": len(a.keys() | b.keys()) - len(shared),
                "a": rate(sum(bool(a[k]["passed"]) for k in shared), len(shared)),
                "b": rate(sum(bool(b[k]["passed"]) for k in shared), len(shared)),
                "a_only": a_only,
                "b_only": b_only,
                "mcnemar_exact_p": mcnemar(a_only, b_only),
            },
            indent=2,
        )
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    batch = sub.add_parser("run")
    batch.add_argument("--upstream", required=True)
    batch.add_argument("--python", required=True, help="Python of the AutomationBench venv")
    batch.add_argument("--harness", choices=["arden", "codex"], required=True)
    batch.add_argument("--profile")
    batch.add_argument("--model")
    batch.add_argument("--reasoning-effort")
    batch.add_argument("--timeout", type=int, default=1800, help="Codex trial seconds")
    batch.add_argument("--output", required=True)
    batch.add_argument("--domains", nargs="+", choices=PUBLIC_DOMAINS)
    batch.add_argument("--per-domain", type=int)
    batch.add_argument("--ids", nargs="+")
    batch.add_argument("--seed", type=int, default=0)
    batch.add_argument("--resume", action="store_true")
    batch.add_argument("--allow-model-calls", action="store_true")
    show = sub.add_parser("report")
    show.add_argument("--output", required=True)
    show.add_argument("--prices")
    pair = sub.add_parser("compare")
    pair.add_argument("--a", required=True)
    pair.add_argument("--b", required=True)
    pair.add_argument("--allow-mismatch", action="store_true")
    args = parser.parse_args()
    if args.action == "run":
        run(args)
    elif args.action == "report":
        report(args)
    else:
        compare(args)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        sys.exit(130)
