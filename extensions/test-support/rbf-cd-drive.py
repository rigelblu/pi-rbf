#!/usr/bin/env python3
"""Type into a real interactive Pi under a pseudo-terminal, and keep what its screen ends up showing.

`rbf-cd-verify.sh` hands this script one JSON plan on stdin:

  {"argv": ["pi", ...], "cwd": "...", "env": {...}, "cols": 130, "rows": 45, "out": "<dir>",
   "startup": 6, "steps": [...]}

Steps, run in order until one fails:
  {"submit": "text"}            paste the text, then Enter
  {"key": "enter"}              one named key: see KEYS
  {"sleep": 1.5}
  {"waitScreen": "text", "count": 1, "timeout": 40, "optional": false}
                                the rendered screen holds the text, whitespace ignored, `count` times
  {"waitLines": {"glob": "...", "contains": "text", "count": 1}, "timeout": 40}
                                files matching the glob hold `count` lines with the text
  {"waitExit": 25}              Pi exits by itself
  {"snapshot": "name"}          save the rendered screen as screen-<name>.txt
  {"sha": {"glob": "...", "name": "before"}}
                                record the SHA-256 of every matching file
  {"process": "pattern"}        record whether `pgrep -f pattern` finds a process
  {"remove": "path"}            delete one file, to flip a fixture mid-run

Rules learned driving Pi (see `rbf-row-gate-drive.py`): a slash command or prompt goes in as one
bracketed paste, never char by char, or Pi's autocomplete opens and Enter takes a completion.
TERM must be xterm-256color. Only the Pi pid is signalled.

The raw byte stream holds every frame Pi ever painted, so text Pi later replaced is still in it.
`render` replays the stream through a small terminal model, and assertions read that: what a
person would see, scrollback included. Pi 1.0.2 paints on the alternate screen and prints the
transcript to the main one when it exits, so a mid-run snapshot is the frame on screen and the
final screen.txt is what the terminal keeps.

Writes <out>/raw.bin, <out>/screen.txt and <out>/result.json, and prints result.json.
Exit 0 when every step held, 2 when one didn't.
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
import subprocess
import sys
import termios
import time
import unicodedata

KEYS = {"enter": b"\r", "escape": b"\x1b", "down": b"\x1b[B", "ctrl-b": b"\x02", "ctrl-u": b"\x15"}
SEQUENCE = re.compile(r"\x1b\[([0-9;?<>=]*)([ -/]*)([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78M]|\x1b_[^\x1b]*\x1b\\")


def render(raw: bytes, rows: int, cols: int) -> str:
    """Replay a terminal byte stream and return every line it left, scrollback first."""
    text = raw.decode("utf-8", "replace")
    lines = [[]]  # every line since the start; the viewport is the last `rows` of them
    top = row = col = 0
    main = None  # the main screen, kept aside while a full-screen Pi paints on the alternate one

    def line(index):
        while len(lines) <= index:
            lines.append([])
        return lines[index]

    def down():
        nonlocal row, top
        row += 1
        line(row)
        if row - top >= rows:
            top = row - rows + 1

    def put(char):
        nonlocal col
        width = 0 if unicodedata.category(char) in ("Mn", "Me", "Cf") else 2 if unicodedata.east_asian_width(char) in ("W", "F") else 1
        if width == 0:
            return
        if col + width > cols:
            col = 0
            down()
        cells = line(row)
        cells.extend(" " * (col + width - len(cells)))
        cells[col] = char
        if width == 2:
            cells[col + 1] = ""
        col += width

    position = 0
    while position < len(text):
        char = text[position]
        if char == "\x1b":
            match = SEQUENCE.match(text, position)
            if not match:
                position += 1
                continue
            position = match.end()
            final = match.group(3)
            if not final:
                continue
            params = [int(part) if part.isdigit() else 0 for part in match.group(1).lstrip("?<>=").split(";")]
            count = params[0] or 1
            if match.group(1).startswith("?"):
                if final in "hl" and params[0] in (47, 1047, 1049):
                    if final == "h" and main is None:
                        main, lines, top, row, col = (lines, top, row, col), [[]], 0, 0, 0
                    elif final == "l" and main is not None:
                        (lines, top, row, col), main = main, None
                continue
            if final == "A":
                row = max(top, row - count)
            elif final in "Be":
                row = min(top + rows - 1, row + count)
                line(row)
            elif final == "C":
                col = min(cols - 1, col + count)
            elif final == "D":
                col = max(0, col - count)
            elif final == "E":
                row, col = min(top + rows - 1, row + count), 0
                line(row)
            elif final == "F":
                row, col = max(top, row - count), 0
            elif final == "G":
                col = min(cols - 1, count - 1)
            elif final == "d":
                row = min(top + rows - 1, top + count - 1)
                line(row)
            elif final in "Hf":
                row = min(top + rows - 1, top + count - 1)
                col = min(cols - 1, (params[1] if len(params) > 1 and params[1] else 1) - 1)
                line(row)
            elif final == "K":
                cells = line(row)
                if params[0] == 0:
                    del cells[col:]
                elif params[0] == 1:
                    cells[: col + 1] = " " * min(len(cells), col + 1)
                else:
                    cells.clear()
            elif final == "J":
                if params[0] == 0:
                    del line(row)[col:]
                    del lines[row + 1 :]
                elif params[0] == 2:
                    for index in range(top, min(len(lines), top + rows)):
                        lines[index] = []
                elif params[0] == 3:
                    del lines[:top]
                    row -= top
                    top = 0
            continue
        position += 1
        if char == "\n":
            down()
        elif char == "\r":
            col = 0
        elif char == "\b":
            col = max(0, col - 1)
        elif char == "\t":
            col = min(cols - 1, (col // 8 + 1) * 8)
        elif char >= " ":
            put(char)
    return "\n".join("".join(cells).rstrip() for cells in lines)


def squeeze(text: str) -> str:
    """Pi wraps long lines, mid-path when it must. Compare text with all whitespace removed."""
    return re.sub(r"\s+", "", text)


def main() -> int:
    plan = json.load(sys.stdin)
    cols, rows = int(plan.get("cols", 130)), int(plan.get("rows", 45))
    out = plan["out"]
    os.makedirs(out, exist_ok=True)
    env = {**os.environ, **plan.get("env", {}), "TERM": "xterm-256color", "COLUMNS": str(cols), "LINES": str(rows)}

    pid, fd = pty.fork()
    if pid == 0:
        try:
            fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            os.chdir(plan["cwd"])
            os.execvpe(plan["argv"][0], plan["argv"], env)
        except BaseException as error:  # never fall through into the parent's loop with the child's fd
            print(f"exec failed: {error}", file=sys.stderr)
        finally:
            os._exit(127)

    raw = bytearray()
    events = []
    recorded = {}
    state = {"exit": None, "rendered": (0, "")}

    def screen() -> str:
        if state["rendered"][0] != len(raw):
            state["rendered"] = (len(raw), render(bytes(raw), rows, cols))
        return state["rendered"][1]

    def reap() -> bool:
        if state["exit"] is not None:
            return True
        try:
            done, status = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return True
        if done:
            state["exit"] = os.waitstatus_to_exitcode(status)
        return bool(done)

    def pump(seconds: float) -> None:
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            try:
                ready, _, _ = select.select([fd], [], [], 0.05)
                if ready:
                    chunk = os.read(fd, 65536)
                    if chunk:
                        raw.extend(chunk)
            except OSError:
                time.sleep(0.05)

    def wait_for(what: str, holds, timeout: float, optional: bool = False) -> bool:
        start = time.monotonic()
        while time.monotonic() - start < timeout:
            pump(0.25)
            if holds():
                events.append({"step": what, "ok": True, "seconds": round(time.monotonic() - start, 1)})
                return True
            if reap():
                pump(0.3)
                if holds():
                    events.append({"step": what, "ok": True, "seconds": round(time.monotonic() - start, 1)})
                    return True
                break
        events.append({"step": what, "ok": False, "optional": optional, "exit": state["exit"]})
        return optional

    def count_lines(target) -> int:
        total = 0
        for path in glob.glob(target["glob"], recursive=True):
            try:
                with open(path, encoding="utf-8", errors="replace") as handle:
                    total += sum(1 for row in handle if target["contains"] in row)
            except OSError:
                pass
        return total

    def paste(text: str) -> None:
        os.write(fd, b"\x1b[200~" + text.encode() + b"\x1b[201~")
        pump(0.6)

    pump(float(plan.get("startup", 6)))
    ok = True
    for step in plan["steps"]:
        if not ok:
            break
        timeout = float(step.get("timeout", 40))
        if "submit" in step:
            paste(step["submit"])
            os.write(fd, b"\r")
            pump(0.3)
        elif "key" in step:
            os.write(fd, KEYS[step["key"]])
            pump(0.3)
        elif "sleep" in step:
            pump(float(step["sleep"]))
        elif "waitScreen" in step:
            wanted, count = squeeze(step["waitScreen"]), int(step.get("count", 1))
            ok = wait_for(f"screen shows {step['waitScreen']!r} x{count}", lambda: squeeze(screen()).count(wanted) >= count, timeout, step.get("optional", False))
        elif "waitLines" in step:
            target = step["waitLines"]
            ok = wait_for(f"{target['contains']!r} x{target.get('count', 1)} in {target['glob']}", lambda: count_lines(target) >= int(target.get("count", 1)), timeout)
        elif "waitExit" in step:
            ok = wait_for("pi exited by itself", reap, float(step["waitExit"]))
        elif "snapshot" in step:
            with open(os.path.join(out, f"screen-{step['snapshot']}.txt"), "w", encoding="utf-8") as handle:
                handle.write(screen())
        elif "sha" in step:
            target = step["sha"]
            recorded[target["name"]] = {path: hashlib.sha256(open(path, "rb").read()).hexdigest() for path in sorted(glob.glob(target["glob"], recursive=True))}
        elif "process" in step:
            found = subprocess.run(["pgrep", "-f", step["process"]], capture_output=True, text=True).stdout.split()
            recorded.setdefault("process", []).append({"pattern": step["process"], "running": bool(found)})
        elif "remove" in step:
            try:
                os.remove(step["remove"])
            except FileNotFoundError:
                pass

    pump(1.0)
    quit_by_driver = not reap()
    if quit_by_driver:
        os.write(fd, KEYS["ctrl-u"])
        paste("/quit")
        os.write(fd, b"\r")
        for _ in range(50):
            pump(0.2)
            if reap():
                break
    if not reap():
        os.kill(pid, signal.SIGTERM)
        pump(1.0)
        reap()
    pump(0.3)
    try:
        os.close(fd)
    except OSError:
        pass

    result = {"ok": ok, "exit": state["exit"], "quitByDriver": quit_by_driver, "events": events, "recorded": recorded}
    with open(os.path.join(out, "raw.bin"), "wb") as handle:
        handle.write(raw)
    with open(os.path.join(out, "screen.txt"), "w", encoding="utf-8") as handle:
        handle.write(screen())
    with open(os.path.join(out, "result.json"), "w", encoding="utf-8") as handle:
        json.dump(result, handle, indent=1)
    print(json.dumps(result))
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
