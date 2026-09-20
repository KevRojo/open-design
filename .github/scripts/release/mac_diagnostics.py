#!/usr/bin/env python3
"""Sample macOS runner pressure while a release packaging command runs."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path


INTERESTING_PROCESSES = ("mds", "mdworker", "mdimport", "dmgbuild", "codesign", "ditto", "7za", "hdiutil", "notarytool")


def probe(command: list[str], timeout: float = 5) -> str:
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)
        if result.returncode:
            return f"exit={result.returncode} {result.stderr.strip()[:200]}"
        return result.stdout.strip()[:3000]
    except (OSError, subprocess.TimeoutExpired) as error:
        return f"{type(error).__name__}: {str(error)[:200]}"


def processes() -> list[dict[str, str | float]]:
    output = probe(["ps", "-A", "-o", "pid=,ppid=,%cpu=,%mem=,comm="])
    rows: list[dict[str, str | float]] = []
    for line in output.splitlines():
        parts = line.split(maxsplit=4)
        if len(parts) != 5:
            continue
        try:
            rows.append({"pid": parts[0], "ppid": parts[1], "cpu": float(parts[2]), "memory": float(parts[3]), "command": os.path.basename(parts[4])})
        except ValueError:
            continue
    leaders = sorted(rows, key=lambda row: float(row["cpu"]), reverse=True)[:8]
    spotlight = [row for row in rows if any(str(row["command"]).startswith(name) for name in INTERESTING_PROCESSES)]
    return list({str(row["pid"]): row for row in [*leaders, *spotlight]}.values())


def sample() -> dict[str, object]:
    top = probe(["top", "-l", "1", "-n", "0", "-s", "0"])
    cpu = next((line for line in top.splitlines() if line.startswith("CPU usage:")), top[:200])
    memory = next((line for line in top.splitlines() if line.startswith("PhysMem:")), "")
    disk = probe(["iostat", "-d", "-w", "1", "-c", "2"])
    return {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "logicalCpus": os.cpu_count(),
        "loadAverage": os.getloadavg(),
        "cpu": cpu,
        "memory": memory,
        "disk": disk,
        "spotlight": probe(["mdutil", "-s", "/", "/System/Volumes/Data"]),
        "processes": processes(),
    }


def monitor(output: Path, interval: float, stopped: threading.Event) -> None:
    with output.open("a", encoding="utf-8", buffering=1) as stream:
        while not stopped.is_set():
            observation = sample()
            stream.write(json.dumps(observation, separators=(",", ":")) + "\n")
            top_processes = ",".join(f"{row['command']}:{row['cpu']}" for row in observation["processes"][:5])
            disk_sample = (str(observation["disk"]).splitlines() or [""])[-1][:180]
            print(
                "[mac-resource]"
                f" timestamp={observation['timestamp']}"
                f" load={','.join(f'{number:.1f}' for number in observation['loadAverage'])}"
                f" cpu={observation['cpu']}"
                f" disk={disk_sample}"
                f" spotlight={str(observation['spotlight']).replace(chr(10), '; ')[:180]}"
                f" top={top_processes}",
                file=sys.stderr,
                flush=True,
            )
            stopped.wait(interval)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--interval-seconds", type=float, default=15)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not command or args.interval_seconds <= 0:
        parser.error("a command and positive sampling interval are required")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    stopped = threading.Event()
    sampler = threading.Thread(target=monitor, args=(args.output, args.interval_seconds, stopped), daemon=True)
    sampler.start()
    try:
        return subprocess.run(command, check=False).returncode
    finally:
        stopped.set()
        sampler.join(timeout=20)


if __name__ == "__main__":
    raise SystemExit(main())
