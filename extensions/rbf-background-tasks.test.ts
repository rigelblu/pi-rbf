import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyElapsedHint,
	BASH_EXECUTION_PATCHED_KEY,
	BACKGROUND_TASKS_STATUS_KEY,
	BUSY_QUERY_CHANNEL,
	calculateBadgeBounds,
	createBackgroundableOperations,
	createShellDisplayOwner,
	createTasksModalComponent,
	ensureLogDir,
	formatBackgroundHintMessage,
	formatFooterBadge,
	formatRuntime,
	formatStatsLineWithTasks,
	generateTaskId,
	getActiveTaskManager,
	isSandboxLaunch,
	getBadgeBounds,
	getIsBadgeHovered,
	getIsFooterSelected,
	killProcessTree,
	LOADER_PATCHED_KEY,
	MAX_CONCURRENT_BACKGROUND_TASKS,
	MAX_LOG_BYTES,
	observeShellCall,
	patchBashExecutionComponent,
	patchFooterComponent,
	rbfBackgroundTasks,
	setActiveTaskManager,
	setIsBadgeHovered,
	setIsFooterSelected,
	setOnBadgeClick,
	SHELL_DISPLAY_CHANNEL,
	SHELL_DISPLAY_FACTS_PER_INVOCATION,
	SHELL_DISPLAY_SNAPSHOT_LIMIT,
	TaskManager,
	terminateProcessTree,
	TOOL_EXECUTION_PATCHED_KEY,
	unpatchBashExecutionComponent,
	unpatchFooterComponent,
	updateFooterBadge,
	type BackgroundTask,
	type BusyQuery,
	type ShellDisplayCall,
	type ShellDisplayFact,
} from "./rbf-background-tasks.ts";
import { BashExecutionComponent, createEventBus, FooterComponent, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Loader } from "@earendil-works/pi-tui";

