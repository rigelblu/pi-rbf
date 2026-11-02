#!/usr/bin/env python3
"""Exercise /fast-codex through real Pi's PTY, with isolated files and fake Codex."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
SUPPORT = Path(__file__).resolve().parent
ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]|\r")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pi", required=True)
    parser.add_argument("--width", type=int, choices=[80, 120], required=True)
    args = parser.parse_args()
    pi = Path(args.pi).absolute()
    base = subprocess.check_output(["bash", os.path.expanduser("~/.agents/skills/eng-use-external-tmp/scripts/resolve-external-tmp.sh"), "pi-54"], text=True).strip()
    stage = Path(base) / f"native-{args.width}-{time.time_ns()}"
    stage.mkdir()
    for name in ("agent", "sessions"):
        (stage / name).mkdir()
    env = {
        "PI_CODING_AGENT_DIR": str(stage / "agent"), "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1", "PI_HYPERLINKS": "0",
        "RBF_FAKE_LOG": str(stage / "fake.jsonl"), "RBF_FAKE_HISTORY": str(stage / "history.json"),
        "RBF_FAKE_VERSION": "codex-cli 0.166.0", "RBF_FAKE_SCENARIO": '{"retainHistory":true}',
        "RBF_FAST_PREVIEW_RECEIPT": str(stage / "loaded.json"),
    }
    argv = [str(pi), "--no-extensions", "-e", str(SUPPORT / "rbf-codex-fast-mode-preview.ts"), "--no-skills", "--no-themes", "--no-context-files", "--no-prompt-templates", "--session-dir", str(stage / "sessions"), "--model", "codex-harness/codex"]

    def command(text):
        return [{"paste": text}, {"key": "enter"}]

    def run(name, steps, extra=None):
        steps += [{"key": "ctrl-d"}, {"waitExit": 5}]
        plan = {"argv": argv + (extra or []), "cwd": str(ROOT), "env": env, "cols": args.width, "rows": 40, "timeout": 40, "out": str(stage / f"{name}.bin"), "steps": steps}
        (stage / f"{name}-plan.json").write_text(json.dumps(plan, indent=2))
        result = subprocess.run(["python3", str(SUPPORT / "rbf-row-gate-drive.py")], input=json.dumps(plan), capture_output=True, text=True)
        (stage / f"{name}-driver.txt").write_text(result.stdout + result.stderr)
        assert result.returncode == 0, f"{name}: {result.stderr}; receipts: {stage}"
        snapshots = json.loads(result.stdout)
        raw = (stage / f"{name}.bin").read_bytes()
        for tag, end in snapshots.items():
            if isinstance(end, int):
                (stage / f"{name}-{tag}.txt").write_bytes(ANSI.sub(b"", raw[:end]))
        replay = """import {readFileSync,writeFileSync} from 'node:fs';
