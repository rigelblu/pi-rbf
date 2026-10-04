#!/usr/bin/env python3
"""Drive a real interactive Pi under a pseudo-terminal and keep every byte it writes.

The row gate's test hands this script one JSON plan on stdin:

  {"argv": ["pi", ...], "cwd": "...", "env": {...}, "cols": 100, "rows": 40, "timeout": 30,
   "out": "raw.bin",
   "steps": [{"wait": "regex on the ANSI-stripped stream"}, {"paste": "text"}, {"key": "enter"}, {"sleep": 0.5}, {"snapshot": "after-turn"}]}

A reloadReady step waits for the test-only probe's activation receipt, then sends its
idempotent command until the newly loaded handler acknowledges it from the editor.

Rules learned driving Pi 0.85.1 (core memories): a slash command or prompt goes in as one
bracketed paste, never char by char, or Pi's autocomplete opens and Enter takes a completion;
TERM must be xterm-256color for the row escapes to match daily use; only the Pi pid is killed.
Exit 0 when every wait matched; 2 on a timeout, with the raw bytes still written for a post-mortem.
"""
import fcntl
import glob
import hashlib
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

KEYS = {"enter": b"\r", "tab": b"\t", "escape": b"\x1b", "up": b"\x1b[A", "down": b"\x1b[B", "ctrl-c": b"\x03", "ctrl-d": b"\x04", "ctrl-o": b"\x0f", "ctrl-u": b"\x15"}
# CSI sequences; OSC sequences ended by BEL or by ST (ESC \), never spanning a later ESC; charset and keypad selects; CR.
ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]|\r")


def strip(raw: bytes) -> bytes:
    return ANSI.sub(b"", raw)


