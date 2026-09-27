import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	FooterComponent,
	initTheme,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import rbfStatusLine, {
	formatFooterLineWithRightSide,
	formatStatusLine,
	getCachedStatusLine,
	invalidateStatusLineCache,
	patchFooterComponent,
	resolveAgentTree,
	resolveJjWorkspace,
	resolveStatusLineComponents,
	setCachedStatusLine,
	STATUS_LINE_PATCHED_KEY,
	unpatchFooterComponent,
} from "./rbf-status-line.ts";
import {
	patchFooterComponent as patchTasksFooter,
	unpatchFooterComponent as unpatchTasksFooter,
	TaskManager,
	type BackgroundTask,
} from "./rbf-background-tasks.ts";
import {
	patchFooterComponent as patchTodosFooter,
	unpatchFooterComponent as unpatchTodosFooter,
	TodoManager,
} from "./rbf-todos.ts";

const FOOTER_PI_RBF_REGISTRY_KEY = Symbol.for("@earendil-works/pi-rbf:footer-registry");

describe("rbf-status-line pure formatting helpers", () => {
	it("formats minimal directory only", () => {
		const line = formatStatusLine({ dirName: "pi-rbf" });
		expect(line).toBe("📁 pi-rbf");
	});

	it("formats directory with repository name", () => {
		const line = formatStatusLine({ dirName: "pi-rbf", repoName: "pi-rbf" });
		expect(line).toBe("📁 pi-rbf | 📦 pi-rbf");
	});

	it("formats directory, repo, and default workspace", () => {
		const line = formatStatusLine({
			dirName: "pi-rbf",
			repoName: "pi-rbf",
			treeLabel: " main",
		});
		expect(line).toBe("📁 pi-rbf | 📦 pi-rbf |  main");
	});

	it("formats worktree with wt: prefix and optional stale indicator", () => {
		const cleanLine = formatStatusLine({
			dirName: "feature-branch",
			repoName: "pi-rbf",
			treeLabel: " wt:feature-x",
		});
		expect(cleanLine).toBe("📁 feature-branch | 📦 pi-rbf |  wt:feature-x");

		const staleLine = formatStatusLine({
			dirName: "feature-branch",
			repoName: "pi-rbf",
			treeLabel: " wt:feature-x ⚠stale",
		});
		expect(staleLine).toBe("📁 feature-branch | 📦 pi-rbf |  wt:feature-x ⚠stale");
	});

	it("formats agent divergence tree", () => {
		const line = formatStatusLine({
			dirName: "pi-rbf",
			repoName: "pi-rbf",
			treeLabel: " main",
			agentTree: "🌴 .claude",
		});
		expect(line).toBe("📁 pi-rbf | 📦 pi-rbf |  main | 🌴 .claude");
	});

	it("formats nearest bookmark and commit", () => {
		const line = formatStatusLine({
			dirName: "pi-rbf",
			repoName: "pi-rbf",
			treeLabel: " main",
			branch: "feat-status",
			commit: "mm",
		});
		expect(line).toBe("📁 pi-rbf | 📦 pi-rbf |  main | 🏷️  feat-status @mm");
	});

	it("formats commit without branch matching Claude Code status line", () => {
		const line = formatStatusLine({
			dirName: "pi-rbf",
			repoName: "pi-rbf",
			treeLabel: " main",
			agentTree: "🌴 .claude",
			commit: "mm",
		});
		expect(line).toBe("📁 pi-rbf | 📦 pi-rbf |  main | 🌴 .claude @mm");
	});

	it("preserves session name at the end when provided", () => {
		const line = formatStatusLine({
			dirName: "pi-rbf",
			repoName: "pi-rbf",
			treeLabel: " main",
			agentTree: "🌴 .claude",
			commit: "mm",
			sessionName: "statusline-impl",
		});
		expect(line).toBe("📁 pi-rbf | 📦 pi-rbf |  main | 🌴 .claude @mm • statusline-impl");
	});
});