import {replayScreen} from './extensions/test-support/rbf-pty-screen.ts';
const [rawPath, snapshots, width] = process.argv.slice(1);
const raw = readFileSync(rawPath);
for (const [tag, end] of Object.entries(JSON.parse(snapshots))) {
 if (typeof end === 'number') writeFileSync(rawPath + '.' + tag + '.screen.txt', replayScreen(raw.subarray(0,end), Number(width), 40).lines.join('\\n'));
} """
        subprocess.run(["node", "--input-type=module", "-e", replay, str(stage / f"{name}.bin"), json.dumps(snapshots), str(args.width)], cwd=ROOT, check=True)
        return raw, snapshots

    ready = lambda load: {"reloadReady": {"path": str(stage / "loaded.json"), "loads": load, "command": "/rbf-fast-ready"}}
    first, snaps = run("choose", [ready(1)] + command("/fast-codex") + [
        {"wait": "Codex fast mode \\(Codex default\\)"}, {"snapshot": "default-picker"}, {"key": "escape"},
    ] + command("/fast-codex") + [{"sleep": .3}, {"key": "down"}, {"key": "enter"}, {"wait": "fast \\(codex-harness\\) codex"}, {"snapshot": "fast-status"}] + command("offline-one") + [
        {"waitSessionTurns": {"dir": str(stage / "sessions"), "count": 1}},
    ] + command("/reload") + [ready(2)] + command("/fast-codex") + [
        {"wait": "Codex fast mode \\(Fast\\)"}, {"snapshot": "reload-picker"}, {"key": "enter"},
    ])
    files = list((stage / "sessions").glob("*.jsonl"))
    assert len(files) == 1, stage
    session = files[0]
    entries = [json.loads(line) for line in session.read_text().splitlines()]
    assert [e["data"]["mode"] for e in entries if e.get("customType") == "rbf-codex-fast/v1"] == ["fast"], stage
    second, _ = run("resume", [ready(1), {"wait": "fast \\(codex-harness\\) codex"}] + command("/fast-codex") + [
        {"wait": "Codex fast mode \\(Fast\\)"}, {"snapshot": "resume-picker"}, {"key": "down"}, {"key": "enter"},
        {"wait": "standard \\(codex-harness\\) codex"}, {"snapshot": "standard-status"},
    ] + command("offline-two") + [{"waitSessionTurns": {"dir": str(stage / "sessions"), "count": 2}}] + command("/fast-codex") + [
        {"sleep": .3}, {"key": "down"}, {"key": "down"}, {"key": "enter"}, {"wait": "now uses the Codex default service"}, {"snapshot": "default-status"},
    ] + command("offline-three") + [{"waitSessionTurns": {"dir": str(stage / "sessions"), "count": 3}}], ["--session", str(session)])
    entries = [json.loads(line) for line in session.read_text().splitlines()]
    modes = [e["data"]["mode"] for e in entries if e.get("customType") == "rbf-codex-fast/v1"]
    assert modes == ["fast", "standard", "inherit"], (modes, stage)
    wire = [json.loads(line) for line in (stage / "fake.jsonl").read_text().splitlines()]
    tiers = [x.get("params", {}).get("serviceTierForTurn") for x in wire if x.get("method") == "turn/start"]
    assert tiers == ["priority", "default", None], (tiers, stage)
    assert all("serviceTier" not in x.get("params", {}) for x in wire if x.get("method") in ["thread/start", "thread/resume", "thread/fork"]), stage
    for raw in (first, second):
        text = ANSI.sub(b"", raw).decode(errors="replace")
        assert "Error loading extension" not in text and "Unhandled" not in text, stage
    for name, tag, title, current in [("choose", "default-picker", "Codex default", "Codex default"), ("choose", "reload-picker", "Fast", "Fast"), ("resume", "resume-picker", "Fast", "Fast")]:
        screen = (stage / f"{name}.bin.{tag}.screen.txt").read_text()
        assert f"Codex fast mode ({title})" in screen and f"→ {current}" in screen, (tag, screen, stage)
    for name, tag, expected in [("choose", "fast-status", "fast"), ("resume", "standard-status", "standard")]:
        screen = (stage / f"{name}.bin.{tag}.screen.txt").read_text()
        assert f"{expected} (codex-harness) codex" in screen, (tag, screen, stage)
        assert "requested (Codex)" not in screen, (tag, screen, stage)
    screen = (stage / "resume.bin.default-status.screen.txt").read_text()
    assert "fast (codex-harness)" not in screen and "standard (codex-harness)" not in screen, stage
    loaded = json.loads((stage / "loaded.json").read_text())
    assert loaded["sourceSha256"] == hashlib.sha256((ROOT / "extensions/rbf-codex.ts").read_bytes()).hexdigest(), stage
    result = {"pass": True, "pi": str(pi), "version": subprocess.check_output([str(pi), "--version"], text=True).strip(), "width": args.width, "modes": modes, "wireTiers": tiers, "sourceSha256": hashlib.sha256((ROOT / "extensions/rbf-codex.ts").read_bytes()).hexdigest(), "stage": str(stage)}
    (stage / "result.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result))


if __name__ == "__main__":
    main()