def main() -> int:
    plan = json.load(sys.stdin)
    cols, rows = int(plan.get("cols", 100)), int(plan.get("rows", 40))
    deadline = time.monotonic() + float(plan.get("timeout", 30))
    env = {**os.environ, **plan.get("env", {}), "TERM": "xterm-256color", "COLUMNS": str(cols), "LINES": str(rows)}

    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.chdir(plan["cwd"])
            os.execvpe(plan["argv"][0], plan["argv"], env)
        except BaseException as e:  # never fall through into the parent's loop with the child's fd
            print(f"exec failed: {e}", file=sys.stderr)
        finally:
            os._exit(127)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    raw = bytearray()
    snapshots = {}
    failure = None

    def pump(until: float) -> None:
        while True:
            left = until - time.monotonic()
            if left <= 0:
                return
            ready, _, _ = select.select([fd], [], [], min(left, 0.05))
            if not ready:
                continue
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return
            if not chunk:
                return
            raw.extend(chunk)

    try:
        for step in plan["steps"]:
            if "wait" in step:
                pattern = re.compile(step["wait"].encode())
                count = int(step.get("count", 1))
                wait_deadline = min(deadline, time.monotonic() + float(step.get("timeout", plan.get("timeout", 30))))
                while len(list(pattern.finditer(strip(bytes(raw))))) < count:
                    if time.monotonic() > wait_deadline:
                        failure = f"timed out waiting for {step['wait']!r} (count={count})"
                        break
                    pump(time.monotonic() + 0.1)
                if failure:
                    break
            elif "reloadReady" in step:
                receipt = step["reloadReady"]
                target = int(receipt["loads"])
                last_ping = 0.0
                wait_deadline = min(deadline, time.monotonic() + float(step.get("timeout", plan.get("timeout", 30))))
                while True:
                    try:
                        with open(receipt["path"], encoding="utf-8") as f:
                            state = json.load(f)
                    except (OSError, ValueError):  # writer may be replacing the receipt
                        state = {}
                    if state.get("readyLoad") == target and state.get("loads") == target:
                        # The receipt is written inside the command handler; let Pi
                        # finish that command's redraw before the next paste/Enter.
                        pump(time.monotonic() + 0.25)
                        break
                    if time.monotonic() > wait_deadline:
                        failure = f"timed out waiting for reload readiness (loads={target})"
                        break
                    if state.get("loads") == target and time.monotonic() - last_ping >= 0.75:
                        # A swallowed ping during the reload box is harmless: retry until
                        # the new extension's command handler actually runs in the editor.
                        command = f"{receipt.get('command', '/rbf-reload-ready')} {target}".encode()
                        os.write(fd, b"\x1b[200~" + command + b"\x1b[201~\r")
                        last_ping = time.monotonic()
                    pump(time.monotonic() + 0.1)
                if failure:
                    break
            elif "paste" in step:
                os.write(fd, b"\x1b[200~" + step["paste"].encode() + b"\x1b[201~")
                pump(time.monotonic() + 0.15)
            elif "key" in step:
                os.write(fd, KEYS[step["key"]])
                pump(time.monotonic() + 0.15)
            elif "sleep" in step:
                pump(time.monotonic() + float(step["sleep"]))
            elif "waitSessionTurns" in step:
                target = step["waitSessionTurns"]
                wait_deadline = min(deadline, time.monotonic() + float(step.get("timeout", plan.get("timeout", 30))))
                while True:
                    files = glob.glob(os.path.join(target["dir"], "*.jsonl"))
                    try:
                        with open(files[0], "r", encoding="utf-8") as f:
                            count = sum(1 for line in f if '"customType":"rbf-codex-turn/v1"' in line)
                    except (IndexError, OSError):
                        count = 0
                    if count >= int(target["count"]):
                        pump(time.monotonic() + 0.3)
                        break
                    if time.monotonic() > wait_deadline:
                        failure = f"timed out waiting for {target['count']} Codex turns, saw {count}"
                        break
                    pump(time.monotonic() + 0.1)
                if failure:
                    break
            elif "waitJsonl" in step:
                target = step["waitJsonl"]
                wait_deadline = min(deadline, time.monotonic() + float(step.get("timeout", plan.get("timeout", 30))))
                while True:
                    try:
                        with open(target["path"], encoding="utf-8") as f:
                            matches = [json.loads(line) for line in f if line.strip()]
                        matches = [item for item in matches if item.get(target["field"]) == target["value"]]
                        count = len({json.dumps(item.get(target["unique"]), sort_keys=True) for item in matches}) if "unique" in target else len(matches)
                    except (OSError, ValueError):
                        count = 0
                    if count >= int(target["count"]):
                        pump(time.monotonic() + 0.3)
                        break
                    if time.monotonic() > wait_deadline:
                        failure = f"timed out waiting for JSONL receipt count={target['count']}, saw {count}"
                        break
                    pump(time.monotonic() + 0.1)
                if failure:
                    break
            elif "sessionSnapshot" in step:
                target = step["sessionSnapshot"]
                name = target["name"]
                files = glob.glob(os.path.join(target["dir"], "*.jsonl"))
                if name in snapshots or len(files) != 1:
                    failure = f"session snapshot {name!r} expected exactly one JSONL, got {len(files)}"
                    break
                with open(files[0], "rb") as f:
                    data = f.read()
                snapshots[name] = {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)}
            elif "snapshot" in step:
                name = step["snapshot"]
                if name in snapshots:
                    failure = f"duplicate snapshot {name!r}"
                    break
                snapshots[name] = len(raw)
    finally:
        # Let the last frame land, then take only Pi down; its children follow it (stdin EOF).
        pump(time.monotonic() + 0.4)
        try:
            os.kill(pid, signal.SIGTERM)
            pump(time.monotonic() + 0.3)
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        os.close(fd)
        with open(plan["out"], "wb") as f:
            f.write(raw)

    if failure:
        print(failure, file=sys.stderr)
        return 2
    print(json.dumps(snapshots))
    return 0


if __name__ == "__main__":
    sys.exit(main())
