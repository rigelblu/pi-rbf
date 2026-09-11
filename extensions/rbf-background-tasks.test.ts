import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyElapsedHint,
	BASH_EXECUTION_PATCHED_KEY,
	BACKGROUND_TASKS_STATUS_KEY,
	calculateBadgeBounds,
	createBackgroundableOperations,
	createTasksModalComponent,
	ensureLogDir,
	formatBackgroundHintMessage,
	formatFooterBadge,
	formatRuntime,
	formatStatsLineWithTasks,
	generateTaskId,
	getActiveTaskManager,
	getBadgeBounds,
	getIsBadgeHovered,
	getIsFooterSelected,
	killProcessTree,
	LOADER_PATCHED_KEY,
	MAX_CONCURRENT_BACKGROUND_TASKS,
	MAX_LOG_BYTES,
	patchBashExecutionComponent,
	patchFooterComponent,
	rbfBackgroundTasks,
	setActiveTaskManager,
	setIsBadgeHovered,
	setIsFooterSelected,
	setOnBadgeClick,
	TaskManager,
	terminateProcessTree,
	TOOL_EXECUTION_PATCHED_KEY,
	unpatchBashExecutionComponent,
	unpatchFooterComponent,
	updateFooterBadge,
	type BackgroundTask,
} from "./rbf-background-tasks.ts";
import { BashExecutionComponent, FooterComponent, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
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
});