describe("resolveJjWorkspace", () => {
	const sampleWsList = `
default: . rtnrrppz a0e423c5 feat (ux) | see cache guardian
worktree-1: /tmp/wt1 abcdef12 34567890 other commit
`.trim();

	it("resolves default workspace when current @ change_id matches", () => {
		const info = resolveJjWorkspace(
			sampleWsList,
			"rtnrrppzqyrqpzslwmrrsmnpkkprposm",
		);
		expect(info).toEqual({ wsName: "default", stale: false });
	});

	it("resolves secondary workspace by change_id prefix", () => {
		const info = resolveJjWorkspace(
			sampleWsList,
			"abcdef1234567890abcdef1234567890",
		);
		expect(info).toEqual({ wsName: "worktree-1", stale: false });
	});

	it("detects stale flag from log output when change_id fails", () => {
		const info = resolveJjWorkspace(
			sampleWsList,
			"",
			"Error: Working copy is stale. Run 'jj workspace update-stale'.",
		);
		expect(info?.stale).toBe(true);
	});

	it("falls back to workspace root basename when multi-workspace prefix misses", () => {
		const info = resolveJjWorkspace(
			sampleWsList,
			"nonmatchingchangeid",
			null,
			"/Volumes/tom-ssd/src/worktree-2",
		);
		expect(info?.wsName).toBe("worktree-2");
	});

	it("returns null for empty workspace list", () => {
		expect(resolveJjWorkspace(null, null)).toBeNull();
		expect(resolveJjWorkspace("", null)).toBeNull();
	});
});

