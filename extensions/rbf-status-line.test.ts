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
		invalidateStatusLineCache();
	});

	afterEach(() => {
		unpatchFooterComponent();
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
