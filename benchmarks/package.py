#!/usr/bin/env python3
"""Package built runtime files only; no home, datasets, source checkout or credentials."""

import argparse
import hashlib
import io
import json
import subprocess
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def package(destination):
    root = json.loads((ROOT / "package.json").read_text())
    files = [ROOT / "package.json", ROOT / "bun.lock"]
    files.extend(ROOT / patch for patch in root.get("patchedDependencies", {}).values())
    # The root postinstall (it also marks the server's node-pty helper executable).
    files.append(ROOT / "tooling/prepare-node-pty.cjs")
    # Every workspace the root lists ships its manifest, or a frozen install
    # refuses; only the runtime (libs and the server) ships its build.
    patterns = root["workspaces"]["packages"]
    for workspace in sorted({path for pattern in patterns for path in ROOT.glob(pattern)}):
        if not (workspace / "package.json").exists():
            continue
        files.append(workspace / "package.json")
        if workspace.parent.name == "libs" or workspace.name == "server-ts":
            if not (workspace / "dist").is_dir():
                raise ValueError(f"Build missing: {workspace}/dist")
            files.extend(
                path
                for path in (workspace / "dist").rglob("*")
                if path.is_file() and not path.is_symlink()
            )
    files.extend(
        ROOT / "benchmarks" / name
        for name in (
            "candidate.mjs",
            "history.mjs",
            "profile.mjs",
            "cli.py",
            "datasets.py",
            "profile_env.py",
            "install.sh",
        )
    )
    manifest = {
        "revision": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
        ).strip(),
        # True when the checkout differs from that revision; the file hashes
        # below are what identifies the code either way.
        "dirty": bool(
            subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).strip()
        ),
        "files": {},
    }
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with (
        destination.open("xb") as raw,
        tarfile.open(fileobj=raw, mode="w:gz") as archive,
    ):
        for path in sorted(set(files)):
            name = str(path.relative_to(ROOT))
            content = path.read_bytes()
            manifest["files"][name] = hashlib.sha256(content).hexdigest()
            info = tarfile.TarInfo(name)
            info.size = len(content)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(content))
        content = json.dumps(manifest, indent=2).encode()
        info = tarfile.TarInfo("benchmark-build.json")
        info.size = len(content)
        info.mode = 0o644
        archive.addfile(info, io.BytesIO(content))
    print(hashlib.sha256(destination.read_bytes()).hexdigest(), destination)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output")
    package(parser.parse_args().output)