describe("resolveAgentTree", () => {
	let testDir: string;
	let statePath: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `pi-rbf-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
		statePath = join(testDir, "agent_tree.state");
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("returns null when state file does not exist", () => {
		expect(resolveAgentTree(join(testDir, "nonexistent.state"), "/some/root")).toBeNull();
	});

	it("returns null when state file is empty or malformed", () => {
		writeFileSync(statePath, "", "utf-8");
		expect(resolveAgentTree(statePath, "/some/root")).toBeNull();

		writeFileSync(statePath, "not enough parts\n", "utf-8");
		expect(resolveAgentTree(statePath, "/some/root")).toBeNull();
	});

	it("returns tree when agent wrote to different root within 30 minutes", () => {
		const now = Math.floor(Date.now() / 1000);
		writeFileSync(statePath, `.claude\t/Users/tomhosiawa/.claude\t${now - 100}\n`, "utf-8");

		const tree = resolveAgentTree(statePath, "/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf", now);
		expect(tree).toBe("🌴 .claude");
	});

	it("returns null when agent timestamp is older than 30 minutes (1800s)", () => {
		const now = Math.floor(Date.now() / 1000);
		writeFileSync(statePath, `.claude\t/Users/tomhosiawa/.claude\t${now - 1801}\n`, "utf-8");

		const tree = resolveAgentTree(statePath, "/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf", now);
		expect(tree).toBeNull();
	});

	it("returns null when agent wrote to the current workspace root (no divergence)", () => {
		const now = Math.floor(Date.now() / 1000);
		const currentRoot = "/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf";
		writeFileSync(statePath, `pi-rbf\t${currentRoot}\t${now - 60}\n`, "utf-8");

		const tree = resolveAgentTree(statePath, currentRoot, now);
		expect(tree).toBeNull();
	});

	it("returns null when agent wrote to rb-drive store (ignored divergence)", () => {
		const now = Math.floor(Date.now() / 1000);
		writeFileSync(
			statePath,
			`rb-drive\t/Volumes/tom-ssd/src/rb/rb-drive/pi-rbf-drive/rb-drive\t${now - 60}\n`,
			"utf-8",
		);

		const tree = resolveAgentTree(statePath, "/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf", now);
		expect(tree).toBeNull();
	});
});

describe("resolveStatusLineComponents with mocked commands", () => {
	it("resolves jj repository components correctly", () => {
		const mockExec = vi.fn((cmd: string) => {
			if (cmd === "jj root") return "/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf";
			if (cmd === "jj workspace root") return "/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf";
			if (cmd === "jj workspace list --no-pager") return "default: . rtnrrppz a0e423c5 feat";
			if (cmd.includes("change_id'")) return "rtnrrppzqyrqpzslwmrrsmnpkkprposm";
			if (cmd.includes("bookmarks()")) return "";
			if (cmd.includes("change_id.shortest()")) return "mm";
			return null;
		});

		const components = resolveStatusLineComponents("/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf", {
			exec: mockExec,
			agentStatePath: "/nonexistent/agent_tree.state",
			sessionName: "my-session",
		});

		expect(components.dirName).toBe("pi-rbf");
		expect(components.repoName).toBe("pi-rbf");
		expect(components.treeLabel).toBe(" main");
		expect(components.agentTree).toBeUndefined();
		expect(components.branch).toBeUndefined();
		expect(components.commit).toBe("mm");
		expect(components.sessionName).toBe("my-session");

		const formatted = formatStatusLine(components);
		expect(formatted).toBe("📁 pi-rbf | 📦 pi-rbf |  main @mm • my-session");
	});

	it("resolves git repository when jj is not present", () => {
		const mockExec = vi.fn((cmd: string) => {
			if (cmd.startsWith("jj")) return null;
			if (cmd === "git rev-parse --show-toplevel") return "/home/user/my-project";
			if (cmd === "git rev-parse --absolute-git-dir") return "/home/user/my-project/.git";
			if (cmd === "git rev-parse --git-common-dir") return ".git";
			if (cmd === "git branch --show-current") return "main";
			if (cmd === "git rev-parse --short HEAD") return "abc1234";
			return null;
		});

		const components = resolveStatusLineComponents("/home/user/my-project/src", {
			exec: mockExec,
			agentStatePath: "/nonexistent/agent_tree.state",
		});

		expect(components.dirName).toBe("src");
		expect(components.repoName).toBe("my-project");
		expect(components.treeLabel).toBe(" main");
		expect(components.branch).toBe("main");
		expect(components.commit).toBe("abc1234");

		const formatted = formatStatusLine(components);
		expect(formatted).toBe("📁 src | 📦 my-project |  main | 🏷️  main @abc1234");
	});

	it("resolves non-repository directory gracefully", () => {
		const mockExec = vi.fn(() => null);

		const components = resolveStatusLineComponents("/tmp/random-dir", {
			exec: mockExec,
			agentStatePath: "/nonexistent/agent_tree.state",
		});

		expect(components.dirName).toBe("random-dir");
		expect(components.repoName).toBeUndefined();
		expect(components.treeLabel).toBeUndefined();

		const formatted = formatStatusLine(components);
		expect(formatted).toBe("📁 random-dir");
	});
});

describe("formatFooterLineWithRightSide", () => {
	const theme = {
		fg: (_color: string, text: string) => text,
	};

	it("right-aligns content when there is enough space", () => {
		const left = "📁 pi-rbf | 📦 pi-rbf |  main @mm";
		const right = "5m TTL [█████] 25k cached";
		const width = 80;

		const result = formatFooterLineWithRightSide(left, right, width, theme);
		expect(result.startsWith(left)).toBe(true);
		expect(result.endsWith(right)).toBe(true);
		expect(result.length).toBe(width);
	});

	it("truncates left side if space is constrained", () => {
		const left = "📁 pi-rbf | 📦 pi-rbf |  main | 🌴 .claude | 🏷️  very-long-feature-branch @mm";
		const right = "5m TTL [█████] 25k cached";
		const width = 50;

		const result = formatFooterLineWithRightSide(left, right, width, theme);
		expect(result.endsWith(right)).toBe(true);
		expect(result.includes("...")).toBe(true);
	});

	it("returns right content only if terminal is very narrow", () => {
		const left = "📁 pi-rbf";
		const right = "5m TTL [█████] 25k cached";
		const width = 26;

		const result = formatFooterLineWithRightSide(left, right, width, theme);
		expect(result).toBe(right);
	});

	it("truncates left when right content is empty", () => {
		const left = "📁 a-very-long-directory-name-that-does-not-fit-at-all";
		const width = 15;

		const result = formatFooterLineWithRightSide(left, "", width, theme);
		expect(visibleWidth(result)).toBeLessThanOrEqual(width);
		expect(result.includes("...")).toBe(true);
	});
});

describe("FooterComponent patching and caching", () => {
	beforeEach(() => {
		initTheme();
		unpatchFooterComponent();
		unpatchTasksFooter();
		unpatchTodosFooter();
		invalidateStatusLineCache();
	});

	afterEach(() => {
		unpatchFooterComponent();
		unpatchTasksFooter();
		unpatchTodosFooter();
		invalidateStatusLineCache();
	});

	function createMockFooter() {
		return {
			session: {
				sessionManager: {
					getCwd: () => "/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf",
					getSessionName: () => undefined,
					getEntries: () => [],
				},
				state: {
					model: { id: "gpt-5.6-luna", provider: "openai-codex" },
				},
				modelRuntime: {
					isUsingSubscription: () => false,
				},
				getContextUsage: () => ({ percent: 5, contextWindow: 200000 }),
			},
			footerData: {
				getGitBranch: () => "main",
				getAvailableProviderCount: () => 1,
				getExtensionStatuses: () => new Map(),
			},
			autoCompactEnabled: true,
		};
	}

	it("patches FooterComponent and replaces lines[0]", () => {
		const patched = patchFooterComponent();
		expect(patched).toBe(true);
		expect((FooterComponent.prototype as any)[STATUS_LINE_PATCHED_KEY]).toBe(true);

		// Seed cache so no real exec runs
		setCachedStatusLine({
			cwd: "/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf",
			line: "📁 pi-rbf | 📦 pi-rbf |  main @mm",
			timestamp: Date.now(),
		});

		const mockFooter = createMockFooter();
		const lines = FooterComponent.prototype.render.call(mockFooter as any, 100);

		expect(lines.length).toBeGreaterThanOrEqual(2);
		expect(lines[0]).toContain("📁 pi-rbf | 📦 pi-rbf |  main @mm");
	});

	it("preserves cache on repeated renders within TTL", () => {
		patchFooterComponent();

		const seeded = {
			cwd: "/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf",
			line: "📁 pi-rbf | 📦 pi-rbf |  main @mm",
			timestamp: Date.now(),
		};
		setCachedStatusLine(seeded);

		const mockFooter = createMockFooter();
		FooterComponent.prototype.render.call(mockFooter as any, 100);

		expect(getCachedStatusLine()?.line).toBe(seeded.line);
		expect(getCachedStatusLine()?.timestamp).toBe(seeded.timestamp);
	});

	it("integrates with cache guardian getter when present on prototype", () => {
		patchFooterComponent();

		(FooterComponent.prototype as any)[Symbol.for("rbf.cacheGuardian.getActiveContent")] = vi.fn(
			() => "5m TTL [█████] 25k cached",
		);

		setCachedStatusLine({
			cwd: "/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf",
			line: "📁 pi-rbf | 📦 pi-rbf |  main @mm",
			timestamp: Date.now(),
		});

		const mockFooter = createMockFooter();
		const lines = FooterComponent.prototype.render.call(mockFooter as any, 120);

		expect(lines[0]).toContain("📁 pi-rbf | 📦 pi-rbf |  main @mm");
		expect(lines[0]).toContain("5m TTL [█████] 25k cached");

		delete (FooterComponent.prototype as any)[Symbol.for("rbf.cacheGuardian.getActiveContent")];
	});

	it("unpatches cleanly restoring original render method", () => {
		patchFooterComponent();
		expect((FooterComponent.prototype as any)[STATUS_LINE_PATCHED_KEY]).toBe(true);

		unpatchFooterComponent();
		expect((FooterComponent.prototype as any)[STATUS_LINE_PATCHED_KEY]).toBeUndefined();
	});

	it("pi-17.2: survives session_shutdown hook teardown in badge-first order", () => {
		const tm = new TaskManager();
		const todoMgr = new TodoManager();

		// Badge-first order: tasks, todos, then status-line
		patchTasksFooter(tm);
		patchTodosFooter(todoMgr);
		patchFooterComponent();

		setCachedStatusLine({
			cwd: "/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf",
			line: "📁 pi-rbf | 📦 pi-rbf |  main @mm",
			timestamp: Date.now(),
		});

		const mockFooter = createMockFooter();
		let lines = FooterComponent.prototype.render.call(mockFooter as any, 100);
		expect(lines[0]).toContain("📁 pi-rbf | 📦 pi-rbf |  main @mm");

		// Simulate session_shutdown in both extensions
		unpatchTasksFooter();
		unpatchTodosFooter();

		// Render again after session shutdown
		lines = FooterComponent.prototype.render.call(mockFooter as any, 100);
		expect(lines[0]).toContain("📁 pi-rbf | 📦 pi-rbf |  main @mm");
	});

	it("pi-17.2: survives teardown in opposite order (status-line first)", () => {
		const tm = new TaskManager();
		const todoMgr = new TodoManager();

		// Status-line first, then tasks and todos
		patchFooterComponent();
		patchTasksFooter(tm);
		patchTodosFooter(todoMgr);

		setCachedStatusLine({
			cwd: "/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf",
			line: "📁 pi-rbf | 📦 pi-rbf |  main @mm",
			timestamp: Date.now(),
		});

		const mockFooter = createMockFooter();
		let lines = FooterComponent.prototype.render.call(mockFooter as any, 100);
		expect(lines[0]).toContain("📁 pi-rbf | 📦 pi-rbf |  main @mm");

		unpatchTasksFooter();
		unpatchTodosFooter();

		lines = FooterComponent.prototype.render.call(mockFooter as any, 100);
		expect(lines[0]).toContain("📁 pi-rbf | 📦 pi-rbf |  main @mm");
		expect(lines[1]).not.toContain("shell");
		expect(lines[1]).not.toContain("📋");
	});

	it("pi-17.2: preserves outer wrapper when cache guardian wraps render", () => {
		const tm = new TaskManager();
		const todoMgr = new TodoManager();

		patchTasksFooter(tm);
		patchTodosFooter(todoMgr);
		patchFooterComponent();

		// Simulate cache guardian wrapping outer render
		const beforeGuardianRender = FooterComponent.prototype.render;
		let guardianCalled = false;
		FooterComponent.prototype.render = function (this: any, width: number): string[] {
			guardianCalled = true;
			return beforeGuardianRender.call(this, width);
		};

		setCachedStatusLine({
			cwd: "/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf",
			line: "📁 pi-rbf | 📦 pi-rbf |  main @mm",
			timestamp: Date.now(),
		});

		// Teardown tasks and todos
		unpatchTasksFooter();
		unpatchTodosFooter();

		const mockFooter = createMockFooter();
		const lines = FooterComponent.prototype.render.call(mockFooter as any, 100);

		expect(guardianCalled).toBe(true);
		expect(lines[0]).toContain("📁 pi-rbf | 📦 pi-rbf |  main @mm");
	});

	it("pi-17.2: rebinds to same registry object and displays fresh session badges", () => {
		const tm1 = new TaskManager();
		const todoMgr1 = new TodoManager();

		patchTasksFooter(tm1);
		patchTodosFooter(todoMgr1);
		patchFooterComponent();

		const registryBefore = (FooterComponent.prototype as any)[FOOTER_PI_RBF_REGISTRY_KEY];
		expect(registryBefore).toBeDefined();
		expect(registryBefore.hooks.size).toBe(2);

		// Session shutdown
		unpatchTasksFooter();
		unpatchTodosFooter();

		expect((FooterComponent.prototype as any)[FOOTER_PI_RBF_REGISTRY_KEY]).toBe(registryBefore);
		expect(registryBefore.hooks.size).toBe(0);

		// New session rebind
		const tm2 = new TaskManager();
		const todoMgr2 = new TodoManager();
		patchTasksFooter(tm2);
		patchTodosFooter(todoMgr2);

		expect((FooterComponent.prototype as any)[FOOTER_PI_RBF_REGISTRY_KEY]).toBe(registryBefore);
		expect(registryBefore.hooks.size).toBe(2);

		// Add task & todo to new session
		const t1: BackgroundTask = {
			id: "t1",
			command: "build",
			cwd: "/test",
			pid: 1234,
			pgid: 1234,
			status: "running",
			exitCode: null,
			startTime: Date.now(),
			logPath: "",
			logBytes: 0,
			isTruncated: false,
			isBackgrounded: true,
		};
		tm2.addBackgroundTask(t1);
		todoMgr2.add("Investigate issue");

		setCachedStatusLine({
			cwd: "/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf",
			line: "📁 pi-rbf | 📦 pi-rbf |  main @mm",
			timestamp: Date.now(),
		});

		const mockFooter = createMockFooter();
		const lines = FooterComponent.prototype.render.call(mockFooter as any, 120);
		expect(lines[0]).toContain("📁 pi-rbf | 📦 pi-rbf |  main @mm");
		expect(lines[1]).toContain("1 shell");
		expect(lines[1]).toContain("📋 0/1");
	});

	it("pi-17.2: does not grow wrapper stack across repeated session switches", () => {
		const tm = new TaskManager();
		const todoMgr = new TodoManager();

		patchTasksFooter(tm);
		patchTodosFooter(todoMgr);
		patchFooterComponent();

		const renderFn = FooterComponent.prototype.render;

		for (let cycle = 0; cycle < 3; cycle++) {
			unpatchTasksFooter();
			unpatchTodosFooter();

			patchTasksFooter(tm);
			patchTodosFooter(todoMgr);

			// Render identity must not change across session switches
			expect(FooterComponent.prototype.render).toBe(renderFn);
		}

		setCachedStatusLine({
			cwd: "/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf",
			line: "📁 pi-rbf | 📦 pi-rbf |  main @mm",
			timestamp: Date.now(),
		});

		const mockFooter = createMockFooter();
		const lines = FooterComponent.prototype.render.call(mockFooter as any, 100);
		expect(lines[0]).toContain("📁 pi-rbf | 📦 pi-rbf |  main @mm");
	});

	it("pi-17.2: restores original render and mouse when no outer wrapper exists", () => {
		// Clean start with NO outer wrapper (status-line unpatched)
		const originalRender = FooterComponent.prototype.render;
		const originalHandleMouse = (FooterComponent.prototype as any).handleMouse;

		const tm = new TaskManager();
		const todoMgr = new TodoManager();

		patchTasksFooter(tm);
		patchTodosFooter(todoMgr);

		expect(FooterComponent.prototype.render).not.toBe(originalRender);
		expect((FooterComponent.prototype as any)[FOOTER_PI_RBF_REGISTRY_KEY]).toBeDefined();

		// Teardown tasks, then todos
		unpatchTasksFooter();
		unpatchTodosFooter();

		// Because no outer wrapper was installed, full cleanup should occur
		expect(FooterComponent.prototype.render).toBe(originalRender);
		expect((FooterComponent.prototype as any).handleMouse).toBe(originalHandleMouse);
		expect((FooterComponent.prototype as any)[FOOTER_PI_RBF_REGISTRY_KEY]).toBeUndefined();
	});

	it("pi-17.2: ensures no stale badge remains on unpatch", () => {
		const tm = new TaskManager();
		const todoMgr = new TodoManager();

		patchTasksFooter(tm);
		patchTodosFooter(todoMgr);
		patchFooterComponent();

		const t1: BackgroundTask = {
			id: "t1",
			command: "run",
			cwd: "/test",
			pid: 5678,
			pgid: 5678,
			status: "running",
			exitCode: null,
			startTime: Date.now(),
			logPath: "",
			logBytes: 0,
			isTruncated: false,
			isBackgrounded: true,
		};
		tm.addBackgroundTask(t1);
		todoMgr.add("Refactor footer");

		setCachedStatusLine({
			cwd: "/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf",
			line: "📁 pi-rbf | 📦 pi-rbf |  main @mm",
			timestamp: Date.now(),
		});

		const mockFooter = createMockFooter();
		let lines = FooterComponent.prototype.render.call(mockFooter as any, 120);
		expect(lines[1]).toContain("1 shell");
		expect(lines[1]).toContain("📋 0/1");

		// Unpatch both
		unpatchTasksFooter();
		unpatchTodosFooter();

		lines = FooterComponent.prototype.render.call(mockFooter as any, 120);
		expect(lines[0]).toContain("📁 pi-rbf | 📦 pi-rbf |  main @mm");
		expect(lines[1]).not.toContain("shell");
		expect(lines[1]).not.toContain("📋");
	});

	it("pi-17.2: survives reverse teardown (tasks-last) with outer status-line wrapper", () => {
		const tm = new TaskManager();
		const todoMgr = new TodoManager();

		// Reverse setup order: todos creates registry first, tasks joins, status-line wraps
		patchTodosFooter(todoMgr);
		patchTasksFooter(tm);
		patchFooterComponent();

		const registry = (FooterComponent.prototype as any)[FOOTER_PI_RBF_REGISTRY_KEY];
		expect(registry).toBeDefined();
		expect(registry.hooks.size).toBe(2);

		const t1: BackgroundTask = {
			id: "t1",
			command: "run-build",
			cwd: "/test",
			pid: 9001,
			pgid: 9001,
			status: "running",
			exitCode: null,
			startTime: Date.now(),
			logPath: "",
			logBytes: 0,
			isTruncated: false,
			isBackgrounded: true,
		};
		tm.addBackgroundTask(t1);
		todoMgr.add("Reverse teardown task");

		setCachedStatusLine({
			cwd: "/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf",
			line: "📁 pi-rbf | 📦 pi-rbf |  main @mm",
			timestamp: Date.now(),
		});

		const mockFooter = createMockFooter();
		let lines = FooterComponent.prototype.render.call(mockFooter as any, 120);
		expect(lines[0]).toContain("📁 pi-rbf | 📦 pi-rbf |  main @mm");
		expect(lines[1]).toContain("1 shell");
		expect(lines[1]).toContain("📋 0/1");

		// Reverse teardown: unpatch todos first, then tasks last
		unpatchTodosFooter();
		expect(registry.hooks.size).toBe(1);
		expect(registry.hooks.has("todos")).toBe(false);
		expect(registry.hooks.has("tasks")).toBe(true);

		// tasks is unpatched last, triggering canRestore check on tasks module
		unpatchTasksFooter();
		expect(registry.hooks.size).toBe(0);

		// Outer status-line wrapper must NOT have been overwritten
		lines = FooterComponent.prototype.render.call(mockFooter as any, 120);
		expect(lines[0]).toContain("📁 pi-rbf | 📦 pi-rbf |  main @mm");
		expect(lines[1]).not.toContain("shell");
		expect(lines[1]).not.toContain("📋");
		// Native metrics row preserved
		expect(lines[1]).toContain("5.0%/200k");

		// Empty registry preserved for subsequent rebind
		expect((FooterComponent.prototype as any)[FOOTER_PI_RBF_REGISTRY_KEY]).toBe(registry);
	});

	it("pi-17.2: restores original render and mouse in reverse teardown (tasks-last) when no outer wrapper exists", () => {
		const originalRender = FooterComponent.prototype.render;
		const originalHandleMouse = (FooterComponent.prototype as any).handleMouse;

		const tm = new TaskManager();
		const todoMgr = new TodoManager();

		// Reverse setup order: todos creates registry, tasks joins, NO outer wrapper
		patchTodosFooter(todoMgr);
		patchTasksFooter(tm);

		expect(FooterComponent.prototype.render).not.toBe(originalRender);
		expect((FooterComponent.prototype as any)[FOOTER_PI_RBF_REGISTRY_KEY]).toBeDefined();

		// Reverse teardown: todos first, tasks last
		unpatchTodosFooter();
		unpatchTasksFooter();

		// Because no outer wrapper was installed, tasks-last unpatch should restore originals and delete registry
		expect(FooterComponent.prototype.render).toBe(originalRender);
		expect((FooterComponent.prototype as any).handleMouse).toBe(originalHandleMouse);
		expect((FooterComponent.prototype as any)[FOOTER_PI_RBF_REGISTRY_KEY]).toBeUndefined();
	});

	it("pi-17.2: legacy registry missing installed identities is safely preserved with outer wrapper (tasks-last teardown)", () => {
		const tm = new TaskManager();
		const todoMgr = new TodoManager();

		patchTodosFooter(todoMgr);
		patchTasksFooter(tm);
		patchFooterComponent();

		// Simulate legacy registry missing installedRender and installedHandleMouse
		const registry = (FooterComponent.prototype as any)[FOOTER_PI_RBF_REGISTRY_KEY];
		delete registry.installedRender;
		delete registry.installedHandleMouse;

		setCachedStatusLine({
			cwd: "/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf",
			line: "📁 pi-rbf | 📦 pi-rbf |  main @mm",
			timestamp: Date.now(),
		});

		// Reverse teardown: todos first, tasks last
		unpatchTodosFooter();
		unpatchTasksFooter();

		// Outer wrapper must not be destroyed
		const mockFooter = createMockFooter();
		const lines = FooterComponent.prototype.render.call(mockFooter as any, 120);
		expect(lines[0]).toContain("📁 pi-rbf | 📦 pi-rbf |  main @mm");
		expect(lines[1]).not.toContain("shell");
		expect(lines[1]).not.toContain("📋");
		expect(lines[1]).toContain("5.0%/200k");

		// Registry conservatively preserved
		expect((FooterComponent.prototype as any)[FOOTER_PI_RBF_REGISTRY_KEY]).toBe(registry);
	});

	it("pi-17.2: legacy registry missing installed identities is safely preserved with outer wrapper (todos-last teardown)", () => {
		const tm = new TaskManager();
		const todoMgr = new TodoManager();

		patchTasksFooter(tm);
		patchTodosFooter(todoMgr);
		patchFooterComponent();

		// Simulate legacy registry missing installedRender and installedHandleMouse
		const registry = (FooterComponent.prototype as any)[FOOTER_PI_RBF_REGISTRY_KEY];
		delete registry.installedRender;
		delete registry.installedHandleMouse;

		setCachedStatusLine({
			cwd: "/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf",
			line: "📁 pi-rbf | 📦 pi-rbf |  main @mm",
			timestamp: Date.now(),
		});

		// Forward teardown: tasks first, todos last
		unpatchTasksFooter();
		unpatchTodosFooter();

		// Outer wrapper must not be destroyed
		const mockFooter = createMockFooter();
		const lines = FooterComponent.prototype.render.call(mockFooter as any, 120);
		expect(lines[0]).toContain("📁 pi-rbf | 📦 pi-rbf |  main @mm");
		expect(lines[1]).not.toContain("shell");
		expect(lines[1]).not.toContain("📋");
		expect(lines[1]).toContain("5.0%/200k");

		// Registry conservatively preserved
		expect((FooterComponent.prototype as any)[FOOTER_PI_RBF_REGISTRY_KEY]).toBe(registry);
	});

	it("pi-17.2: legacy registry missing installed identities is conservatively retained when no outer wrapper exists", () => {
		const tm = new TaskManager();
		const todoMgr = new TodoManager();

		patchTodosFooter(todoMgr);
		patchTasksFooter(tm);

		const registry = (FooterComponent.prototype as any)[FOOTER_PI_RBF_REGISTRY_KEY];
		delete registry.installedRender;
		delete registry.installedHandleMouse;

		// Reverse teardown without outer wrapper
		unpatchTodosFooter();
		unpatchTasksFooter();

		// Because installed identities are absent, canRestore is safely false and retains registry
		expect((FooterComponent.prototype as any)[FOOTER_PI_RBF_REGISTRY_KEY]).toBe(registry);
		expect(registry.hooks.size).toBe(0);
	});

	it("pi-17.2: patch functions are idempotent and do not grow wrapper stack within the same module", () => {
		const tm = new TaskManager();
		const todoMgr = new TodoManager();

		patchTasksFooter(tm);
		patchTodosFooter(todoMgr);
		patchFooterComponent();

		const initialRender = FooterComponent.prototype.render;

		// Calling patch functions repeatedly within the same module is idempotent
		for (let i = 0; i < 5; i++) {
			patchFooterComponent();
			patchTasksFooter(tm);
			patchTodosFooter(todoMgr);

			expect(FooterComponent.prototype.render).toBe(initialRender);
		}

		setCachedStatusLine({
			cwd: "/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf",
			line: "📁 pi-rbf | 📦 pi-rbf |  main @mm",
			timestamp: Date.now(),
		});

		const mockFooter = createMockFooter();
		const lines = FooterComponent.prototype.render.call(mockFooter as any, 120);
		expect(lines[0]).toContain("📁 pi-rbf | 📦 pi-rbf |  main @mm");
		expect(lines.length).toBeGreaterThanOrEqual(2);
	});
});

describe("rbfStatusLine extension lifecycle", () => {
	it("registers lifecycle invalidation handlers", () => {
		const registeredEvents: string[] = [];
		const mockPi: Partial<ExtensionAPI> = {
			on: vi.fn((event: string) => {
				registeredEvents.push(event);
			}) as any,
		};

		rbfStatusLine(mockPi as ExtensionAPI);

		expect(registeredEvents).toContain("session_start");
		expect(registeredEvents).toContain("turn_start");
		expect(registeredEvents).toContain("turn_end");
		expect(registeredEvents).toContain("agent_settled");
		expect(registeredEvents).toContain("user_bash");

		unpatchFooterComponent();
	});

	it("source code contains zero unauthorized sinks or network imports", () => {
		const sourcePath = resolve(__dirname, "rbf-status-line.ts");
		const content = readFileSync(sourcePath, "utf-8");

		expect(content).not.toMatch(/node:net|node:http|fetch/);
		expect(content).not.toMatch(/process\.exit/);
	});
});
