#!/usr/bin/env bash
# Verify `/cd` in a real interactive Pi, offline, in a throwaway root.
#
#   rbf-cd-verify.sh <pi-executable> <scenario>
#
# Scenarios: move reopen branch busy cancel fail leftovers fresh trust decline load-error vanish
# Prints every check, then PASS or FAIL with the reasons. Exits 0 only on PASS.
#
# Each run gets a root at $RBF_CD_VERIFY_TMP/<scenario>-<pi version>/ (default
# /Volumes/tom-ssd/tmp/pi-41.2) with two project directories, A and B, each with its own
# marker.txt and AGENTS.md rule, an isolated Pi agent directory, and a fake `trash` first on PATH
# that moves files into <root>/trash. No model, no network, no real Trash, no real ~/.pi.
# The scripted provider (`rbf-row-gate-provider.ts`) answers, `rbf-cd-observer.ts` records what
# each turn saw, and `rbf-cd-drive.py` types into Pi under a pseudo-terminal.
set -u
[ $# -eq 2 ] || { echo "usage: rbf-cd-verify.sh <pi-executable> <scenario>" >&2; exit 2; }
workspace=$(cd "$(dirname "$0")/../.." && pwd)
pi=$1
case "$pi" in */*) pi=$(cd "$(dirname "$pi")" && pwd)/$(basename "$pi") ;; esac
version=$("$pi" --version < /dev/null 2>&1 | head -1)
case "$version" in [0-9]*.[0-9]*) ;; *) echo "FAIL: '$pi --version' printed '$version'" && exit 1 ;; esac
root=${RBF_CD_VERIFY_TMP:-/Volumes/tom-ssd/tmp/pi-41.2}/$2-$version
echo "== /cd $2 on Pi $version ($pi)"
echo "== root $root"

exec python3 - "$workspace" "$pi" "$2" "$root" << 'PYTHON'
import glob, hashlib, json, os, re, shlex, shutil, subprocess, sys, time

workspace, pi, scenario, root = sys.argv[1:5]
EXT = os.path.join(workspace, "extensions")
SUPPORT = os.path.join(EXT, "test-support")
BASH = {"tool": "bash", "args": {"command": "pwd; cat marker.txt"}}
SCRIPT = [BASH, {"text": "STEP_1"}, BASH, {"text": "STEP_3"}, BASH, {"text": "STEP_5"}, BASH, {"text": "STEP_7"}]
MOVE_ENTRY = "rbf-cd-move/v1"
BUSY_RESPONSE = "Can't change directory while a response or compaction is running. Finish or stop it, then retry /cd."
failures, notes = [], []


def check(ok, what):
    print(("  ok    " if ok else "  FAIL  ") + what)
    if not ok:
        failures.append(what)
    return ok


def note(what):
    print("  note  " + what)
    notes.append(what)


def squeeze(text):
    return re.sub(r"\s+", "", text)


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def read_session(path):
    lines = [line for line in open(path, encoding="utf-8").read().split("\n") if line.strip()]
    return json.loads(lines[0]), lines[1:]


class Run:
    """One throwaway root: A, B, an isolated agent directory, a fake trash, and one observer log."""

    def __init__(self, name=""):
        self.root = os.path.join(root, name) if name else root
        shutil.rmtree(self.root, ignore_errors=True)
        self.A, self.B, self.agent, self.trash = (os.path.join(self.root, part) for part in ("A", "B", "agent", "trash"))
        for directory in (self.A, self.B, self.agent, self.trash, os.path.join(self.root, "bin"), os.path.join(self.root, "out")):
            os.makedirs(directory)
        for directory, letter in ((self.A, "A"), (self.B, "B")):
            open(os.path.join(directory, "marker.txt"), "w").write(f"MARKER_CD_{letter}\n")
            open(os.path.join(directory, "AGENTS.md"), "w").write(f"RULE_CD_{letter}: you are in project {letter}\n")
        self.trash_fails = os.path.join(self.root, "trash-fails")
        fake = os.path.join(self.root, "bin", "trash")
        open(fake, "w").write(f'#!/bin/sh\n[ -e "{self.trash_fails}" ] && exit 1\nfor f in "$@"; do mv "$f" "{self.trash}/" || exit 1; done\n')
        os.chmod(fake, 0o755)
        self.log = os.path.join(self.root, "observe.jsonl")
        # The default model lives in settings for a run that passes pin_model=False. `--model` on the command
        # line is re-applied by Pi on every session switch, so a run that checks the model must not pin it.
        open(os.path.join(self.agent, "settings.json"), "w").write(json.dumps({"defaultProvider": "rbf-gate", "defaultModel": "gate"}))
        self.sessions_glob = os.path.join(self.agent, "sessions", "**", "*.jsonl")

    def env(self, hook=None, script=None, label="tui"):
        env = {
            "PI_CODING_AGENT_DIR": self.agent, "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0", "PI_HYPERLINKS": "0",
            "PATH": os.path.join(self.root, "bin") + ":" + os.environ["PATH"],
            "RBF_ROW_GATE_SCRIPT": json.dumps(script or SCRIPT), "RBF_CD_OBSERVE_LOG": self.log, "RBF_CD_LABEL": label,
            "RBF_CD_TEST_HOOK": hook or "", "RBF_CD_VANISH_DIR": self.B,
        }
        return env

    def args(self, discover=False, extra=(), pin_model=True):
        stack = [path for path in sorted(glob.glob(os.path.join(EXT, "rbf-*.ts"))) if not path.endswith(".test.ts") and not path.endswith("/rbf-codex.ts")]
        loaded = [arg for path in stack + [os.path.join(SUPPORT, "rbf-row-gate-provider.ts"), os.path.join(SUPPORT, "rbf-cd-observer.ts")] for arg in ("-e", path)]
        return ([] if discover else ["--no-extensions"]) + ["--no-skills", "--no-themes", "--no-prompt-templates"] + loaded + list(extra) + (["--model", "rbf-gate/gate"] if pin_model else [])

    def tui(self, name, steps, cwd=None, hook=None, script=None, discover=False, extra=(), startup=6, pin_model=True):
        out = os.path.join(self.root, "out", name)
        plan = {"argv": [pi] + self.args(discover, extra, pin_model), "cwd": cwd or self.A, "env": self.env(hook, script, name), "out": out, "startup": startup, "steps": steps}
        done = subprocess.run([sys.executable, os.path.join(SUPPORT, "rbf-cd-drive.py")], input=json.dumps(plan), capture_output=True, text=True)
        try:
            result = json.loads(done.stdout.strip().splitlines()[-1])
        except (IndexError, ValueError):
            result = {"ok": False, "exit": None, "events": [{"step": "driver", "ok": False, "stderr": done.stderr[-400:]}], "recorded": {}}
        result["screen"] = open(os.path.join(out, "screen.txt"), encoding="utf-8").read() if os.path.exists(os.path.join(out, "screen.txt")) else ""
        result["out"] = out
        missed = [event["step"] for event in result["events"] if not event["ok"] and not event.get("optional")]
        check(result["ok"], f"[{name}] every step held" + (f": missed {missed}" if missed else ""))
        return result

    def print_mode(self, label, cwd, flags):
        out = os.path.join(self.root, "out", f"print-{label}.txt")
        with open(out, "w") as handle:
            done = subprocess.run([pi] + self.args() + list(flags) + ["-p", "x"], cwd=cwd, env={**os.environ, **self.env(label=label)}, stdin=subprocess.DEVNULL, stdout=handle, stderr=subprocess.STDOUT, timeout=120)
        return done.returncode

    def records(self, kind, label=None):
        if not os.path.exists(self.log):
            return []
        rows = [json.loads(line) for line in open(self.log, encoding="utf-8") if line.strip()]
        return [row for row in rows if row["kind"] == kind and (label is None or row.get("label") == label)]

    def sessions(self):
        found = []
        for path in sorted(glob.glob(self.sessions_glob, recursive=True)):
            try:
                header, lines = read_session(path)
            except (OSError, ValueError, IndexError):
                header, lines = {}, []
            found.append({"path": path, "header": header, "lines": lines, "entries": [json.loads(line) for line in lines]})
        return found

    def trashed(self):
        return sorted(os.listdir(self.trash))

    def folder(self, cwd):
        """Pi's default session folder for a directory. Only used to place hand-built files."""
        return os.path.join(self.agent, "sessions", "--" + re.sub(r"[/\\:]", "-", cwd.lstrip("/")) + "--")

    # ─── Steps ───────────────────────────────────────────────────────────────

    def said(self, text, count=1, timeout=40):
        return {"waitLines": {"glob": self.sessions_glob, "contains": text, "count": count}, "timeout": timeout}

    def logged(self, text, count=1, timeout=40):
        return {"waitLines": {"glob": self.log, "contains": text, "count": count}, "timeout": timeout}

    def first_turn(self):
        return [{"submit": "first prompt in A"}, self.said("STEP_1"), {"sleep": 1.5}]


def shows(text, count=1, timeout=40, optional=False):
    return {"waitScreen": text, "count": count, "timeout": timeout, "optional": optional}


def moves_of(session):
    return [entry["data"] for entry in session["entries"] if entry.get("customType") == MOVE_ENTRY]


def turn_in(run, turn, directory, rule, other_rule, what):
    check(turn["ctxCwd"] == directory and turn["managerCwd"] == directory, f"{what}: the session's directory is {os.path.basename(directory)} (saw {turn['ctxCwd']})")
    check(turn["processCwd"] == directory, f"{what}: the process directory is {os.path.basename(directory)} (saw {turn['processCwd']})")
    check(rule in turn["systemPrompt"] and other_rule not in turn["systemPrompt"], f"{what}: the system prompt holds {rule} and not {other_rule}")


def no_file_for(run, directory, what):
    held = [session["path"] for session in run.sessions() if session["header"].get("cwd") == directory or os.path.dirname(session["path"]) == run.folder(directory)]
    check(held == [], f"{what}: no session file exists for {os.path.basename(directory)} (found {held})")


def below_conversation(screen, warning, what):
    flat = squeeze(screen)
    at = flat.find(squeeze(warning))
    check(at >= 0, f"{what}: the screen shows the warning")
    check(at > flat.rfind("STEP_1") >= 0, f"{what}: the warning sits below the conversation")


# ─── S2 ──────────────────────────────────────────────────────────────────────

def scenario_move():
    run = Run()
    result = run.tui("move", run.first_turn() + [
        {"submit": "/name cd-move-check"}, {"sleep": 0.8},
        {"submit": "/rbf-cd-set rbf-cd-gate/think high"}, run.logged('"kind":"set"'), {"sleep": 0.5},
        {"submit": "/rbf-cd-state before"}, run.logged('"name":"before"'),
        {"submit": f"/cd {run.B}"}, shows(f"Working directory changed to {run.B}."), {"sleep": 1.0}, {"snapshot": "after-move"},
        {"submit": "/rbf-cd-state after"}, run.logged('"name":"after"'),
        {"submit": "prompt after the move"}, run.said("STEP_3"), {"sleep": 1.5},
        {"submit": "!pwd"}, run.said('"command":"pwd"'), {"sleep": 1.0},
        {"submit": "/cd"}, shows("Usage: /cd <path>"), {"sleep": 0.5},
    ], pin_model=False)
    after_move = open(os.path.join(result["out"], "screen-after-move.txt"), encoding="utf-8").read() if os.path.exists(os.path.join(result["out"], "screen-after-move.txt")) else ""
    # The screen assertion, written before the move existed: the last notification is ours, not Pi's.
    check(squeeze(f"Working directory changed to {run.B}.") in squeeze(after_move), "the screen shows the success copy after the move")
    check("Resumed session" not in after_move and "Resumed session" not in result["screen"], "Pi's own 'Resumed session' is not on the screen")
    check(squeeze(f"Working directory: {run.B}") in squeeze(result["screen"]) and "Usage: /cd <path>" in result["screen"], "bare /cd shows the directory and the usage line")
    footers = [line for line in result["screen"].split("\n") if "📁" in line]
    check(bool(footers) and re.search(r"📁\s*B\b", footers[-1]) is not None, f"the footer shows B (last footer line: {footers[-1].strip() if footers else None!r})")

    states = {row["name"]: row for row in run.records("state")}
    turns = run.records("turn")
    if not check(len(turns) == 2 and "before" in states and "after" in states, f"two turns and two state records were observed (turns={len(turns)}, states={sorted(states)})"):
        return
    before, after = states["before"], states["after"]
    check(after["sessionId"] == before["sessionId"], "the session ID is the same")
    for key in ("model", "thinkingLevel", "sessionName"):
        check(after[key] == before[key] and before[key], f"{key} is unchanged ({before[key]!r} -> {after[key]!r})")
    check(before["model"] == "rbf-cd-gate/think" and before["thinkingLevel"] == "high" and before["sessionName"] == "cd-move-check", "the run picked a non-default model, thinking level and name first")
    check(turns[1]["prompt"] == "prompt after the move", "no turn started until a prompt was typed")
    turn_in(run, turns[0], run.A, "RULE_CD_A", "RULE_CD_B", "turn before the move")
    turn_in(run, turns[1], run.B, "RULE_CD_B", "RULE_CD_A", "turn after the move")
    check(turns[1]["sessionId"] == before["sessionId"], "the turn after the move ran under the same session ID")

    mine = [session for session in run.sessions() if session["header"].get("id") == before["sessionId"]]
    if not check(len(mine) == 1 and len(run.sessions()) == 1, f"one session file exists for that ID (found {[s['path'] for s in run.sessions()]})"):
        return
    new = mine[0]
    check(new["header"]["cwd"] == run.B and os.path.dirname(new["path"]) == run.folder(run.B), "it is in B's folder and its header names B")
    old_name = os.path.basename(before["sessionFile"])
    check(run.trashed() == [old_name], f"the old file is in <root>/trash (trash holds {run.trashed()})")
    if os.path.exists(os.path.join(run.trash, old_name)):
        _, old_lines = read_session(os.path.join(run.trash, old_name))
        check(new["lines"][: len(old_lines)] == old_lines and len(old_lines) > 0, f"every earlier entry is byte-identical, id and parent included ({len(old_lines)} entries)")
    check(moves_of(new)[-1:] == [{"from": run.A, "to": run.B, "sessionId": before["sessionId"]}], f"the last move entry is A to B with that session ID (saw {moves_of(new)})")
    text = "\n".join(new["lines"])
    check("MARKER_CD_B" in text, "the next turn's bash printed B's marker")
    pwd = [entry for entry in new["entries"] if entry.get("message", {}).get("role") == "bashExecution" and entry["message"].get("command") == "pwd"]
    check(len(pwd) == 1 and pwd[0]["message"].get("output", "").strip() == run.B, f"!pwd printed B (saw {[p['message'].get('output') for p in pwd]})")


# ─── S3 ──────────────────────────────────────────────────────────────────────

def scenario_reopen():
    run = Run()
    run.tui("move", run.first_turn() + [
        {"submit": f"/cd {run.B}"}, shows(f"Working directory changed to {run.B}."), {"sleep": 1.0},
        {"submit": f"/cd {run.B}/missing"}, shows(f"Can't change directory: path does not exist: {run.B}/missing."), {"sleep": 0.5},
    ])
    sessions = run.sessions()
    if not check(len(sessions) == 1 and sessions[0]["header"].get("cwd") == run.B, "after the move and a refused /cd there is one session file, in B"):
        return
    session_id, new_file = sessions[0]["header"]["id"], sessions[0]["path"]

    run.print_mode("B-continue", run.B, ["-c"])
    run.print_mode("A-continue", run.A, ["-c"])
    run.print_mode("A-session", run.A, ["--session", new_file])
    seen = {label: run.records("turn", label) for label in ("B-continue", "A-continue", "A-session")}
    if not check(all(len(rows) == 1 for rows in seen.values()), f"each reopen ran one turn ({ {label: len(rows) for label, rows in seen.items()} })"):
        return
    check(seen["B-continue"][0]["sessionId"] == session_id, "pi -c from B continues the conversation")
    turn_in(run, seen["B-continue"][0], run.B, "RULE_CD_B", "RULE_CD_A", "pi -c from B")
    check(seen["A-continue"][0]["sessionId"] != session_id and seen["A-continue"][0]["entries"] <= 3, "pi -c from A starts a new session")
    turn_in(run, seen["A-continue"][0], run.A, "RULE_CD_A", "RULE_CD_B", "pi -c from A")
    check(seen["A-session"][0]["sessionId"] == session_id, "pi --session <new file> from A opens the conversation")
    check(seen["A-session"][0]["ctxCwd"] == run.B and "RULE_CD_B" in seen["A-session"][0]["systemPrompt"], "and it opens in B, with B's rule")
    check(len([s for s in run.sessions() if s["header"].get("id") == session_id]) == 1, "the conversation still has one file")


# ─── S4 ──────────────────────────────────────────────────────────────────────

def scenario_branch():
    def three_turns(run):
        steps = []
        for number, step in ((1, "STEP_1"), (2, "STEP_3"), (3, "STEP_5")):
            steps += [{"submit": f"prompt number {number}"}, run.said(step), {"sleep": 1.2}]
        return steps

    # 1: the end of the first turn is selected.
    run = Run("end-of-first-turn")
    run.tui("branch", three_turns(run) + [
        {"submit": "/rbf-cd-select text:STEP_1"}, run.logged('"kind":"select"'), {"sleep": 0.8},
        {"submit": f"/cd {run.B}"}, shows(f"Working directory changed to {run.B}."), {"sleep": 1.0},
        {"submit": "/rbf-cd-state after"}, run.logged('"name":"after"'),
        {"submit": "prompt after the move"}, run.said("STEP_3", 2), {"sleep": 1.2},
    ])
    select, states, sessions = run.records("select"), run.records("state"), run.sessions()
    if check(len(select) == 1 and len(states) == 1 and len(sessions) == 1, "[end of first turn] one selection, one state record, one session file"):
        target = select[0]["target"]
        check(select[0].get("leaf") == target, "[end of first turn] the entry was selected before the move")
        check(states[0]["leaf"] == target, "[end of first turn] the same entry is selected after the move")
        by_id = {entry["id"]: entry for entry in sessions[0]["entries"]}
        prompt = [entry for entry in sessions[0]["entries"] if entry.get("message", {}).get("role") == "user" and entry["message"].get("content") in ("prompt after the move", [{"type": "text", "text": "prompt after the move"}])]
        parent = prompt[0]["parentId"] if len(prompt) == 1 else None
        # Pi 1.0.2 records the changed system prompt as an entry of its own, between the selected entry and the prompt.
        while parent in by_id and by_id[parent].get("message", {}).get("role") == "system" and parent != target:
            parent = by_id[parent]["parentId"]
        check(parent == target, "[end of first turn] the next prompt continues from that entry")
        text = "\n".join(sessions[0]["lines"])
        check(text.count('"text":"STEP_3"') == 2 and "STEP_7" not in text, "[end of first turn] the provider answered with step 3, not step 7")
        check(moves_of(sessions[0])[-1:] == [{"from": run.A, "to": run.B, "sessionId": sessions[0]["header"]["id"]}], "[end of first turn] the move entry is in the file all the same")

    # 2: a user message is selected with the call /tree makes. Pi selects the entry before it and puts the
    # message in the editor, before /cd is typed. The editor must be emptied to type /cd at all.
    run = Run("user-message")
    run.tui("branch", three_turns(run) + [
        {"submit": "/rbf-cd-select user:2"}, run.logged('"kind":"select"'), {"sleep": 0.8}, {"snapshot": "selected"},
        {"key": "ctrl-u"}, {"sleep": 0.3},
        {"submit": f"/cd {run.B}"}, shows(f"Working directory changed to {run.B}."), {"sleep": 1.0},
        {"submit": "/rbf-cd-state after"}, run.logged('"name":"after"'),
        {"submit": "prompt after the move"}, run.said("STEP_3", 2), {"sleep": 1.2},
    ])
    select, states, sessions = run.records("select"), run.records("state"), run.sessions()
    if check(len(select) == 1 and len(states) == 1 and len(sessions) == 1, "[user message] one selection, one state record, one session file"):
        check(select[0].get("leaf") == select[0]["parent"] and select[0]["parent"], "[user message] Pi selected the entry before the message")
        check(states[0]["leaf"] == select[0]["parent"], "[user message] the entry before it is selected after the move")
        text = "\n".join(sessions[0]["lines"])
        check(text.count('"text":"STEP_3"') == 2 and "STEP_7" not in text, "[user message] the next turn continues from that entry")
    note("[user message] 'the message's text is in the editor after the move' was NOT RUN: /cd can't be typed while the editor holds it")

    # 3: rewound to before the first message. Pi writes the model and thinking level as the session's first
    # entries, so "before the first message" is still an entry, and the move restores it like any other.
    run = Run("before-first-message")
    result = run.tui("branch", three_turns(run) + [
        {"submit": "/rbf-cd-select user:1"}, run.logged('"kind":"select"'), {"sleep": 0.8},
        {"key": "ctrl-u"}, {"sleep": 0.3},
        {"submit": f"/cd {run.B}"}, shows(f"Working directory changed to {run.B}."), {"sleep": 1.0},
        {"submit": "/rbf-cd-state after"}, run.logged('"name":"after"'),
        {"submit": "prompt after the move"}, run.said("STEP_1", 2), {"sleep": 1.2},
    ])
    select, states, sessions = run.records("select"), run.records("state"), run.sessions()
    if check(len(select) == 1 and len(states) == 1 and len(sessions) == 1, "[before first message] one selection, one state record, one session file"):
        check(select[0].get("leaf") == select[0]["parent"] and select[0]["parent"], f"[before first message] Pi selected the entry before the first message ({select[0].get('leaf')})")
        check(states[0]["leaf"] == select[0]["parent"], "[before first message] the same entry is selected after the move")
        check("could not be restored" not in result["screen"], "[before first message] the move showed the plain success copy")
        text = "\n".join(sessions[0]["lines"])
        check(text.count('"text":"STEP_1"') == 2 and "STEP_7" not in text, "[before first message] the next turn starts over from there: step 1, not step 7")

    # 4: the same, in a session whose first entry is the first message. Then there is no entry to select.
    run = Run("no-entry-before-first-message")
    restored = "The selected point in the conversation could not be restored, so it continues from the latest message."
    run.tui("base", three_turns(run))
    sessions = run.sessions()
    if check(len(sessions) == 1, "[no entry before] a real session file exists in A"):
        header, entries = sessions[0]["header"], sessions[0]["entries"]
        first = next(index for index, entry in enumerate(entries) if entry.get("message", {}).get("role") == "user")
        kept = [{**entries[first], "parentId": None}] + entries[first + 1 :]
        open(sessions[0]["path"], "w", encoding="utf-8").write("\n".join(json.dumps(row, separators=(",", ":")) for row in [header] + kept) + "\n")
        result = run.tui("branch", [
            {"submit": "/rbf-cd-select user:1"}, run.logged('"kind":"select"'), {"sleep": 0.8},
            {"key": "ctrl-u"}, {"sleep": 0.3},
            {"submit": f"/cd {run.B}"}, shows(f"Working directory changed to {run.B}. {restored}"), {"sleep": 1.0},
            {"submit": "prompt after the move"}, run.said("STEP_7"), {"sleep": 1.2},
        ], extra=["-c"])
        select, sessions = run.records("select"), run.sessions()
        if check(len(select) == 1 and len(sessions) == 1, "[no entry before] one selection, one session file"):
            check(select[0].get("leaf") is None and select[0]["parent"] is None, "[no entry before] nothing was selected before the move")
            check(squeeze(f"Warning: Working directory changed to {run.B}. {restored}") in squeeze(result["screen"]), "[no entry before] the move succeeded and showed the 'could not be restored' copy as a warning")
            check(sessions[0]["header"]["cwd"] == run.B and len(run.trashed()) == 1, "[no entry before] one file, in B, and the old one in the trash")
            check("STEP_7" in "\n".join(sessions[0]["lines"]), "[no entry before] the conversation continues from the latest message")


# ─── S5 ──────────────────────────────────────────────────────────────────────

def scenario_busy():
    def refused(run, name, result, copy, pattern, turn_count):
        processes = result["recorded"].get("process", [])
        check(squeeze("Warning: " + copy) in squeeze(result["screen"]), f"[{name}] the exact warning shows")
        check(squeeze(result["screen"]).count(squeeze("Warning: " + copy)) == 2, f"[{name}] the typed command was back in the editor: Enter alone ran it again")
        check(len(processes) >= 1 and all(p["running"] for p in processes), f"[{name}] the work ({pattern}) was still running a second later ({processes})")
        no_file_for(run, run.B, f"[{name}]")
        check(run.trashed() == [] and len(run.sessions()) <= 1, f"[{name}] nothing was retired or copied")
        check(run.records("before_switch") == [], f"[{name}] Pi was never asked to switch")
        turns = run.records("turn")
        if check(len(turns) == turn_count, f"[{name}] {turn_count} turns ran ({len(turns)})"):
            turn_in(run, turns[-1], run.A, "RULE_CD_A", "RULE_CD_B", f"[{name}] the next turn")

    # A response held open: the first step is a slow bash call.
    run = Run("response")
    script = [{"tool": "bash", "args": {"command": "sleep 12.417"}}, {"text": "STEP_1"}, BASH, {"text": "STEP_3"}]
    result = run.tui("busy", [
        {"submit": "first prompt in A"}, run.logged('"kind":"tool_start"'), {"sleep": 0.8},
        {"submit": f"/cd {run.B}"}, shows(BUSY_RESPONSE), {"sleep": 1.0}, {"process": "sleep 12.417"},
        # The typed command is back in the editor: Enter alone runs it again.
        {"key": "enter"}, shows(BUSY_RESPONSE, 2), {"process": "sleep 12.417"},
        run.said("STEP_1"), {"sleep": 1.2}, {"key": "ctrl-u"}, {"sleep": 0.3},
        {"submit": "next prompt"}, run.said("STEP_3"), {"sleep": 1.2},
    ], script=script)
    refused(run, "response", result, BUSY_RESPONSE, "sleep 12.417", 2)

    # A tracked background task: a ! command moved to the background with Ctrl+B.
    run = Run("background-task")
    copy = "Can't change directory while a background task is running. Finish or stop it, then retry /cd."
    result = run.tui("busy", [
        {"submit": "!sleep 60.418"}, {"sleep": 1.5}, {"key": "ctrl-b"}, shows("1 shell", timeout=15), {"sleep": 0.5},
        {"submit": f"/cd {run.B}"}, shows(copy), {"sleep": 1.0}, {"process": "sleep 60.418"},
        {"key": "enter"}, shows(copy, 2), {"process": "sleep 60.418"},
        {"key": "ctrl-u"}, {"sleep": 0.3},
        {"submit": "next prompt"}, run.said("STEP_1"), {"sleep": 1.2},
    ])
    refused(run, "background task", result, copy, "sleep 60.418", 1)

    # A ! command still in the foreground.
    run = Run("command")
    copy = "Can't change directory while a command is running. Wait for it to finish or stop it, then retry /cd."
    result = run.tui("busy", [
        {"submit": "!sleep 60.419"}, {"sleep": 1.5},
        {"submit": f"/cd {run.B}"}, shows(copy), {"sleep": 1.0}, {"process": "sleep 60.419"},
        {"key": "enter"}, shows(copy, 2), {"process": "sleep 60.419"},
        {"key": "ctrl-u"}, {"sleep": 0.3}, {"key": "escape"}, {"sleep": 1.5},
        {"submit": "next prompt"}, run.said("STEP_1"), {"sleep": 1.2},
    ])
    refused(run, "command", result, copy, "sleep 60.419", 1)

    # A sandboxed session.
    run = Run("sandbox")
    copy = f"Can't change directory in a sandboxed session. Working directory is still {run.A}."
    result = run.tui("busy", [{"submit": f"/cd {run.B}"}, shows(copy, timeout=20), {"sleep": 0.5}], extra=["--sandbox", "-e", os.path.join(EXT, "rbf-sandbox", "index.ts")], startup=8)
    check(squeeze("Warning: " + copy) in squeeze(result["screen"]), "[sandbox] the sandbox copy shows")
    no_file_for(run, run.B, "[sandbox]")
    check(run.trashed() == [] and run.records("before_switch") == [], "[sandbox] nothing was written and Pi was never asked to switch")


# ─── S6 ──────────────────────────────────────────────────────────────────────

def scenario_cancel():
    run = Run()
    copy = f"Directory change cancelled. Working directory is still {run.A}."
    result = run.tui("cancel", run.first_turn() + [
        {"sha": {"glob": run.sessions_glob, "name": "before"}},
        {"submit": f"/cd {run.B}"}, shows(copy), {"sleep": 1.0}, {"snapshot": "cancelled"},
        {"sha": {"glob": run.sessions_glob, "name": "after"}},
        # The typed command is back in the editor: Enter alone runs it again, and the hook cancels again.
        {"key": "enter"}, run.logged('"kind":"before_switch"', 2), {"sleep": 1.0},
        {"key": "ctrl-u"}, {"sleep": 0.3},
        {"submit": "/rbf-cd-state after-cancel"}, run.logged('"name":"after-cancel"'),
        {"submit": "next prompt"}, run.said("STEP_3"), {"sleep": 1.2},
    ], hook="cancel")
    check(squeeze(copy) in squeeze(result["screen"]), "the cancel copy shows")
    check(result["recorded"].get("before") == result["recorded"].get("after") and len(result["recorded"].get("before", {})) == 1, "the new file is gone and the original is unchanged")
    no_file_for(run, run.B, "after the cancel")
    check(len(run.records("before_switch")) == 2, "the typed command was back in the editor: Enter alone retried it")
    states, turns = run.records("state"), run.records("turn")
    check(len(states) == 1 and states[0]["processCwd"] == run.A and states[0]["ctxCwd"] == run.A, "the process directory is A")
    if check(len(turns) == 2, "the next turn ran"):
        turn_in(run, turns[1], run.A, "RULE_CD_A", "RULE_CD_B", "the next turn")
    check(run.trashed() == [], "nothing went to the trash")


def scenario_failed_switch(hook):
    """`fail`: the new file is made unreadable, so Pi's own open throws. `vanish`: the destination is deleted before Pi opens it."""
    run = Run()
    result = run.tui(hook, run.first_turn() + [
        {"sha": {"glob": run.sessions_glob, "name": "before"}},
        {"submit": f"/cd {run.B}"}, {"waitExit": 25},
    ], hook=hook)
    before = result["recorded"].get("before", {})
    if not check(len(before) == 1, "the conversation had one saved file before the move"):
        return
    old_file = next(iter(before))
    # On a vanished directory Pi 1.0.2's own fatal handler throws, and Pi stops with code 0 a moment later.
    stopped = result["exit"] is not None and not result["quitByDriver"]
    check(stopped and (hook == "vanish" or result["exit"] == 1), f"Pi stopped by itself{'' if hook == 'vanish' else ' with code 1'} (exit {result['exit']})")
    check([s["path"] for s in run.sessions()] == [old_file], f"the new file is gone ({[s['path'] for s in run.sessions()]})")
    check(os.path.exists(old_file) and sha(old_file) == before[old_file], "the original file in A is byte-identical to before")
    expected = [f"/cd failed and Pi stopped. This conversation is saved in {run.A}.", "Reopen it with:", f"pi --session '{old_file}'"]
    # The terminal wraps the command at its width, so compare the tail of the screen with whitespace removed.
    last = [line.strip() for line in result["screen"].split("\n") if line.strip()][-5:]
    check(squeeze(result["screen"]).endswith(squeeze("".join(expected))), f"the terminal's last lines are the three reopen lines (saw {last})")
    # And the bytes as written, before the terminal wrapped them: no escapes, no carriage returns.
    written = re.sub(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\r", "", open(os.path.join(result["out"], "raw.bin"), "rb").read().decode("utf-8", "replace")).rstrip("\n")
    check(written.endswith("\n" + "\n".join(expected)), "they are three lines, with the command alone on the last")
    check(run.trashed() == [], "nothing went to the trash")

    # Run the command the terminal printed, read the way a shell reads it, from a third directory.
    command = shlex.split(written.split("\n")[-1])
    if check(command == ["pi", "--session", old_file], "the printed command names the original file"):
        run.print_mode("reopen", run.root, command[1:])
        turns = run.records("turn", "reopen")
        if check(len(turns) == 1 and turns[0]["sessionId"] == read_session(old_file)[0]["id"], "running that command opens the conversation"):
            check(turns[0]["ctxCwd"] == run.A and "RULE_CD_A" in turns[0]["systemPrompt"], "and it opens in A")


# ─── S7 ──────────────────────────────────────────────────────────────────────

def scenario_leftovers():
    def base(run, turns):
        steps = []
        for number, step in list(((1, "STEP_1"), (2, "STEP_3")))[:turns]:
            steps += [{"submit": f"prompt number {number}"}, run.said(step), {"sleep": 1.2}]
        run.tui("base", steps)
        sessions = run.sessions()
        return sessions[0]["path"] if len(sessions) == 1 else None

    def copy_into_b(run, source, lines, move):
        """Hand-build what an interrupted /cd leaves: a same-ID file in B's folder, with or without the move entry."""
        header, _ = read_session(source)
        os.makedirs(run.folder(run.B), exist_ok=True)
        stamp = time.strftime("%Y-%m-%dT%H-%M-%S", time.gmtime())
        target = os.path.join(run.folder(run.B), f"{stamp}-000Z_{header['id']}.jsonl")
        rows = [json.dumps({**header, "cwd": run.B, "parentSession": source}, separators=(",", ":"))] + list(lines)
        if move:
            rows.append(json.dumps({"type": "custom", "customType": MOVE_ENTRY, "data": {"from": run.A, "to": run.B, "sessionId": header["id"]}, "id": "cdmove01", "parentId": json.loads(lines[-1])["id"], "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())}, separators=(",", ":")))
        open(target, "w", encoding="utf-8").write("\n".join(rows) + "\n")
        return target

    def first_turn_of(lines):
        return lines[: next(index for index, line in enumerate(lines) if '"text":"STEP_1"' in line) + 1]

    # 1: a finished copy in B, the old file in A unchanged. Opening B retires the old file.
    run = Run("finished")
    old = base(run, 1)
    if check(old is not None, "[finished] a real session file exists in A"):
        copy = copy_into_b(run, old, read_session(old)[1], move=True)
        result = run.tui("open-b", [{"sleep": 2.0}], cwd=run.B, extra=["-c"])
        check(run.trashed() == [os.path.basename(old)], f"[finished] opening B sent the old file to <root>/trash ({run.trashed()})")
        check([s["path"] for s in run.sessions()] == [copy], "[finished] one file is left, the one in B")
        check("STEP_1" in result["screen"] and "Warning" not in result["screen"], "[finished] the conversation opened with no warning")

    # 2: the same, but the old file has one more turn. Opening B warns and deletes nothing.
    run = Run("finished-older-has-more")
    old = base(run, 2)
    if check(old is not None, "[older has more] a real session file exists in A"):
        copy = copy_into_b(run, old, first_turn_of(read_session(old)[1]), move=True)
        hashes = (sha(old), sha(copy))
        warning = f"An older copy of this conversation has turns this one doesn't. Nothing was deleted. The older copy: {old}"
        result = run.tui("open-b", [shows(warning, timeout=20), {"sleep": 1.0}], cwd=run.B, extra=["-c"])
        below_conversation(result["screen"], "Warning: " + warning, "[older has more]")
        check(run.trashed() == [] and (sha(old), sha(copy)) == hashes, "[older has more] nothing was deleted or changed")

    # 3: an unfinished copy in B that holds nothing new. /cd B from A retires it and moves normally.
    run = Run("unfinished-stale")
    old = base(run, 1)
    if check(old is not None, "[unfinished, stale] a real session file exists in A"):
        copy = copy_into_b(run, old, read_session(old)[1], move=False)
        run.tui("move", [{"submit": f"/cd {run.B}"}, shows(f"Working directory changed to {run.B}."), {"sleep": 1.0}], cwd=run.A, extra=["-c"])
        check(run.trashed() == sorted([os.path.basename(old), os.path.basename(copy)]), f"[unfinished, stale] the stale copy and the old file are both in the trash ({run.trashed()})")
        sessions = run.sessions()
        check(len(sessions) == 1 and sessions[0]["header"]["cwd"] == run.B and moves_of(sessions[0])[-1:] == [{"from": run.A, "to": run.B, "sessionId": sessions[0]["header"]["id"]}], "[unfinished, stale] one file is left, in B, with its move entry")

    # 4: the unfinished copy opened directly. It warns below the conversation.
    run = Run("unfinished-opened")
    old = base(run, 1)
    if check(old is not None, "[unfinished, opened] a real session file exists in A"):
        copy = copy_into_b(run, old, read_session(old)[1], move=False)
        hashes = (sha(old), sha(copy))
        command = f"pi --session {read_session(old)[0]['id']}"
        warning = f"This is an unfinished copy from an interrupted /cd. The conversation is saved in {run.A}. Quit Pi, go to that directory, and run:"
        result = run.tui("open-b", [shows(warning + command, timeout=20), {"sleep": 1.0}], cwd=run.B, extra=["-c"])
        below_conversation(result["screen"], "Warning: " + warning + command, "[unfinished, opened]")
        check(command in [line.strip() for line in result["screen"].split("\n")], f"[unfinished, opened] '{command}' is on screen unbroken, alone on its line")
        # From the original directory that command opens the original, not this copy.
        run.print_mode("reopen", run.A, shlex.split(command)[1:])
        turns = run.records("turn", "reopen")
        check(len(turns) == 1 and turns[0]["sessionFile"] == old and turns[0]["ctxCwd"] == run.A, "[unfinished, opened] run from that directory, the command opens the original")
        check(run.trashed() == [] and sha(copy) == hashes[1], "[unfinished, opened] nothing was deleted, and the copy is unchanged")

    # 5: a copy in B with a turn A lacks. /cd B from A refuses and touches neither file.
    run = Run("copy-has-more")
    old = base(run, 2)
    if check(old is not None, "[copy has more] a real session file exists in A"):
        header, lines = read_session(old)
        copy = copy_into_b(run, old, lines, move=False)
        open(old, "w", encoding="utf-8").write("\n".join([json.dumps(header, separators=(",", ":"))] + first_turn_of(lines)) + "\n")
        hashes = (sha(old), sha(copy))
        refusal = f"Can't change directory: this conversation already has a copy there. Working directory is still {run.A}."
        result = run.tui("move", [{"submit": f"/cd {run.B}"}, shows(refusal), {"sleep": 1.0}, {"sha": {"glob": run.sessions_glob, "name": "after"}}], cwd=run.A, extra=["-c"])
        check(squeeze("Error: " + refusal) in squeeze(result["screen"]), "[copy has more] the refusal shows as an error")
        check(result["recorded"].get("after") == {old: hashes[0], copy: hashes[1]} if old < copy else result["recorded"].get("after") == {copy: hashes[1], old: hashes[0]}, "[copy has more] both files are untouched")
        check(run.trashed() == [] and run.records("before_switch") == [], "[copy has more] nothing went to the trash and Pi was never asked to switch")

    # 6: the fake trash exits 1 on a normal move, then works again for the move back.
    run = Run("trash-fails")
    open(run.trash_fails, "w").close()
    left = "The previous session file could not be moved to the Trash:"
    result = run.tui("move", run.first_turn() + [
        {"submit": f"/cd {run.B}"}, shows(f"Working directory changed to {run.B}. {left}"), {"sleep": 1.0}, {"snapshot": "trash-failed"},
        {"sha": {"glob": run.sessions_glob, "name": "trash-failed"}},
        {"remove": run.trash_fails},
        {"submit": f"/cd {run.A}"}, shows(f"Working directory changed to {run.A}."), {"sleep": 1.0},
    ])
    held = sorted(result["recorded"].get("trash-failed", {}))
    in_a = [path for path in held if os.path.dirname(path) == run.folder(run.A)]
    if check(len(held) == 2 and len(in_a) == 1, f"[trash fails] after the failed Trash step the old file is still in A's folder ({held})"):
        snapshot = open(os.path.join(result["out"], "screen-trash-failed.txt"), encoding="utf-8").read()
        check(squeeze(f"Warning: Working directory changed to {run.B}. {left} {in_a[0]}") in squeeze(snapshot), "[trash fails] copy #9 shows with the old file's path")
        sessions = run.sessions()
        check(len(sessions) == 1 and sessions[0]["header"]["cwd"] == run.A, f"[trash fails] after /cd A one file is left for the session ID, in A ({[s['path'] for s in sessions]})")
        check(run.trashed() == sorted(os.path.basename(path) for path in held), f"[trash fails] the stale file and the B file are in the trash ({run.trashed()})")
        check([(m["from"], m["to"]) for m in moves_of(sessions[0])] == [(run.A, run.B), (run.B, run.A)] if sessions else False, "[trash fails] the file's move entries are A to B, then B to A")


# ─── S8 ──────────────────────────────────────────────────────────────────────

def scenario_fresh():
    run = Run("new-conversation")
    result = run.tui("fresh", [
        {"submit": "/rbf-cd-set rbf-cd-gate/think high"}, run.logged('"kind":"set"'), {"sleep": 0.5},
        {"submit": "/rbf-cd-state before"}, run.logged('"name":"before"'),
        {"submit": f"/cd {run.B}"}, shows(f"Working directory changed to {run.B}."), {"sleep": 1.0},
        {"submit": "/rbf-cd-state after"}, run.logged('"name":"after"'),
        {"submit": "first prompt after a fresh move"}, run.said("STEP_1"), {"sleep": 1.5},
    ], pin_model=False)
    check(squeeze(f"Working directory changed to {run.B}.") in squeeze(result["screen"]) and "Resumed session" not in result["screen"], "[new] /cd before any prompt shows the success copy")
    states, turns, sessions = {row["name"]: row for row in run.records("state")}, run.records("turn"), run.sessions()
    if check(len(turns) == 1 and len(states) == 2, "[new] one turn and two state records were observed"):
        turn_in(run, turns[0], run.B, "RULE_CD_B", "RULE_CD_A", "[new] the first prompt")
        # Nothing was saved, so the session is new: a new ID, and the pick is carried by /cd, not by copied entries.
        check(states["after"]["sessionId"] != states["before"]["sessionId"], "[new] the conversation moved as a new session")
        check(states["after"]["thinkingLevel"] == states["before"]["thinkingLevel"] == "high", f"[new] the thinking level changed before the move is the same after it ({states['before']['thinkingLevel']!r} -> {states['after']['thinkingLevel']!r})")
        check(states["after"]["model"] == states["before"]["model"] == "rbf-cd-gate/think", f"[new] the model picked before the move is the same after it ({states['before']['model']!r} -> {states['after']['model']!r})")
        check(turns[0]["model"] == "rbf-cd-gate/think" and turns[0]["thinkingLevel"] == "high", "[new] the first prompt ran with that model and thinking level")
    if check(len(sessions) == 1, f"[new] one session file exists ({[s['path'] for s in sessions]})"):
        session = sessions[0]
        check(session["header"]["cwd"] == run.B and os.path.dirname(session["path"]) == run.folder(run.B), "[new] it is in B's folder")
        check(moves_of(session) == [{"from": run.A, "to": run.B, "sessionId": session["header"]["id"]}], f"[new] its move entry carries the new session's ID ({moves_of(session)})")
        check("MARKER_CD_B" in "\n".join(session["lines"]), "[new] the first prompt's bash printed B's marker")
    check(run.trashed() == [], "[new] nothing went to the trash")

    run = Run("no-session")
    copy = f"Can't change directory in a session that isn't being saved. Working directory is still {run.A}."
    result = run.tui("fresh", [{"submit": f"/cd {run.B}"}, shows(copy), {"sleep": 0.5}], extra=["--no-session"])
    check(squeeze("Warning: " + copy) in squeeze(result["screen"]), "[--no-session] the 'isn't being saved' copy shows")
    check(run.sessions() == [] and run.trashed() == [] and run.records("before_switch") == [], "[--no-session] nothing was written")


def scenario_trust(choice):
    run = Run()
    os.makedirs(os.path.join(run.B, ".pi", "extensions"))
    if choice == "load-error":
        source = 'throw new Error("CD_BOOM_AT_LOAD");\nexport default function () {}\n'
    else:
        source = 'import { appendFileSync } from "node:fs";\nexport default function () { appendFileSync(process.env.RBF_CD_OBSERVE_LOG, JSON.stringify({ kind: "b-extension-loaded" }) + "\\n"); }\n'
    open(os.path.join(run.B, ".pi", "extensions", "project.ts"), "w").write(source)
    keys = [{"key": "down"}, {"key": "down"}, {"key": "down"}, {"sleep": 0.5}] if choice == "decline" else []
    result = run.tui(choice, run.first_turn() + [
        {"submit": f"/cd {run.B}"}, shows("Trust project folder?", timeout=20), {"sleep": 0.5}, {"snapshot": "trust-prompt"},
        *keys, {"key": "enter"},
        shows(f"Working directory changed to {run.B}."), {"sleep": 1.0},
        {"submit": "prompt after the move"}, run.said("STEP_3"), {"sleep": 1.5},
    ], discover=True)
    check("Trust project folder?" in result["screen"] or os.path.exists(os.path.join(result["out"], "screen-trust-prompt.txt")), "/cd raised Pi's trust prompt")
    loaded = len(run.records("b-extension-loaded")) > 0
    if choice == "trust":
        check(loaded, "choosing Trust loaded B's project extension")
    elif choice == "decline":
        check(not loaded, "choosing Do not trust did not load B's project extension")
    else:
        check("CD_BOOM_AT_LOAD" in result["screen"], "Pi showed the project extension's load error")
    turns, sessions = run.records("turn"), run.sessions()
    if check(len(turns) == 2, "a turn ran after the move"):
        turn_in(run, turns[1], run.B, "RULE_CD_B", "RULE_CD_A", "the turn after the move")
        check(turns[1]["sessionId"] == turns[0]["sessionId"], "under the same session ID")
    check(len(sessions) == 1 and sessions[0]["header"]["cwd"] == run.B and len(run.trashed()) == 1, "the move completed: one file, in B, and the old one in the trash")


SCENARIOS = {
    "move": scenario_move, "reopen": scenario_reopen, "branch": scenario_branch, "busy": scenario_busy, "cancel": scenario_cancel, "fail": lambda: scenario_failed_switch("fail"),
    "leftovers": scenario_leftovers, "fresh": scenario_fresh, "trust": lambda: scenario_trust("trust"), "decline": lambda: scenario_trust("decline"),
    "load-error": lambda: scenario_trust("load-error"), "vanish": lambda: scenario_failed_switch("vanish"),
}
if scenario not in SCENARIOS:
    print(f"FAIL: unknown scenario '{scenario}'. One of: {' '.join(SCENARIOS)}")
    sys.exit(1)
try:
    SCENARIOS[scenario]()
except Exception as error:  # a scenario that can't finish is a failure with its reason, never a traceback and exit 0
    import traceback
    traceback.print_exc()
    failures.append(f"the scenario could not finish: {error!r}")
leftover = subprocess.run(["pgrep", "-f", root + "/"], capture_output=True, text=True).stdout.split()
if leftover:
    failures.append(f"a process started by this run is still alive: {leftover}")
print("FAIL: " + "; ".join(failures) if failures else "PASS")
sys.exit(1 if failures else 0)
PYTHON