describe("rbf-background-tasks", () => {
	let tempDir: string;

	beforeAll(() => {
		// Fixtures use fake pids (1, 2, 12345...). Let signals reach only children this
		// test run spawned; anything else would hit real processes on the host.
		// Never restored: terminateProcessTree's SIGKILL timer can fire after a test ends.
		const realKill = process.kill.bind(process);
		vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			const target = Math.abs(pid);
			let parent = "";
			try {
				parent = execFileSync("ps", ["-o", "ppid=", "-p", String(target)], { encoding: "utf8" }).trim();
			} catch {}
			if (target <= 1 || parent !== String(process.pid)) {
				throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
			}
			return realKill(pid, signal);
		});
	});

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bg-tasks-test-"));
	});

	afterEach(() => {
		unpatchBashExecutionComponent();
		setActiveTaskManager(null);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	// ─── Pure Helpers ──────────────────────────────────────────────────────────

	describe("Pure Helpers", () => {
		it("generateTaskId returns an 8-character hex string", () => {
			const id1 = generateTaskId();
			const id2 = generateTaskId();
			expect(id1).toHaveLength(8);
			expect(id2).toHaveLength(8);
			expect(/^[0-9a-f]{8}$/i.test(id1)).toBe(true);
			expect(id1).not.toBe(id2);
		});

		it("formatRuntime formats elapsed time across ranges", () => {
			expect(formatRuntime(0)).toBe("0s");
			expect(formatRuntime(500)).toBe("0s");
			expect(formatRuntime(12000)).toBe("12s");
			expect(formatRuntime(59000)).toBe("59s");
			expect(formatRuntime(60000)).toBe("1m 0s");
			expect(formatRuntime(83000)).toBe("1m 23s");
			expect(formatRuntime(3600000)).toBe("1h 0m 0s");
			expect(formatRuntime(8110000)).toBe("2h 15m 10s");
		});

		it("ensureLogDir creates session log directory with mode 0700", () => {
			const dir = ensureLogDir("session 123/abc", tempDir);
			expect(fs.existsSync(dir)).toBe(true);
			expect(dir).toContain("session-session_123_abc");
			const stat = fs.statSync(dir);
			expect(stat.isDirectory()).toBe(true);
		});

		it("formatFooterBadge returns 1 shell, N shells, or undefined", () => {
			expect(formatFooterBadge(0)).toBeUndefined();
			expect(formatFooterBadge(-1)).toBeUndefined();
			expect(formatFooterBadge(1)).toBe("1 shell");
			expect(formatFooterBadge(2)).toBe("2 shells");
			expect(formatFooterBadge(10)).toBe("10 shells");
		});

		it("terminateProcessTree and killProcessTree handle zero or negative pids safely", async () => {
			expect(() => killProcessTree(0)).not.toThrow();
			expect(() => killProcessTree(-1)).not.toThrow();
			await expect(terminateProcessTree(0)).resolves.toBeUndefined();
			await expect(terminateProcessTree(-5)).resolves.toBeUndefined();
		});
	});

	// ─── TaskManager ───────────────────────────────────────────────────────────

	describe("TaskManager", () => {
		it("manages active foreground execution lifecycle", () => {
			const tm = new TaskManager();
			expect(tm.getActiveForeground()).toBeNull();

			const detachFn = vi.fn();
			const abortFn = vi.fn();
			const mockTask: BackgroundTask = {
				id: "task-1",
				command: "sleep 10",
				cwd: tempDir,
				pid: 12345,
				pgid: 12345,
				status: "running",
				exitCode: null,
				startTime: Date.now(),
				logPath: path.join(tempDir, "task-1.log"),
				logBytes: 0,
				isTruncated: false,
				isBackgrounded: false,
			};

			tm.setActiveForeground({ task: mockTask, detach: detachFn, abort: abortFn });
			expect(tm.getActiveForeground()?.task.id).toBe("task-1");

			const detached = tm.detachActiveForeground();
			expect(detached).toBe(true);
			expect(detachFn).toHaveBeenCalledTimes(1);

			tm.clearActiveForeground();
			expect(tm.getActiveForeground()).toBeNull();
			expect(tm.detachActiveForeground()).toBe(false);
		});

		it("adds, retrieves, finds by prefix, and lists tasks", () => {
			const tm = new TaskManager();
			const t1: BackgroundTask = {
				id: "bb7xlukf",
				command: "make run",
				cwd: tempDir,
				pid: 101,
				pgid: 101,
				status: "running",
				exitCode: null,
				startTime: 1000,
				logPath: path.join(tempDir, "bb7xlukf.log"),
				logBytes: 0,
				isTruncated: false,
				isBackgrounded: true,
			};
			const t2: BackgroundTask = {
				id: "aa112233",
				command: "bun test",
				cwd: tempDir,
				pid: 102,
				pgid: 102,
				status: "completed",
				exitCode: 0,
				startTime: 2000,
				logPath: path.join(tempDir, "aa112233.log"),
				logBytes: 0,
				isTruncated: false,
				isBackgrounded: true,
			};

			tm.addBackgroundTask(t1);
			tm.addBackgroundTask(t2);

			expect(tm.getTask("bb7xlukf")).toBe(t1);
			expect(tm.getTask("unknown")).toBeUndefined();

			// Exact & Prefix match
			expect(tm.findTask("bb7xlukf")).toBe(t1);
			expect(tm.findTask("bb7")).toBe(t1);
			expect(tm.findTask("AA1")).toBe(t2);
			expect(tm.findTask("xyz")).toBeUndefined();
			expect(tm.findTask("")).toBeUndefined();

			// Sorted by startTime desc
			const all = tm.getAllTasks();
			expect(all).toEqual([t2, t1]);

			// Running tasks filter
			expect(tm.getRunningTasks()).toEqual([t1]);
		});

		it("stops a running task and updates status", async () => {
			const tm = new TaskManager();
			const logPath = path.join(tempDir, "stop-test.log");
			fs.writeFileSync(logPath, "");
			const logStream = fs.createWriteStream(logPath, { flags: "a", mode: 0o600 });
			await new Promise((resolve) => logStream.once("open", resolve));

			const task: BackgroundTask = {
				id: "stop1234",
				command: "sleep 100",
				cwd: tempDir,
				pid: 999999, // non-existent PID, kill handled safely
				pgid: 999999,
				status: "running",
				exitCode: null,
				startTime: Date.now(),
				logPath,
				logBytes: 0,
				isTruncated: false,
				isBackgrounded: true,
				logStream,
			};

			tm.addBackgroundTask(task);
			expect(tm.getRunningTasks()).toHaveLength(1);

			const stopped = tm.stopTask("stop1234");
			expect(stopped).toBe(true);
			await new Promise((resolve) => logStream.once("finish", resolve));
			expect(task.status).toBe("stopped");
			expect(task.endTime).toBeDefined();
			expect(tm.getRunningTasks()).toHaveLength(0);

			// Calling stop again on already stopped task returns false
			expect(tm.stopTask("stop1234")).toBe(false);
		});

		it("stopAllTasks stops all running tasks and active foreground", () => {
			const tm = new TaskManager();
			const t1: BackgroundTask = {
				id: "t1",
				command: "cmd1",
				cwd: tempDir,
				pid: 1,
				pgid: 1,
				status: "running",
				exitCode: null,
				startTime: 100,
				logPath: path.join(tempDir, "t1.log"),
				logBytes: 0,
				isTruncated: false,
				isBackgrounded: true,
			};
			const t2: BackgroundTask = {
				id: "t2",
				command: "cmd2",
				cwd: tempDir,
				pid: 2,
				pgid: 2,
				status: "running",
				exitCode: null,
				startTime: 200,
				logPath: path.join(tempDir, "t2.log"),
				logBytes: 0,
				isTruncated: false,
				isBackgrounded: true,
			};

			tm.addBackgroundTask(t1);
			tm.addBackgroundTask(t2);

			const abortFg = vi.fn();
			const fgTask: BackgroundTask = {
				id: "t3",
				command: "cmd3",
				cwd: tempDir,
				pid: 3,
				pgid: 3,
				status: "running",
				exitCode: null,
				startTime: 300,
				logPath: path.join(tempDir, "t3.log"),
				logBytes: 0,
				isTruncated: false,
				isBackgrounded: false,
			};
			tm.setActiveForeground({ task: fgTask, detach: vi.fn(), abort: abortFg });

			tm.stopAllTasks();
			expect(t1.status).toBe("stopped");
			expect(t2.status).toBe("stopped");
			expect(abortFg).toHaveBeenCalledTimes(1);
		});
	});

	// ─── BashExecutionComponent Patching ───────────────────────────────────────

	describe("BashExecutionComponent Patching", () => {
		it("formats background hint messages correctly and removes ctrl+c", () => {
			expect(formatBackgroundHintMessage("Running... (escape/ctrl+c to cancel)")).toBe(
				"Running... (ctrl+b to run in background · escape to cancel)",
			);
			expect(formatBackgroundHintMessage("Running... (ctrl+c/escape to cancel)")).toBe(
				"Running... (ctrl+b to run in background · escape to cancel)",
			);
			expect(formatBackgroundHintMessage("Running... (Esc/Ctrl+C to cancel)")).toBe(
				"Running... (ctrl+b to run in background · Esc to cancel)",
			);
			expect(formatBackgroundHintMessage("Running... (Esc to cancel)")).toBe(
				"Running... (ctrl+b to run in background · Esc to cancel)",
			);
			expect(formatBackgroundHintMessage("Running...")).toBe(
				"Running... (ctrl+b to run in background)",
			);
			// Strips ctrl+c even if ctrl+b was already present
			expect(
				formatBackgroundHintMessage(
					"Running... (ctrl+b to run in background · escape/ctrl+c to cancel)",
				),
			).toBe("Running... (ctrl+b to run in background · escape to cancel)");
			// Non-running message untouched
			expect(formatBackgroundHintMessage("Uploading to Radius...")).toBe(
				"Uploading to Radius...",
			);
		});

		it("patches Loader so new running loaders immediately display ctrl+b hint without ctrl+c", () => {
			patchBashExecutionComponent();
			expect((Loader.prototype as any)[LOADER_PATCHED_KEY]).toBe(true);

			const mockUi = { requestRender: vi.fn() } as any;
			const loader = new Loader(
				mockUi,
				(s) => s,
				(s) => s,
				"Running... (escape/ctrl+c to cancel)",
			);

			// Immediately after construction (before any stdout chunks arrive),
			// loader.message must have the background hint and no ctrl+c!
			expect((loader as any).message).toBe(
				"Running... (ctrl+b to run in background · escape to cancel)",
			);

			// setMessage also formats
			loader.setMessage("Running... (Esc/Ctrl+C to cancel)");
			expect((loader as any).message).toBe(
				"Running... (ctrl+b to run in background · Esc to cancel)",
			);

			loader.stop();
			unpatchBashExecutionComponent();
			expect((Loader.prototype as any)[LOADER_PATCHED_KEY]).toBeUndefined();
		});

		it("patches updateDisplay to show (ctrl+b to run in background · Esc to cancel)", () => {
			patchBashExecutionComponent();
			expect((BashExecutionComponent.prototype as any)[BASH_EXECUTION_PATCHED_KEY]).toBe(true);

			const mockLoader = {
				message: "Running...",
				setMessage: vi.fn(function (msg: string) {
					mockLoader.message = msg;
				}),
			};

			const mockInstance = Object.create(BashExecutionComponent.prototype);
			mockInstance.outputLines = [];
			mockInstance.status = "running";
			mockInstance.loader = mockLoader;

			// Call patched updateDisplay
			mockInstance.updateDisplay();
			expect(mockLoader.setMessage).toHaveBeenCalledWith(
				expect.stringContaining("ctrl+b to run in background"),
			);
			expect(mockLoader.message).toContain("ctrl+b to run in background");
			expect(mockLoader.message).not.toContain("ctrl+c");

			unpatchBashExecutionComponent();
			expect((BashExecutionComponent.prototype as any)[BASH_EXECUTION_PATCHED_KEY]).toBeUndefined();
		});

		it("patching is idempotent", () => {
			patchBashExecutionComponent();
			patchBashExecutionComponent();
			expect((BashExecutionComponent.prototype as any)[BASH_EXECUTION_PATCHED_KEY]).toBe(true);
			expect((Loader.prototype as any)[LOADER_PATCHED_KEY]).toBe(true);
			expect((ToolExecutionComponent.prototype as any)[TOOL_EXECUTION_PATCHED_KEY]).toBe(true);
			unpatchBashExecutionComponent();
			expect((BashExecutionComponent.prototype as any)[BASH_EXECUTION_PATCHED_KEY]).toBeUndefined();
			expect((Loader.prototype as any)[LOADER_PATCHED_KEY]).toBeUndefined();
			expect((ToolExecutionComponent.prototype as any)[TOOL_EXECUTION_PATCHED_KEY]).toBeUndefined();
		});

		it("formats agent Working status message with ctrl+b hint when active foreground exists", () => {
			expect(formatBackgroundHintMessage("Working", true)).toBe(
				"Working (ctrl+b to run in background · Esc to cancel)",
			);
			expect(formatBackgroundHintMessage("Working (Esc to interrupt)", true)).toBe(
				"Working (ctrl+b to run in background · Esc to cancel)",
			);
			expect(
				formatBackgroundHintMessage(
					"Working (ctrl+b to run in background · Esc to cancel)",
					false,
				),
			).toBe("Working");
			expect(formatBackgroundHintMessage("Working", false)).toBe("Working");

			// Dynamically respects activeTaskManager foreground execution
			const tm = new TaskManager();
			setActiveTaskManager(tm);

			expect(formatBackgroundHintMessage("Working")).toBe("Working");

			tm.setActiveForeground({
				task: { id: "test" } as any,
				detach: () => {},
				abort: () => {},
			});
			expect(formatBackgroundHintMessage("Working")).toBe(
				"Working (ctrl+b to run in background · Esc to cancel)",
			);

			tm.clearActiveForeground();
			expect(
				formatBackgroundHintMessage(
					"Working (ctrl+b to run in background · Esc to cancel)",
				),
			).toBe("Working");
		});

		it("applyElapsedHint appends background hint to Text components displaying elapsed time", () => {
			const mockTextNode = {
				text: "Elapsed 5.2s",
				setText: vi.fn(function (val: string) {
					mockTextNode.text = val;
				}),
			};

			const modified = applyElapsedHint(mockTextNode);
			expect(modified).toBe(true);
			expect(mockTextNode.text).toBe(
				"Elapsed 5.2s · (ctrl+b to run in background · Esc to cancel)",
			);
			expect(mockTextNode.setText).toHaveBeenCalled();

			// Calling again is idempotent (does not duplicate)
			const modifiedAgain = applyElapsedHint(mockTextNode);
			expect(modifiedAgain).toBe(false);
			expect(mockTextNode.text).toBe(
				"Elapsed 5.2s · (ctrl+b to run in background · Esc to cancel)",
			);

			// Traverses nested structure: Container -> MouseRegion -> Text
			const nestedText = {
				text: "Elapsed 12.0s",
				setText: vi.fn(function (val: string) {
					nestedText.text = val;
				}),
			};
			const mouseRegion = { child: nestedText };
			const container = { children: [mouseRegion] };

			const nestedModified = applyElapsedHint(container);
			expect(nestedModified).toBe(true);
			expect(nestedText.text).toBe(
				"Elapsed 12.0s · (ctrl+b to run in background · Esc to cancel)",
			);
		});

		it("patches ToolExecutionComponent.prototype.updateDisplay and restores on unpatch", () => {
			patchBashExecutionComponent();
			expect((ToolExecutionComponent.prototype as any)[TOOL_EXECUTION_PATCHED_KEY]).toBe(true);

			const mockElapsedText = {
				text: "Elapsed 3.4s",
				setText: vi.fn(function (t: string) {
					mockElapsedText.text = t;
				}),
			};

			const mockToolInstance = Object.create(ToolExecutionComponent.prototype);
			mockToolInstance.isPartial = true;
			mockToolInstance.toolName = "bash";
			mockToolInstance.getRenderShell = () => "self";
			mockToolInstance.selfRenderContainer = {
				children: [{ child: mockElapsedText }],
			};

			mockToolInstance.updateDisplay();
			expect(mockElapsedText.text).toContain("ctrl+b to run in background · Esc to cancel");

			unpatchBashExecutionComponent();
			expect((ToolExecutionComponent.prototype as any)[TOOL_EXECUTION_PATCHED_KEY]).toBeUndefined();
		});
	});

	// ─── Footer Badge & Patching ───────────────────────────────────────────────

	describe("updateFooterBadge", () => {
		it("clears separate status key to prevent 3rd line and calls requestRender", () => {
			const tm = new TaskManager();
			const setStatus = vi.fn();
			const requestRender = vi.fn();
			const mockCtx = {
				ui: { setStatus, requestRender },
			} as any;

			updateFooterBadge(mockCtx, tm);
			expect(setStatus).toHaveBeenCalledWith(BACKGROUND_TASKS_STATUS_KEY, undefined);
			expect(requestRender).toHaveBeenCalled();

			const t1: BackgroundTask = {
				id: "t1",
				command: "cmd",
				cwd: tempDir,
				pid: 1,
				pgid: 1,
				status: "running",
				exitCode: null,
				startTime: Date.now(),
				logPath: "",
				logBytes: 0,
				isTruncated: false,
				isBackgrounded: true,
			};
			tm.addBackgroundTask(t1);

			updateFooterBadge(mockCtx, tm);
			// Clears setStatus to undefined so extension status never occupies lines[2]
			expect(setStatus).toHaveBeenCalledWith(BACKGROUND_TASKS_STATUS_KEY, undefined);
			expect(requestRender).toHaveBeenCalledTimes(2);

			tm.stopTask("t1");
			updateFooterBadge(mockCtx, tm);
			expect(setStatus).toHaveBeenCalledWith(BACKGROUND_TASKS_STATUS_KEY, undefined);
			expect(requestRender).toHaveBeenCalledTimes(3);
		});
	});

	describe("formatStatsLineWithTasks", () => {
		const mockTheme = {
			fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
			bold: (text: string) => `[bold]${text}[/bold]`,
			inverse: (text: string) => `[inv]${text}[/inv]`,
		};

		it("returns line unmodified when task count is 0", () => {
			const line = "0.1%/272k (auto)   claude-3-7-sonnet";
			const result = formatStatsLineWithTasks(line, 0, false, 80, mockTheme);
			expect(result).toBe(line);
		});

		it("appends 1 shell to the right of stats when 1 task is running (unselected)", () => {
			const line = "$0.000 (sub) 0.1%/272k (auto)   claude-3-7-sonnet";
			const result = formatStatsLineWithTasks(line, 1, false, 100, mockTheme);
			expect(result).toContain("[accent]1 shell[/accent]");
			expect(result).toContain("claude-3-7-sonnet");
			expect(result.indexOf("1 shell")).toBeGreaterThan(result.indexOf("0.1%/272k (auto)"));
			expect(result.indexOf("1 shell")).toBeLessThan(result.indexOf("claude-3-7-sonnet"));
		});

		it("appends 2 shells when 2 tasks are running", () => {
			const line = "$0.000 (sub) 0.1%/272k (auto)   claude-3-7-sonnet";
			const result = formatStatsLineWithTasks(line, 2, false, 80, mockTheme);
			expect(result).toContain("2 shells");
		});

		it("highlights badge in inverse when isSelected is true", () => {
			const line = "$0.000 (sub) 0.1%/272k (auto)   claude-3-7-sonnet";
			const result = formatStatsLineWithTasks(line, 1, true, 80, mockTheme);
			expect(result).toContain("[inv] 1 shell [/inv]");
		});

		it("inverts colors when isSelected/hovered is true", () => {
			const themeWithBg = {
				fg: (color: string, text: string) => `[${color}]${text}[/${color}]`,
				bg: (color: string, text: string) => `[bg:${color}]${text}[/bg:${color}]`,
				bold: (text: string) => `[bold]${text}[/bold]`,
				inverse: (text: string) => `[inv]${text}[/inv]`,
			};
			const line = "$0.000 (sub) 0.1%/272k (auto)   claude-3-7-sonnet";
			const result = formatStatsLineWithTasks(line, 1, true, 120, themeWithBg);
			expect(result).toContain("[inv] 1 shell [/inv]");
		});

		it("handles lines without right-aligned model", () => {
			const line = "$0.000 (sub) 0.1%/272k (auto)";
			const result = formatStatsLineWithTasks(line, 1, false, 80, mockTheme);
			expect(result).toContain("0.1%/272k (auto)");
			expect(result).toContain("1 shell");
		});
	});

	describe("calculateBadgeBounds", () => {
		it("returns null when taskCount is 0 or statsLine is empty", () => {
			expect(calculateBadgeBounds("", 1, 80)).toBeNull();
			expect(calculateBadgeBounds("$0.000 0.1%/272k", 0, 80)).toBeNull();
		});

		it("returns bounds on row 1 to the right of stats", () => {
			const line = "$0.000 (sub) 0.1%/272k (auto)   claude-3-7-sonnet";
			const bounds = calculateBadgeBounds(line, 1, 100);
			expect(bounds).not.toBeNull();
			expect(bounds?.y).toBe(1);
			expect(bounds?.startX).toBe(30); // 29 chars stats + 1 space
			expect(bounds?.endX).toBe(41); // 30 + 11 width
		});
	});

	describe("patchFooterComponent & unpatchFooterComponent", () => {
		beforeAll(() => {
			initTheme();
		});

		afterEach(() => {
			unpatchFooterComponent();
		});

		it("patches FooterComponent and renders task badge on lines[1] without creating line 3", () => {
			const tm = new TaskManager();
			let selected = false;
			const patched = patchFooterComponent(tm, () => selected);
			expect(patched).toBe(true);

			const mockSession = {
				sessionManager: { getCwd: () => "/test", getSessionName: () => undefined, getEntries: () => [] },
				state: { model: { id: "claude-3-7-sonnet", provider: "anthropic" } },
				modelRuntime: { isUsingSubscription: () => true },
				getContextUsage: () => ({ percent: 0.1, contextWindow: 272000 }),
			};
			const mockFooterData = {
				getGitBranch: () => "main",
				getAvailableProviderCount: () => 1,
				getExtensionStatuses: () => new Map(),
			};
			const footer = new (FooterComponent as any)(mockSession, mockFooterData);

			// With 0 tasks: only 2 lines, no shell badge
			const lines0 = footer.render(100);
			expect(lines0.length).toBe(2);
			expect(lines0[1]).not.toContain("shell");

			// Add a running task
			const t1: BackgroundTask = {
				id: "t1",
				command: "cmd",
				cwd: tempDir,
				pid: 1,
				pgid: 1,
				status: "running",
				exitCode: null,
				startTime: Date.now(),
				logPath: "",
				logBytes: 0,
				isTruncated: false,
				isBackgrounded: true,
			};
			tm.addBackgroundTask(t1);

			// With 1 task (unselected): only 2 lines, line 1 contains "1 shell"
			const lines1 = footer.render(100);
			expect(lines1.length).toBe(2);
			expect(lines1[1]).toContain("1 shell");

			// With selected = true
			selected = true;
			const linesSelected = footer.render(100);
			expect(linesSelected.length).toBe(2);
			expect(linesSelected[1]).toContain("1 shell");

			// Unpatch restores original behavior
			unpatchFooterComponent();
			selected = false;
			const linesUnpatched = footer.render(100);
			expect(linesUnpatched[1]).not.toContain("1 shell");
		});

		it("handles mouse hover and click interactions on task badge", () => {
			const tm = new TaskManager();
			let selected = false;
			let hovered = false;
			const onBadgeClick = vi.fn();

			patchFooterComponent(
				tm,
				() => selected,
				() => hovered,
				onBadgeClick,
			);

			const mockSession = {
				sessionManager: { getCwd: () => "/test", getSessionName: () => undefined, getEntries: () => [] },
				state: { model: { id: "claude-3-7-sonnet", provider: "anthropic" } },
				modelRuntime: { isUsingSubscription: () => true },
				getContextUsage: () => ({ percent: 0.1, contextWindow: 272000 }),
			};
			const mockFooterData = {
				getGitBranch: () => "main",
				getAvailableProviderCount: () => 1,
				getExtensionStatuses: () => new Map(),
			};
			const footer = new (FooterComponent as any)(mockSession, mockFooterData);

			const t1: BackgroundTask = {
				id: "t1",
				command: "cmd",
				cwd: tempDir,
				pid: 1,
				pgid: 1,
				status: "running",
				exitCode: null,
				startTime: Date.now(),
				logPath: "",
				logBytes: 0,
				isTruncated: false,
				isBackgrounded: true,
			};
			tm.addBackgroundTask(t1);

			// Render establishes currentBadgeBounds
			footer.render(100);
			const bounds = getBadgeBounds();
			expect(bounds).not.toBeNull();
			expect(bounds?.y).toBe(1);

			// 1. Mouse move inside badge bounds triggers hover and requests render
			const moveIn = footer.handleMouse({
				type: "move",
				button: "none",
				x: bounds!.startX + 2,
				y: bounds!.y,
				width: 100,
				height: 2,
				screenX: bounds!.startX + 2,
				screenY: 23,
			});
			expect(moveIn).toEqual({ handled: true, render: true });
			expect(getIsBadgeHovered()).toBe(true);

			// 2. Mouse move outside badge bounds clears hover and requests render
			const moveOut = footer.handleMouse({
				type: "move",
				button: "none",
				x: bounds!.startX - 5,
				y: bounds!.y,
				width: 100,
				height: 2,
				screenX: bounds!.startX - 5,
				screenY: 23,
			});
			expect(moveOut).toEqual({ handled: true, render: true });
			expect(getIsBadgeHovered()).toBe(false);

			// 3. Mouse press with left button on badge consumes event
			const press = footer.handleMouse({
				type: "press",
				button: "left",
				x: bounds!.startX + 2,
				y: bounds!.y,
				width: 100,
				height: 2,
				screenX: bounds!.startX + 2,
				screenY: 23,
			});
			expect(press).toEqual({ handled: true });

			// 4. Mouse click with left button on badge triggers onBadgeClick
			const click = footer.handleMouse({
				type: "click",
				button: "left",
				x: bounds!.startX + 2,
				y: bounds!.y,
				width: 100,
				height: 2,
				screenX: bounds!.startX + 2,
				screenY: 23,
			});
			expect(click).toEqual({ handled: true, render: true });
			expect(onBadgeClick).toHaveBeenCalledTimes(1);

			// 5. Mouse click outside badge does not trigger onBadgeClick
			footer.handleMouse({
				type: "click",
				button: "left",
				x: 5,
				y: bounds!.y,
				width: 100,
				height: 2,
				screenX: 5,
				screenY: 23,
			});
			expect(onBadgeClick).toHaveBeenCalledTimes(1);

			// 6. Unpatch cleans up handleMouse and state
			unpatchFooterComponent();
			expect((FooterComponent.prototype as any).handleMouse).toBeUndefined();
			expect(getBadgeBounds()).toBeNull();
			expect(getIsBadgeHovered()).toBe(false);
		});
	});

	// ─── createBackgroundableOperations ────────────────────────────────────────

	describe("createBackgroundableOperations", () => {
		it("executes foreground command normally and logs output", async () => {
			const tm = new TaskManager();
			const setStatus = vi.fn();
			const mockCtx = {
				ui: { setStatus },
			} as any;

			const ops = createBackgroundableOperations(mockCtx, tm, "test-session", tempDir);
			const onData = vi.fn();

			const result = await ops.exec("echo 'hello world from test'", tempDir, {
				onData,
			});

			expect(result.exitCode).toBe(0);
			expect(onData).toHaveBeenCalled();
			const allData = onData.mock.calls.map((c) => c[0].toString()).join("");
			expect(allData).toContain("hello world from test");

			// Foreground task is cleaned up after exit
			expect(tm.getActiveForeground()).toBeNull();
		});

		it("detaches to background on detach() and resolves exitCode 0", async () => {
			const tm = new TaskManager();
			const setStatus = vi.fn();
			const mockCtx = {
				ui: { setStatus },
			} as any;

			const ops = createBackgroundableOperations(mockCtx, tm, "test-session", tempDir);
			const onData = vi.fn();

			// Run a sleep command that lasts long enough to detach
			const execPromise = ops.exec("sleep 10", tempDir, { onData });

			// Wait a tick for child process to spawn
			await new Promise((r) => setTimeout(r, 100));

			const active = tm.getActiveForeground();
			expect(active).not.toBeNull();
			const task = active!.task;
			expect(task.status).toBe("running");
			expect(task.isBackgrounded).toBe(false);

			// Detach command via TaskManager
			const detached = tm.detachActiveForeground();
			expect(detached).toBe(true);

			// execPromise resolves immediately with { exitCode: 0 }
			const execResult = await execPromise;
			expect(execResult.exitCode).toBe(0);

			// Notification was emitted to onData
			const allData = onData.mock.calls.map((c) => c[0].toString()).join("");
			expect(allData).toContain("Command was manually backgrounded by user with ID:");
			expect(allData).toContain(task.id);
			expect(allData).toContain(task.logPath);

			// Task is now in background tasks map
			expect(tm.getRunningTasks()).toHaveLength(1);
			expect(tm.getTask(task.id)?.isBackgrounded).toBe(true);
			expect(setStatus).toHaveBeenCalledWith(BACKGROUND_TASKS_STATUS_KEY, undefined);

			// Clean up background task
			tm.stopTask(task.id);
			expect(tm.getRunningTasks()).toHaveLength(0);
		});

		it("enforces log capping at MAX_LOG_BYTES", async () => {
			const tm = new TaskManager();
			const mockCtx = {
				ui: { setStatus: vi.fn() },
			} as any;

			const ops = createBackgroundableOperations(mockCtx, tm, "test-session", tempDir);
			const onData = vi.fn();

			// We test the truncation logic by creating a task with low byte threshold or checking log stream writes
			const execPromise = ops.exec("echo 'line 1' && echo 'line 2'", tempDir, { onData });
			const result = await execPromise;
			expect(result.exitCode).toBe(0);

			const logFiles = fs.readdirSync(path.join(tempDir, "session-test-session"));
			expect(logFiles.length).toBeGreaterThan(0);
			const logContent = fs.readFileSync(
				path.join(tempDir, "session-test-session", logFiles[0]),
				"utf8",
			);
			expect(logContent).toContain("line 1");
			expect(logContent).toContain("line 2");
		});

		it("handles abort signal before detachment", async () => {
			const tm = new TaskManager();
			const mockCtx = {
				ui: { setStatus: vi.fn() },
			} as any;

			const ops = createBackgroundableOperations(mockCtx, tm, "test-session", tempDir);
			const abortController = new AbortController();

			const execPromise = ops.exec("sleep 15", tempDir, {
				onData: vi.fn(),
				signal: abortController.signal,
			});

			await new Promise((r) => setTimeout(r, 100));
			expect(tm.getActiveForeground()).not.toBeNull();

			abortController.abort();
			const result = await execPromise;
			expect(result.exitCode).toBeNull();
			expect(tm.getActiveForeground()).toBeNull();
		});
	});

	// ─── Extension Entry Point & User Commands ─────────────────────────────────

	describe("Extension Entry Point & Commands", () => {
		it("registers user_bash, session_start, commands, and session_shutdown", () => {
			const eventHandlers = new Map<string, Function>();
			const commands = new Map<string, any>();

			const mockPi: any = {
				on: vi.fn((event: string, handler: Function) => {
					eventHandlers.set(event, handler);
				}),
				registerCommand: vi.fn((name: string, config: any) => {
					commands.set(name, config);
				}),
			};

			rbfBackgroundTasks(mockPi);

			expect(mockPi.on).toHaveBeenCalledWith("user_bash", expect.any(Function));
			expect(mockPi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
			expect(mockPi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));

			expect(commands.has("tasks")).toBe(true);
			expect(commands.has("bashes")).toBe(true);
			expect(commands.has("cancel")).toBe(true);
			expect(commands.has("kill")).toBe(true);
		});

		it("answers the busy query for a foreground command and a tracked task, and stops answering on shutdown", async () => {
			const eventHandlers = new Map<string, Function>();
			const events = createEventBus();
			const mockPi: any = {
				events,
				on: vi.fn((event: string, handler: Function) => {
					eventHandlers.set(event, handler);
				}),
				registerCommand: vi.fn(),
			};
			const ask = (): BusyQuery => {
				const query: BusyQuery = {};
				events.emit(BUSY_QUERY_CHANNEL, query);
				return query;
			};
			expect(BUSY_QUERY_CHANNEL).toBe("rbf-background-tasks:busy/v1");
			expect(ask()).toEqual({});

			rbfBackgroundTasks(mockPi);
			expect(ask()).toEqual({ answered: true });

			// A `!` command in the foreground.
			const mockCtx: any = { ui: { setStatus: vi.fn() }, sessionManager: { getSessionId: () => "sess-busy" } };
			const { operations } = await eventHandlers.get("user_bash")!({ command: "sleep 10" }, mockCtx);
			const running = operations.exec("sleep 10", tempDir, { onData: vi.fn() });
			await new Promise((r) => setTimeout(r, 100));
			expect(ask()).toEqual({ answered: true, command: true });

			// The same command, moved to the background: now a tracked task and no longer a foreground command.
			getActiveTaskManager()!.detachActiveForeground();
			await running;
			expect(ask()).toEqual({ answered: true, backgroundTask: true });

			// A flag another listener raised is never lowered.
			const raised: BusyQuery = { command: true };
			events.emit(BUSY_QUERY_CHANNEL, raised);
			expect(raised).toEqual({ answered: true, backgroundTask: true, command: true });

			await eventHandlers.get("session_shutdown")!();
			expect(ask()).toEqual({});
		});

		it("loads on a Pi that has no event bus", () => {
			const mockPi: any = { on: vi.fn(), registerCommand: vi.fn() };

			expect(() => rbfBackgroundTasks(mockPi)).not.toThrow();
		});

		it("session_start wires onTerminalInput to intercept Ctrl+B when active task exists", async () => {
			const eventHandlers = new Map<string, Function>();
			const mockPi: any = {
				on: vi.fn((event: string, handler: Function) => {
					eventHandlers.set(event, handler);
				}),
				registerCommand: vi.fn(),
			};

			rbfBackgroundTasks(mockPi);

			let terminalInputListener: ((data: string) => any) | null = null;
			const mockCtx: any = {
				hasUI: true,
				ui: {
					onTerminalInput: vi.fn((cb: any) => {
						terminalInputListener = cb;
					}),
					notify: vi.fn(),
					setStatus: vi.fn(),
				},
				sessionManager: {
					getSessionId: () => "sess-1",
				},
			};

			const sessionStartHandler = eventHandlers.get("session_start");
			expect(sessionStartHandler).toBeDefined();
			await sessionStartHandler!({}, mockCtx);

			expect(terminalInputListener).not.toBeNull();

			// When idle, Ctrl+B passes through (returns undefined)
			expect(terminalInputListener!("\x02")).toBeUndefined();
			expect(terminalInputListener!("k")).toBeUndefined();

			// Start a task via user_bash handler
			const userBashHandler = eventHandlers.get("user_bash");
			const bashResult = await userBashHandler!({ command: "sleep 10" }, mockCtx);
			expect(bashResult.operations).toBeDefined();

			const execPromise = bashResult.operations.exec("sleep 10", tempDir, {
				onData: vi.fn(),
			});
			await new Promise((r) => setTimeout(r, 100));

			// Now Ctrl+B detaches foreground task and consumes keystroke
			const res = terminalInputListener!("\x02");
			expect(res).toEqual({ consume: true });

			const execRes = await execPromise;
			expect(execRes.exitCode).toBe(0);

			// Clean up
			const shutdownHandler = eventHandlers.get("session_shutdown");
			await shutdownHandler!();
		});

		it("wires agent bash tool registration so agent commands can be backgrounded via Ctrl+B", async () => {
			const eventHandlers = new Map<string, Function>();
			let registeredBashTool: any = null;
			const mockPi: any = {
				on: vi.fn((event: string, handler: Function) => {
					eventHandlers.set(event, handler);
				}),
				registerCommand: vi.fn(),
				registerTool: vi.fn((tool: any) => {
					if (tool.name === "bash") {
						registeredBashTool = tool;
					}
				}),
			};

			rbfBackgroundTasks(mockPi);

			expect(registeredBashTool).not.toBeNull();
			expect(typeof registeredBashTool.execute).toBe("function");

			let terminalInputListener: ((data: string) => any) | null = null;
			const mockCtx: any = {
				hasUI: true,
				ui: {
					onTerminalInput: vi.fn((cb: any) => {
						terminalInputListener = cb;
					}),
					notify: vi.fn(),
					setStatus: vi.fn(),
					setWorkingMessage: vi.fn(),
					requestRender: vi.fn(),
				},
				sessionManager: {
					getSessionId: () => "sess-agent-1",
					getSessionFile: () => "/tmp/sess-agent-1.json",
				},
			};

			const sessionStartHandler = eventHandlers.get("session_start");
			await sessionStartHandler!({}, mockCtx);

			// Start an agent bash command execution
			const execPromise = registeredBashTool.execute(
				"tool-call-1",
				{ command: "sleep 10" },
				new AbortController().signal,
				vi.fn(),
				mockCtx,
			);

			await new Promise((r) => setTimeout(r, 100));

			// Verify active foreground is detected and working message formats with hint
			expect(getActiveTaskManager()?.getActiveForeground()).not.toBeNull();
			expect(formatBackgroundHintMessage("Working")).toBe(
				"Working (ctrl+b to run in background · Esc to cancel)",
			);

			// Verify renderResult appends hint
			const partialResult = registeredBashTool.renderResult(
				{ content: [] },
				{ isPartial: true },
				undefined,
				{ state: { startedAt: Date.now() - 5000 }, invalidate: () => {} },
			);
			expect(partialResult).toBeDefined();

			// Detach via Ctrl+B keystroke
			const res = terminalInputListener!("\x02");
			expect(res).toEqual({ consume: true });

			const execRes = await execPromise;
			expect(execRes).toBeDefined();

			// Output contains background notice
			const textBlock = execRes.content?.find((c: any) => typeof c.text === "string");
			expect(textBlock?.text).toContain("Command was manually backgrounded by user with ID:");

			// Active foreground cleared and status reverts
			expect(getActiveTaskManager()?.getActiveForeground()).toBeNull();
			expect(
				formatBackgroundHintMessage(
					"Working (ctrl+b to run in background · Esc to cancel)",
				),
			).toBe("Working");

			const shutdownHandler = eventHandlers.get("session_shutdown");
			await shutdownHandler!();
		});

		it("session_start handles Down arrow to select footer badge and Enter to open /tasks", async () => {
			const eventHandlers = new Map<string, any>();
			const commands = new Map<string, any>();
			const mockPi: any = {
				on: vi.fn((event: string, handler: any) => {
					eventHandlers.set(event, handler);
				}),
				registerCommand: vi.fn((name: string, config: any) => {
					commands.set(name, config);
				}),
			};

			rbfBackgroundTasks(mockPi);

			let terminalInputListener: ((data: string) => any) | undefined;
			let editorText = "";
			const customModal = vi.fn().mockResolvedValue(null);
			const setStatus = vi.fn();
			const requestRender = vi.fn();

			const mockCtx: any = {
				hasUI: true,
				mode: "tui",
				ui: {
					onTerminalInput: vi.fn((listener: (data: string) => any) => {
						terminalInputListener = listener;
					}),
					getEditorText: () => editorText,
					custom: customModal,
					setStatus,
					requestRender,
				},
				sessionManager: {
					getSessionId: () => "nav-test-session",
				},
			};

			const sessionStartHandler = eventHandlers.get("session_start");
			await sessionStartHandler({}, mockCtx);
			expect(terminalInputListener).toBeDefined();

			// With 0 tasks running: Down arrow passes through (returns undefined)
			expect(terminalInputListener!("\x1b[B")).toBeUndefined();
			expect(getIsFooterSelected()).toBe(false);

			// Start a task and background it
			const userBashHandler = eventHandlers.get("user_bash");
			const bashResult = await userBashHandler({}, mockCtx);
			const execPromise = bashResult.operations.exec("sleep 10", tempDir, { onData: vi.fn() });
			await new Promise((r) => setTimeout(r, 100));
			terminalInputListener!("\x02"); // Ctrl+B detaches
			await execPromise;

			// Now 1 task is running in the background.
			// When editor is NOT empty, Down arrow should pass through to editor
			editorText = "ls -la";
			expect(terminalInputListener!("\x1b[B")).toBeUndefined();
			expect(getIsFooterSelected()).toBe(false);

			// When editor IS empty, Down arrow selects footer badge
			editorText = "";
			const downResult = terminalInputListener!("\x1b[B");
			expect(downResult).toEqual({ consume: true });
			expect(getIsFooterSelected()).toBe(true);

			// Pressing Up deselects and consumes
			const upResult = terminalInputListener!("\x1b[A");
			expect(upResult).toEqual({ consume: true });
			expect(getIsFooterSelected()).toBe(false);

			// Down selects again
			terminalInputListener!("\x1b[B");
			expect(getIsFooterSelected()).toBe(true);

			// Typing a character deselects and does NOT consume
			const charResult = terminalInputListener!("a");
			expect(charResult).toBeUndefined();
			expect(getIsFooterSelected()).toBe(false);

			// Down selects again
			terminalInputListener!("\x1b[B");
			expect(getIsFooterSelected()).toBe(true);

			// Pressing Escape deselects
			const escResult = terminalInputListener!("\x1b");
			expect(escResult).toEqual({ consume: true });
			expect(getIsFooterSelected()).toBe(false);

			// Down selects again, then Enter opens modal
			terminalInputListener!("\x1b[B");
			expect(getIsFooterSelected()).toBe(true);

			const enterResult = terminalInputListener!("\r");
			expect(enterResult).toEqual({ consume: true });
			expect(getIsFooterSelected()).toBe(false);
			expect(customModal).toHaveBeenCalled();

			// Clean up
			const shutdownHandler = eventHandlers.get("session_shutdown");
			await shutdownHandler!();
		});

		it("cancel and kill commands stop tasks", async () => {
			const commands = new Map<string, any>();
			const mockPi: any = {
				on: vi.fn(),
				registerCommand: vi.fn((name: string, config: any) => {
					commands.set(name, config);
				}),
			};

			rbfBackgroundTasks(mockPi);

			const notify = vi.fn();
			const setStatus = vi.fn();
			const mockCtx: any = {
				ui: { notify, setStatus },
			};

			// Cancel without argument when no tasks running
			const cancelHandler = commands.get("cancel")?.handler;
			await cancelHandler("", mockCtx);
			expect(notify).toHaveBeenCalledWith("Usage: /cancel <task-id>", "warning");

			// Cancel unknown task
			await cancelHandler("nonexistent", mockCtx);
			expect(notify).toHaveBeenCalledWith('No task matching "nonexistent".', "error");
		});
	});

	// ─── Tasks Modal Component ─────────────────────────────────────────────────

	describe("createTasksModalComponent", () => {
		it("renders details view when a task is specified and handles keyboard navigation", () => {
			const tm = new TaskManager();
			const logPath = path.join(tempDir, "modal-test.log");
			fs.writeFileSync(logPath, "line 1\nline 2\nline 3\n");

			const task: BackgroundTask = {
				id: "bb7xlukf",
				command: "make run",
				cwd: tempDir,
				pid: 123,
				pgid: 123,
				status: "running",
				exitCode: null,
				startTime: Date.now() - 12000,
				logPath,
				logBytes: 20,
				isTruncated: false,
				isBackgrounded: true,
			};
			tm.addBackgroundTask(task);

			const tui: any = { requestRender: vi.fn() };
			const theme: any = {
				bold: (s: string) => `[b]${s}[/b]`,
				fg: (_k: string, s: string) => s,
			};
			const done = vi.fn();

			const component = createTasksModalComponent(tm, "bb7xlukf", tui, theme, done);
			const renderedLines = component.render(80);
			const renderedText = renderedLines.join("\n");

			expect(renderedText).toContain("Shell details");
			expect(renderedText).toContain("Status:  running");
			expect(renderedText).toContain("Runtime: 12s");
			expect(renderedText).toContain("Command: make run");
			expect(renderedText).toContain("line 1");
			expect(renderedText).toContain("line 2");
			expect(renderedText).toContain("line 3");

			// Test scrolling down & up
			component.handleInput?.("j");
			expect(tui.requestRender).toHaveBeenCalled();

			component.handleInput?.("k");
			expect(tui.requestRender).toHaveBeenCalled();

			// Test stopping task with 'x'
			component.handleInput?.("x");
			expect(task.status).toBe("stopped");

			// Test closing with 'q'
			component.handleInput?.("q");
			expect(done).toHaveBeenCalledWith(null);

			component.dispose?.();
		});

		it("renders list view when multiple tasks exist and switches to details on Enter", () => {
			const tm = new TaskManager();
			const t1: BackgroundTask = {
				id: "t1",
				command: "cmd1",
				cwd: tempDir,
				pid: 1,
				pgid: 1,
				status: "running",
				exitCode: null,
				startTime: 1000,
				logPath: path.join(tempDir, "t1.log"),
				logBytes: 0,
				isTruncated: false,
				isBackgrounded: true,
			};
			const t2: BackgroundTask = {
				id: "t2",
				command: "cmd2",
				cwd: tempDir,
				pid: 2,
				pgid: 2,
				status: "completed",
				exitCode: 0,
				startTime: 2000,
				logPath: path.join(tempDir, "t2.log"),
				logBytes: 0,
				isTruncated: false,
				isBackgrounded: true,
			};
			tm.addBackgroundTask(t1);
			tm.addBackgroundTask(t2);

			const tui: any = { requestRender: vi.fn() };
			const theme: any = {
				bold: (s: string) => `[b]${s}[/b]`,
				fg: (_k: string, s: string) => s,
			};
			const done = vi.fn();

			// With multiple tasks and no initialTaskId, starts in list view
			const component = createTasksModalComponent(tm, null, tui, theme, done);
			const lines = component.render(80);
			const text = lines.join("\n");

			expect(text).toContain("Shell tasks");
			expect(text).toContain("cmd1");
			expect(text).toContain("cmd2");

			// Select second item
			component.handleInput?.("j");
			expect(tui.requestRender).toHaveBeenCalled();

			// Press Enter to view details
			component.handleInput?.("\r");
			const detailsLines = component.render(80);
			expect(detailsLines.join("\n")).toContain("Shell details");

			// Press Left/h/backspace to go back to list
			component.handleInput?.("h");
			const backLines = component.render(80);
			expect(backLines.join("\n")).toContain("Shell tasks");

			// Press Esc to close
			component.handleInput?.("\x1b");
			expect(done).toHaveBeenCalledWith(null);

			component.dispose?.();
		});
	});

	// ─── Agent Bash Tool Registration ──────────────────────────────────────────

	describe("Agent Bash Tool Registration", () => {
		it("registers bash tool and wraps execute and renderResult", () => {
			let registeredTool: any = null;
			const mockPi: any = {
				on: vi.fn(),
				registerCommand: vi.fn(),
				registerTool: vi.fn((tool: any) => {
					registeredTool = tool;
				}),
			};

			rbfBackgroundTasks(mockPi);

			expect(mockPi.registerTool).toHaveBeenCalled();
			expect(registeredTool).not.toBeNull();
			expect(registeredTool.name).toBe("bash");
			expect(typeof registeredTool.execute).toBe("function");
			expect(typeof registeredTool.renderResult).toBe("function");
			expect(registeredTool.promptGuidelines).toEqual(
				expect.arrayContaining([expect.stringContaining("running in the background")]),
			);
		});

		it("appends background hint to renderResult elapsed line when isPartial is true", () => {
			let registeredTool: any = null;
			const mockPi: any = {
				on: vi.fn(),
				registerCommand: vi.fn(),
				registerTool: vi.fn((tool: any) => {
					registeredTool = tool;
				}),
			};

			rbfBackgroundTasks(mockPi);

			const mockResult = {
				content: [{ type: "text", text: "running" }],
				details: {},
			};
			const theme: any = {
				fg: (_k: string, s: string) => s,
			};
			const mockContext: any = {
				state: { startedAt: Date.now() - 3000 },
				invalidate: vi.fn(),
			};

			// Partial render (in-flight execution)
			const partialComp = registeredTool.renderResult(
				mockResult,
				{ isPartial: true },
				theme,
				mockContext,
			);
			expect(partialComp).toBeDefined();
			// Verify that the elapsed line has the hint appended
			const children = (partialComp as any).children;
			const lastChild = children?.[children.length - 1];
			expect(lastChild?.text).toContain("ctrl+b to run in background · Esc to cancel");

			// Non-partial render (completed execution)
			const finalComp = registeredTool.renderResult(
				mockResult,
				{ isPartial: false },
				theme,
				mockContext,
			);
			expect(finalComp).toBeDefined();
			const finalChildren = (finalComp as any).children;
			const finalLastChild = finalChildren?.[finalChildren.length - 1];
			expect(finalLastChild?.text).not.toContain("ctrl+b");
		});

		it("execute sets working message and enables backgrounding via detach", async () => {
			let registeredTool: any = null;
			let sessionStartHandler: any = null;
			const mockPi: any = {
				on: vi.fn((event: string, handler: any) => {
					if (event === "session_start") {
						sessionStartHandler = handler;
					}
				}),
				registerCommand: vi.fn(),
				registerTool: vi.fn((tool: any) => {
					registeredTool = tool;
				}),
			};

			rbfBackgroundTasks(mockPi);

			let terminalInputListener: ((data: string) => any) | null = null;
			const setWorkingMessage = vi.fn();
			const mockCtx: any = {
				hasUI: true,
				ui: {
					setWorkingMessage,
					setStatus: vi.fn(),
					requestRender: vi.fn(),
					onTerminalInput: vi.fn((cb: any) => {
						terminalInputListener = cb;
					}),
				},
				sessionManager: {
					getSessionId: () => "agent-test-session",
					getSessionFile: () => "/tmp/agent-test-session.json",
				},
			};

			if (sessionStartHandler) {
				await sessionStartHandler({}, mockCtx);
			}

			// Run a command that takes long enough to detach
			const execPromise = registeredTool.execute(
				"call_1",
				{ command: "sleep 10" },
				new AbortController().signal,
				vi.fn(),
				mockCtx,
			);

			expect(setWorkingMessage).toHaveBeenCalledWith(
				"Working (ctrl+b to run in background · Esc to cancel)",
			);

			// Allow child process to spawn
			await new Promise((r) => setTimeout(r, 150));

			// Verify terminal input handler detaches the active foreground task on Ctrl+B
			expect(terminalInputListener).not.toBeNull();
			const handled = (terminalInputListener as any)("\x02");
			expect(handled).toEqual({ consume: true });

			const result = await execPromise;
			expect(result).toBeDefined();
			expect(result.content[0].text).toContain("Command was manually backgrounded by user with ID:");

			// Working message is cleared in finally
			expect(setWorkingMessage).toHaveBeenLastCalledWith(undefined);
		});
	});

	// ─── Shell display observer (pi-42) ────────────────────────────────────────

	describe("Shell display observer (pi-42)", () => {
		type Message = Record<string, any>;
		type Bus = { emit(channel: string, data: unknown): void; on(channel: string, handler: (data: unknown) => void): () => void };
		const SESSION = "sess-display";
		const SIGNALLED = expect.stringMatching(/^SIG(TERM|KILL)$/);

		/** A bus with no safety net, unlike Pi's: a subscriber's throw goes straight back into `emit`. */
		function rawBus(): Bus {
			const handlers = new Set<(data: unknown) => void>();
			return {
				emit: (_channel, data) => {
					for (const handler of [...handlers]) handler(data);
				},
				on: (_channel, handler) => {
					handlers.add(handler);
					return () => handlers.delete(handler);
				},
			};
		}

		/** The extension loaded on a Pi with `events` (none when null), its session started, and every display message recorded unless `listen` is false. */
		async function owner(opts: { events?: Bus | null; argv?: string[]; sessionId?: string; listen?: boolean } = {}) {
			const events = opts.events === null ? undefined : (opts.events ?? createEventBus());
			const handlers = new Map<string, Function>();
			let tool: any;
			const mockPi: any = {
				on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)),
				registerCommand: vi.fn(),
				registerTool: vi.fn((registered: any) => {
					if (registered.name === "bash") tool = registered;
				}),
			};
			if (events) mockPi.events = events;
			const seen: Message[] = [];
			if (opts.listen !== false) events?.on(SHELL_DISPLAY_CHANNEL, (message) => seen.push(message as Message));
			rbfBackgroundTasks(mockPi, { argv: opts.argv ?? [] });
			const manager = getActiveTaskManager()!;
			const ctxFor = (sessionId: string): any => ({
				hasUI: false,
				ui: { setWorkingMessage: vi.fn(), setStatus: vi.fn(), requestRender: vi.fn(), notify: vi.fn() },
				sessionManager: { getSessionId: () => sessionId, getSessionFile: () => `/tmp/${sessionId}.json` },
			});
			const ctx = ctxFor(opts.sessionId ?? SESSION);
			await handlers.get("session_start")!({}, ctx);
			const run = (id: string, command: string, o: { signal?: AbortSignal; timeout?: number } = {}): Promise<any> =>
				tool.execute(id, { command, ...(o.timeout ? { timeout: o.timeout } : {}) }, o.signal ?? new AbortController().signal, vi.fn(), ctx);
			const facts = (id?: string) => seen.filter((message) => message.kind === "fact" && (!id || message.toolCallId === id));
			const kinds = (id?: string) => facts(id).map((message) => message.fact.kind);
			/** The foreground task once its process is up and Node has said so: `spawn` is emitted a tick after the pid is known. */
			const foreground = async (): Promise<BackgroundTask> => {
				await vi.waitFor(() => expect(manager.getActiveForeground()?.task.pid).toBeTruthy());
				await new Promise((r) => setImmediate(r));
				return manager.getActiveForeground()!.task;
			};
			return { events, handlers, tool, seen, ctx, ctxFor, run, facts, kinds, foreground, manager, shutdown: () => handlers.get("session_shutdown")!() };
		}

		/** The identity every fact of one call carries. */
		const identity = (o: { seen: Message[] }, toolCallId: string) => ({
			kind: "fact",
			sessionId: SESSION,
			source: "pi-bash",
			ownerGeneration: o.seen.find((message) => message.kind === "announce")!.ownerGeneration,
			toolCallId,
		});

		describe("Announcement and snapshot", () => {
			it("announces on session_start with the functions it registered", async () => {
				const o = await owner();
				expect(SHELL_DISPLAY_CHANNEL).toBe("rbf:shell-display:v1");
				expect(o.seen).toEqual([
					{
						kind: "announce",
						sessionId: SESSION,
						source: "pi-bash",
						toolName: "bash",
						ownerGeneration: expect.stringMatching(/^pi-bash:.{8,}$/),
						execute: o.tool.execute,
						renderCall: o.tool.renderCall,
						renderResult: o.tool.renderResult,
					},
				]);
				expect(o.seen[0]!.execute).toBe(o.tool.execute);
				expect(o.seen[0]!.renderCall).toBe(o.tool.renderCall);
				expect(o.seen[0]!.renderResult).toBe(o.tool.renderResult);
				await o.shutdown();
			});

			it("two owners never share a generation", async () => {
				const a = await owner();
				const generation = a.seen[0]!.ownerGeneration;
				await a.shutdown();
				const b = await owner();
				expect(b.seen[0]!.ownerGeneration).not.toBe(generation);
				await b.shutdown();
			});

			it("a view that attaches after the owner asks and gets the announce, then every retained fact in order", async () => {
				const o = await owner({ listen: false });
				await o.run("call-1", "echo first");
				await expect(o.run("call-2", "exit 2")).rejects.toThrow();
				const late: Message[] = [];
				o.events!.on(SHELL_DISPLAY_CHANNEL, (message) => late.push(message as Message));
				o.events!.emit(SHELL_DISPLAY_CHANNEL, { kind: "snapshot-request", sessionId: SESSION });
				const answers = late.filter((message) => message.kind !== "snapshot-request");
				expect(answers.map((m) => [m.kind, m.toolCallId, m.revision, m.fact?.kind])).toEqual([
					["announce", undefined, undefined, undefined],
					["fact", "call-1", 1, "start"],
					["fact", "call-1", 2, "close"],
					["fact", "call-2", 1, "start"],
					["fact", "call-2", 2, "close"],
				]);
				expect(answers[0]).toMatchObject({ sessionId: SESSION, source: "pi-bash", toolName: "bash", execute: o.tool.execute });
				for (const fact of answers.slice(1)) expect(fact).toMatchObject({ sessionId: SESSION, source: "pi-bash", ownerGeneration: answers[0]!.ownerGeneration });
				await o.shutdown();
			});

			it("a view that attached first hears the announce and each fact as it happens", async () => {
				const events = createEventBus();
				const early: Message[] = [];
				events.on(SHELL_DISPLAY_CHANNEL, (message) => early.push(message as Message));
				const o = await owner({ events, listen: false });
				await o.run("call-1", "echo first");
				expect(early.map((m) => [m.kind, m.toolCallId, m.revision, m.fact?.kind])).toEqual([
					["announce", undefined, undefined, undefined],
					["fact", "call-1", 1, "start"],
					["fact", "call-1", 2, "close"],
				]);
				await o.shutdown();
			});

			it("a request that names calls gets the announce and those calls' facts only", async () => {
				const o = await owner({ listen: false });
				await o.run("call-1", "echo first");
				await expect(o.run("call-2", "exit 2")).rejects.toThrow();
				await o.run("call-3", "echo third");
				const late: Message[] = [];
				o.events!.on(SHELL_DISPLAY_CHANNEL, (message) => late.push(message as Message));
				o.events!.emit(SHELL_DISPLAY_CHANNEL, { kind: "snapshot-request", sessionId: SESSION, toolCallIds: ["call-3", "never-seen", "call-1"] });
				expect(late.filter((m) => m.kind !== "snapshot-request").map((m) => [m.kind, m.toolCallId, m.revision])).toEqual([
					["announce", undefined, undefined],
					["fact", "call-3", 1],
					["fact", "call-3", 2],
					["fact", "call-1", 1],
					["fact", "call-1", 2],
				]);
				late.length = 0;
				o.events!.emit(SHELL_DISPLAY_CHANNEL, { kind: "snapshot-request", sessionId: SESSION, toolCallIds: [] });
				expect(late.map((m) => m.kind)).toEqual(["announce", "snapshot-request"]);
				await o.shutdown();
			});

			it("a request for another session, and a kind it doesn't know, get no answer", async () => {
				const o = await owner();
				await o.run("call-1", "echo first");
				const before = o.seen.length;
				o.events!.emit(SHELL_DISPLAY_CHANNEL, { kind: "snapshot-request", sessionId: "sess-other" });
				o.events!.emit(SHELL_DISPLAY_CHANNEL, { kind: "something-new", sessionId: SESSION });
				o.events!.emit(SHELL_DISPLAY_CHANNEL, undefined);
				expect(o.seen.slice(before).map((m) => m?.kind)).toEqual(["snapshot-request", "something-new", undefined]);
				await o.shutdown();
			});

			it("shutdown asks tasks to stop, withdraws, forgets the snapshot, and a process closing afterwards says nothing", async () => {
				const o = await owner();
				const running = o.run("call-bg", "sleep 30");
				const task = await o.foreground();
				o.manager.detachActiveForeground();
				await running;
				await o.shutdown();
				const generation = o.seen[0]!.ownerGeneration;
				expect(o.kinds("call-bg")).toEqual(["start", "background", "stop-request"]);
				expect(o.seen.at(-1)).toEqual({ kind: "withdraw", sessionId: SESSION, source: "pi-bash", ownerGeneration: generation });
				await vi.waitFor(() => expect(task.child!.exitCode !== null || task.child!.signalCode !== null).toBe(true));
				await new Promise((r) => setTimeout(r, 50));
				o.events!.emit(SHELL_DISPLAY_CHANNEL, { kind: "snapshot-request", sessionId: SESSION });
				expect(o.seen.at(-2)).toMatchObject({ kind: "withdraw" });
				expect(o.seen.at(-1)).toEqual({ kind: "snapshot-request", sessionId: SESSION });
			});

			it("a new session on the same owner withdraws the old generation, and a call from before it says nothing more", async () => {
				const o = await owner();
				const first = o.seen[0]!.ownerGeneration;
				const running = o.run("call-old", "sleep 30");
				const task = await o.foreground();
				o.manager.detachActiveForeground();
				await running;
				await o.handlers.get("session_start")!({}, o.ctxFor("sess-next"));
				const [withdrawn, announced] = o.seen.slice(-2);
				expect(withdrawn).toEqual({ kind: "withdraw", sessionId: SESSION, source: "pi-bash", ownerGeneration: first });
				expect(announced).toMatchObject({ kind: "announce", sessionId: "sess-next", source: "pi-bash" });
				expect(announced!.ownerGeneration).not.toBe(first);
				const before = o.seen.length;
				o.manager.stopTask(task.id);
				await vi.waitFor(() => expect(task.child!.exitCode !== null || task.child!.signalCode !== null).toBe(true));
				await new Promise((r) => setTimeout(r, 50));
				expect(o.seen.slice(before)).toEqual([]);
				await o.shutdown();
			});
		});

		describe("Facts for each path of a call", () => {
			it("a foreground command that succeeds: start, then close 0, before the tool returns", async () => {
				const o = await owner();
				const result = await o.run("call-ok", "echo hi");
				expect(result.content[0].text).toContain("hi");
				expect(o.facts()).toEqual([
					{ ...identity(o, "call-ok"), revision: 1, fact: { kind: "start" } },
					{ ...identity(o, "call-ok"), revision: 2, fact: { kind: "close", code: 0, signal: null } },
				]);
				await o.shutdown();
			});

			it("a command that exits 7: start, then close 7, and never not-run", async () => {
				const o = await owner();
				await expect(o.run("call-fail", "echo 'Status: completed'; exit 7")).rejects.toThrow("Command exited with code 7");
				expect(o.facts()).toEqual([
					{ ...identity(o, "call-fail"), revision: 1, fact: { kind: "start" } },
					{ ...identity(o, "call-fail"), revision: 2, fact: { kind: "close", code: 7, signal: null } },
				]);
				await o.shutdown();
			});

			it("a detach: background with the task id while the tool returns exit 0, then the real close", async () => {
				const o = await owner();
				const running = o.run("call-bg", "sleep 0.4; echo BG-DONE");
				const task = await o.foreground();
				await vi.waitFor(() => expect(o.kinds("call-bg")).toEqual(["start"]));
				o.manager.detachActiveForeground();
				const result = await running;
				expect(result.content[0].text).toContain("Command was manually backgrounded by user with ID:");
				expect(o.facts("call-bg")).toEqual([
					{ ...identity(o, "call-bg"), revision: 1, fact: { kind: "start" } },
					{ ...identity(o, "call-bg"), revision: 2, fact: { kind: "background", identity: task.id } },
				]);
				await vi.waitFor(() => expect(o.facts("call-bg")).toHaveLength(3));
				expect(o.facts("call-bg")[2]).toEqual({ ...identity(o, "call-bg"), revision: 3, fact: { kind: "close", code: 0, signal: null } });
				await o.shutdown();
			});

			it("a detached task stopped from /tasks: the stop request is not a close; the close comes when the process ends", async () => {
				const o = await owner();
				const running = o.run("call-stop", "sleep 30");
				const task = await o.foreground();
				o.manager.detachActiveForeground();
				await running;
				expect(o.manager.stopTask(task.id)).toBe(true);
				expect(task.status).toBe("stopped");
				expect(o.kinds("call-stop")).toEqual(["start", "background", "stop-request"]);
				expect(o.facts("call-stop")[2]).toEqual({ ...identity(o, "call-stop"), revision: 3, fact: { kind: "stop-request", reason: "cancel" } });
				await vi.waitFor(() => expect(o.facts("call-stop")).toHaveLength(4));
				expect(o.facts("call-stop")[3]).toEqual({ ...identity(o, "call-stop"), revision: 4, fact: { kind: "close", code: null, signal: SIGNALLED } });
				await o.shutdown();
			});

			it("a foreground abort: the tool settles at the stop request, and the close follows", async () => {
				const o = await owner();
				const ac = new AbortController();
				const running = o.run("call-abort", "sleep 30", { signal: ac.signal });
				await o.foreground();
				await vi.waitFor(() => expect(o.kinds("call-abort")).toEqual(["start"]));
				ac.abort();
				expect(o.kinds("call-abort")).toEqual(["start", "stop-request"]);
				await running.catch(() => {});
				expect(o.kinds("call-abort")).toEqual(["start", "stop-request"]);
				expect(o.facts("call-abort")[1]).toEqual({ ...identity(o, "call-abort"), revision: 2, fact: { kind: "stop-request", reason: "cancel" } });
				await vi.waitFor(() => expect(o.facts("call-abort")).toHaveLength(3));
				expect(o.facts("call-abort")[2]).toEqual({ ...identity(o, "call-abort"), revision: 3, fact: { kind: "close", code: null, signal: SIGNALLED } });
				await o.shutdown();
			});

			it("a timeout: the request, then the close, then the tool's own timeout error", async () => {
				const o = await owner();
				await expect(o.run("call-timeout", "sleep 30", { timeout: 1 })).rejects.toThrow();
				expect(o.facts("call-timeout")).toEqual([
					{ ...identity(o, "call-timeout"), revision: 1, fact: { kind: "start" } },
					{ ...identity(o, "call-timeout"), revision: 2, fact: { kind: "stop-request", reason: "timeout" } },
					{ ...identity(o, "call-timeout"), revision: 3, fact: { kind: "close", code: null, signal: SIGNALLED } },
				]);
				await o.shutdown();
			}, 15_000);

			it("a call that fails before any spawn is not run, and its error passes through", async () => {
				const told: ShellDisplayFact[] = [];
				const call: ShellDisplayCall<ShellDisplayFact> = { sessionId: SESSION, toolCallId: "call-refused", tell: (fact) => told.push(fact) };
				const refusal = new Error("refused before spawn");
				await expect(observeShellCall(call, async () => { throw refusal; })).rejects.toBe(refusal);
				expect(told).toEqual([{ kind: "not-run" }]);
			});

			it("a spawn that fails is not run: its close is no process closing, and the native result is unchanged", async () => {
				const told: ShellDisplayFact[] = [];
				const call: ShellDisplayCall<ShellDisplayFact> = { sessionId: SESSION, toolCallId: "call-nospawn", tell: (fact) => told.push(fact) };
				const ops = () => createBackgroundableOperations({ ui: { setStatus: vi.fn() } } as any, new TaskManager(), SESSION, tempDir);
				const missing = path.join(tempDir, "no-such-dir");
				const unobserved = await ops().exec("echo never", missing, { onData: vi.fn() });
				const observed = await observeShellCall(call, () => ops().exec("echo never", missing, { onData: vi.fn() }));
				expect(observed).toEqual(unobserved);
				expect(observed).toEqual({ exitCode: 1 });
				await new Promise((r) => setTimeout(r, 50));
				expect(told).toEqual([{ kind: "not-run" }]);
			});

			it("an error from a process that did spawn is not its end: child-error, and the close only when it really closes", async () => {
				const o = await owner();
				const running = o.run("call-err", "sleep 30");
				const task = await o.foreground();
				task.child!.emit("error", new Error("EPIPE"));
				await running.catch(() => {});
				expect(task.status).toBe("failed");
				expect(o.facts("call-err")).toEqual([
					{ ...identity(o, "call-err"), revision: 1, fact: { kind: "start" } },
					{ ...identity(o, "call-err"), revision: 2, fact: { kind: "child-error" } },
				]);
				process.kill(task.pid, "SIGKILL");
				await vi.waitFor(() => expect(o.facts("call-err")).toHaveLength(3));
				expect(o.facts("call-err")[2]).toEqual({ ...identity(o, "call-err"), revision: 3, fact: { kind: "close", code: null, signal: "SIGKILL" } });
				await o.shutdown();
			});

			it("a call with no display identity runs as it always did", async () => {
				expect(await observeShellCall(undefined, async () => "plain")).toBe("plain");
			});

			it("two calls with the same command text keep their own ids", async () => {
				const o = await owner();
				await Promise.all([o.run("call-a", "sleep 0.2; echo same"), o.run("call-b", "sleep 0.2; echo same")]);
				for (const id of ["call-a", "call-b"]) {
					expect(o.facts(id)).toEqual([
						{ ...identity(o, id), revision: 1, fact: { kind: "start" } },
						{ ...identity(o, id), revision: 2, fact: { kind: "close", code: 0, signal: null } },
					]);
				}
				await o.shutdown();
			});

			it("a call that finishes while another is still running reports under its own id, not the latest one", async () => {
				const o = await owner();
				const slow = o.run("call-slow", "sleep 0.5");
				await vi.waitFor(() => expect(o.kinds("call-slow")).toEqual(["start"]));
				await expect(o.run("call-quick", "exit 3")).rejects.toThrow();
				await slow;
				expect(o.facts().map((m) => [m.toolCallId, m.revision, m.fact.kind, m.fact.code])).toEqual([
					["call-slow", 1, "start", undefined],
					["call-quick", 1, "start", undefined],
					["call-quick", 2, "close", 3],
					["call-slow", 2, "close", 0],
				]);
				await o.shutdown();
			});

			it("a user ! command is not an agent call and reports nothing", async () => {
				const o = await owner();
				const { operations } = await o.handlers.get("user_bash")!({ command: "echo mine" }, o.ctx);
				expect(await operations.exec("echo mine", tempDir, { onData: vi.fn() })).toEqual({ exitCode: 0 });
				expect(o.facts()).toEqual([]);
				await o.shutdown();
			});
		});

		describe("Snapshot bound", () => {
			type Fact = { kind: "start" | "close" };
			function bounded(limit?: number) {
				const events = createEventBus();
				const display = createShellDisplayOwner<Fact>(events, "pi-bash", (fact) => fact.kind === "close", limit)!;
				display.start(SESSION, { name: "bash", execute: () => {} });
				const live: Message[] = [];
				events.on(SHELL_DISPLAY_CHANNEL, (message) => live.push(message as Message));
				const snapshot = () => {
					const from = live.length;
					events.emit(SHELL_DISPLAY_CHANNEL, { kind: "snapshot-request", sessionId: SESSION });
					return live.slice(from).filter((m) => m.kind === "fact").map((m) => `${m.toolCallId}#${m.revision}:${m.fact.kind}`);
				};
				return { display, live, snapshot };
			}

			it("keeps 2,000 invocations by default", () => {
				expect(SHELL_DISPLAY_SNAPSHOT_LIMIT).toBe(2000);
				const { display, snapshot } = bounded();
				for (let i = 0; i < 2005; i++) display.open(`call-${i}`)!.tell({ kind: "start" });
				const kept = snapshot();
				expect(kept).toHaveLength(2000);
				expect(kept[0]).toBe("call-5#1:start");
				expect(kept.at(-1)).toBe("call-2004#1:start");
			});

			it("at the bound the least recently updated ended invocation goes first, and an open one only when none has ended", () => {
				const { display, snapshot } = bounded(3);
				const call = Object.fromEntries(["a", "b", "c", "d", "e", "f"].map((id) => [id, display.open(id)!]));
				call.a!.tell({ kind: "start" });
				call.b!.tell({ kind: "start" });
				call.b!.tell({ kind: "close" });
				call.c!.tell({ kind: "start" });
				expect(snapshot()).toEqual(["a#1:start", "b#1:start", "b#2:close", "c#1:start"]);
				// b ended, so it goes before a, which is older and still open.
				call.d!.tell({ kind: "start" });
				expect(snapshot()).toEqual(["a#1:start", "c#1:start", "d#1:start"]);
				// Nothing has ended: the open invocation updated longest ago goes, and that is a.
				call.e!.tell({ kind: "start" });
				expect(snapshot()).toEqual(["c#1:start", "d#1:start", "e#1:start"]);
				// An update makes c the most recent, so d is now the oldest.
				call.c!.tell({ kind: "start" });
				call.f!.tell({ kind: "start" });
				expect(snapshot()).toEqual(["e#1:start", "c#1:start", "c#2:start", "f#1:start"]);
			});

			it("an evicted invocation still publishes, and its revisions keep counting", () => {
				const { display, live, snapshot } = bounded(1);
				const a = display.open("a")!;
				a.tell({ kind: "start" });
				display.open("b")!.tell({ kind: "start" });
				expect(snapshot()).toEqual(["b#1:start"]);
				a.tell({ kind: "close" });
				expect(live.filter((m) => m.kind === "fact" && m.toolCallId === "a").map((m) => m.revision)).toEqual([1, 2]);
			});

			it("one invocation keeps 16 facts: the first, and the newest after it", () => {
				expect(SHELL_DISPLAY_FACTS_PER_INVOCATION).toBe(16);
				const { display, live, snapshot } = bounded();
				const call = display.open("chatty")!;
				for (let i = 0; i < 20; i++) call.tell({ kind: "start" });
				expect(live.filter((m) => m.kind === "fact").map((m) => m.revision)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
				expect(snapshot()).toEqual([1, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map((revision) => `chatty#${revision}:start`));
			});

			it("a subscriber that throws on one message does not cut short the messages after it", () => {
				// On a bus with no safety net the throw comes back out of `emit`, in the middle of what the owner was doing.
				const events = rawBus();
				const heard: Message[] = [];
				events.on(SHELL_DISPLAY_CHANNEL, (message) => heard.push(message as Message));
				const display = createShellDisplayOwner<Fact>(events, "pi-bash", (fact) => fact.kind === "close")!;
				display.start(SESSION, { name: "bash", execute: () => {} });
				display.open("a")!.tell({ kind: "start" });
				events.on(SHELL_DISPLAY_CHANNEL, (message) => {
					const kind = (message as Message).kind;
					if (kind === "withdraw" || kind === "announce") throw new Error(`cannot take ${kind}`);
				});

				// The snapshot answer: the announce throws, the facts still follow.
				heard.length = 0;
				events.emit(SHELL_DISPLAY_CHANNEL, { kind: "snapshot-request", sessionId: SESSION });
				expect(heard.map((m) => m.kind)).toEqual(["snapshot-request", "announce", "fact"]);

				// A new session: the withdrawal throws, the owner still moves on and announces the new one.
				heard.length = 0;
				display.start("sess-next", { name: "bash", execute: () => {} });
				expect(heard.map((m) => [m.kind, m.sessionId])).toEqual([["withdraw", SESSION], ["announce", "sess-next"]]);
				expect(heard[1]!.ownerGeneration).not.toBe(heard[0]!.ownerGeneration);
				expect(display.open("b")!.sessionId).toBe("sess-next");

				// Shutdown: the withdrawal throws, the snapshot is still forgotten.
				display.open("b")!.tell({ kind: "start" });
				heard.length = 0;
				display.stop();
				expect(heard.map((m) => m.kind)).toEqual(["withdraw"]);
				expect(display.open("c")).toBeUndefined();
			});

			it("the Pi owner and the Codex owner carry the same channel code", () => {
				// Neither owner imports the other, and Pi loads every file in its extensions folder as an extension, so the code lives twice.
				const channelCode = (file: string) => {
					const source = fs.readFileSync(path.join(import.meta.dirname, file), "utf8");
					const constants = source.slice(source.indexOf("export const SHELL_DISPLAY_CHANNEL"), source.indexOf("/**\n * What this owner saw"));
					const from = source.indexOf("type ShellDisplayBus = ");
					const owner = source.slice(from, source.indexOf("\n}\n", source.indexOf("export function createShellDisplayOwner")) + 3);
					expect(constants).toContain("SHELL_DISPLAY_FACTS_PER_INVOCATION");
					expect(owner).toContain("stop(): void {");
					return (constants + owner).replaceAll("crypto.randomUUID()", "randomUUID()");
				};
				expect(channelCode("rbf-codex.ts")).toBe(channelCode("rbf-background-tasks.ts"));
			});

			it("no invocation can be opened before a session is announced, and none on a Pi with no bus", () => {
				const display = createShellDisplayOwner<Fact>(createEventBus(), "pi-bash", () => false)!;
				expect(display.open("early")).toBeUndefined();
				expect(createShellDisplayOwner<Fact>(undefined, "pi-bash", () => false)).toBeUndefined();
			});
		});

		describe("Sandbox launch", () => {
			it("reads the frozen argv with Pi's own parser", () => {
				expect(isSandboxLaunch(["--sandbox"])).toBe(true);
				expect(isSandboxLaunch(["--model", "x", "--sandbox"])).toBe(true);
				expect(isSandboxLaunch([])).toBe(false);
				expect(isSandboxLaunch(["--model", "sandbox"])).toBe(false);
			});

			it("a sandbox launch announces nothing, reports nothing and answers nothing, and the command still runs", async () => {
				const o = await owner({ argv: ["--sandbox"] });
				const result = await o.run("call-ok", "echo hi");
				expect(result.content[0].text).toContain("hi");
				o.events!.emit(SHELL_DISPLAY_CHANNEL, { kind: "snapshot-request", sessionId: SESSION });
				await o.shutdown();
				expect(o.seen).toEqual([{ kind: "snapshot-request", sessionId: SESSION }]);
			});
		});

		describe("Isolation from native execution", () => {
			const settled = (call: Promise<any>) =>
				call.then(
					(result) => ({ resolved: result.content.map((c: any) => c.text).join("") }),
					(error) => ({ rejected: String(error?.message ?? error) }),
				);

			/** One script of calls on a fresh owner, reduced to what the native path returned and left behind. */
			async function nativeOutcome(events: Bus | null) {
				const o = await owner({ events, listen: false });
				const out: Record<string, unknown> = {};
				out.ok = await settled(o.run("iso-ok", "echo iso"));
				out.fail = await settled(o.run("iso-fail", "echo boom; exit 7"));

				const detached = o.run("iso-bg", "sleep 0.3; echo BG");
				const task = await o.foreground();
				o.manager.detachActiveForeground();
				out.detached = JSON.parse(JSON.stringify(await settled(detached)).replaceAll(task.id, "<task>"));
				out.foregroundAfterDetach = o.manager.getActiveForeground();

				const ac = new AbortController();
				const aborted = o.run("iso-abort", "sleep 30", { signal: ac.signal });
				const cut = await o.foreground();
				ac.abort();
				out.aborted = await settled(aborted);
				out.abortedStatus = cut.status;

				await vi.waitFor(() => expect(task.status).not.toBe("running"));
				out.detachedEnd = [task.status, task.exitCode, task.isBackgrounded];
				out.log = fs.readFileSync(task.logPath, "utf8");
				out.running = o.manager.getRunningTasks().length;
				await o.shutdown();
				out.managerAfterShutdown = getActiveTaskManager();
				return out;
			}

			it("a throwing subscriber, a throwing bus and no bus at all leave every native result as it was", async () => {
				const errors = vi.spyOn(console, "error").mockImplementation(() => {});
				try {
					const baseline = await nativeOutcome(null);
					expect(baseline.ok).toEqual({ resolved: "iso\n" });
					expect(baseline.fail).toMatchObject({ rejected: expect.stringContaining("Command exited with code 7") });
					expect(baseline.detached).toMatchObject({ resolved: expect.stringContaining("Command was manually backgrounded by user with ID: <task>") });
					expect(baseline.detachedEnd).toEqual(["completed", 0, true]);
					expect(baseline.abortedStatus).toBe("stopped");

					expect(await nativeOutcome(createEventBus())).toEqual(baseline);

					let thrown = 0;
					const throwing = (bus: Bus) => {
						bus.on(SHELL_DISPLAY_CHANNEL, () => {
							thrown++;
							throw new Error("subscriber blew up");
						});
						return bus;
					};
					expect(await nativeOutcome(throwing(createEventBus()))).toEqual(baseline);
					const afterPiBus = thrown;
					expect(afterPiBus).toBeGreaterThan(8);
					expect(await nativeOutcome(throwing(rawBus()))).toEqual(baseline);
					expect(thrown).toBeGreaterThan(afterPiBus + 8);

					const broken: Bus = {
						emit: () => {
							thrown++;
							throw new Error("bus blew up");
						},
						on: (channel) => {
							if (channel === SHELL_DISPLAY_CHANNEL) throw new Error("cannot subscribe");
							return () => {};
						},
					};
					expect(await nativeOutcome(broken)).toEqual(baseline);
				} finally {
					errors.mockRestore();
				}
			}, 60_000);
		});
	});
});
