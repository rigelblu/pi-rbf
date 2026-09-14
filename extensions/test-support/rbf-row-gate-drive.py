#!/usr/bin/env python3
"""Drive a real interactive Pi under a pseudo-terminal and keep every byte it writes.

The row gate's test hands this script one JSON plan on stdin:

  {"argv": ["pi", ...], "cwd": "...", "env": {...}, "cols": 100, "rows": 40, "timeout": 30,
   "out": "raw.bin",
   "steps": [{"wait": "regex on the ANSI-stripped stream"}, {"paste": "text"}, {"key": "enter"}, {"sleep": 0.5}]}

Rules learned driving Pi 0.85.1 (core memories): a slash command or prompt goes in as one
bracketed paste, never char by char, or Pi's autocomplete opens and Enter takes a completion;
TERM must be xterm-256color for the row escapes to match daily use; only the Pi pid is killed.
Exit 0 when every wait matched; 2 on a timeout, with the raw bytes still written for a post-mortem.
"""
import fcntl
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

KEYS = {"enter": b"\r", "tab": b"\t", "escape": b"\x1b", "up": b"\x1b[A", "down": b"\x1b[B", "ctrl-c": b"\x03", "ctrl-d": b"\x04", "ctrl-o": b"\x0f"}
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
                while not pattern.search(strip(bytes(raw))):
                    if time.monotonic() > deadline:
                        failure = f"timed out waiting for {step['wait']!r}"
                        break
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
