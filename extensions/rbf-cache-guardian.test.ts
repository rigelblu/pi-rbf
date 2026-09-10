import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AgentSettledEvent,
	type AgentStartEvent,
	type BeforeProviderRequestEvent,
	type ExtensionAPI,
	type ExtensionContext,
	FooterComponent,
	initTheme,
	type TurnEndEvent,
	type TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import rbfCacheGuardian, {
	type AfterProviderResponseEvent,
	CRITICAL_THRESHOLD,
	DEFAULT_ANTHROPIC_TTL_MS,
	DEFAULT_CODEX_TTL_MS,
	formatCountdown,
	formatFooterPwdLineWithGuardian,
	formatNotificationTime,
	formatTokens,
	getActiveGuardianState,
	getGuardianThreshold,
	getNextTickDelayMs,
	isSupportedProvider,
	parseTtlValue,
	patchFooterComponent,
	renderGuardianWidgetContent,
	renderProgressBar,
	resolveCacheTtlMs,
	setActiveGuardianState,
	unpatchFooterComponent,
	WARNING_THRESHOLD,
	WIDGET_KEY,
} from "./rbf-cache-guardian.ts";

type AgentMessage = TurnEndEvent["message"];

function createMockTheme() {
	return {
		fg: vi.fn((color: string, text: string) => `[${color}]${text}[/${color}]`),
	};
}

function createMockExtensionContext(options?: {
	provider?: string;
	env?: Record<string, string | undefined>;
	theme?: any;
}) {
	const notifyMock = vi.fn();
	const setWidgetMock = vi.fn();
	const theme = options?.theme ?? createMockTheme();

	const ctx = {
		cwd: "/test",
		hasUI: true,
		mode: "tui",
		model: {
			provider: options?.provider ?? "anthropic",
			id: "claude-3-7-sonnet",
		},
		ui: {
			notify: notifyMock,
			setWidget: setWidgetMock,
			theme,
		},
	} as unknown as ExtensionContext;

	return {
		ctx: ctx as unknown as ExtensionContext,
		notifyMock,
		setWidgetMock,
		theme,
	};
}

function createMockExtensionAPI() {
	const listeners = new Map<string, Array<(...args: any[]) => any>>();
	const registerCommandMock = vi.fn();
	const execMock = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });

	return {
		api: {
			on: (event: string, handler: (...args: any[]) => any) => {
				const existing = listeners.get(event) ?? [];
				existing.push(handler);
				listeners.set(event, existing);
			},
			registerCommand: registerCommandMock,
			exec: execMock,
		} as unknown as ExtensionAPI,
		registerCommandMock,
		execMock,
		emit: async (event: string, ...args: any[]) => {
			const handlers = listeners.get(event) ?? [];
			for (const handler of handlers) {
				await handler(...args);
			}
		},
	};
}

describe("rbfCacheGuardian pure helpers", () => {
	it("formatCountdown formats milliseconds into minute or exact representation", () => {
		// Minute format (default)
		expect(formatCountdown(300_000)).toBe("5m");
		expect(formatCountdown(252_000)).toBe("5m");
		expect(formatCountdown(150_000)).toBe("3m");
		expect(formatCountdown(75_000)).toBe("2m");
		expect(formatCountdown(60_000)).toBe("1m");
		expect(formatCountdown(25_000)).toBe("25s");
		expect(formatCountdown(0)).toBe("0m");
		expect(formatCountdown(-5000)).toBe("0m");

		// Exact format (M:SS)
		expect(formatCountdown(300_000, "exact")).toBe("5:00");
		expect(formatCountdown(252_000, "exact")).toBe("4:12");
		expect(formatCountdown(150_000, "exact")).toBe("2:30");
		expect(formatCountdown(75_000, "exact")).toBe("1:15");
		expect(formatCountdown(25_000, "exact")).toBe("0:25");
		expect(formatCountdown(0, "exact")).toBe("0:00");
	});

	it("getNextTickDelayMs calculates minute intervals and critical/deadline targets", () => {
		// 10m TTL (600k), critical at 60k:
		expect(getNextTickDelayMs(600_000, 600_000, false)).toBe(60_000);
		expect(getNextTickDelayMs(120_000, 600_000, false)).toBe(60_000);
		expect(getNextTickDelayMs(60_000, 600_000, true)).toBe(60_000);
		expect(getNextTickDelayMs(30_000, 600_000, true)).toBe(30_000);
		expect(getNextTickDelayMs(0, 600_000, true)).toBe(0);

		// 5m TTL (300k), critical at 30k:
		// At 75k remaining, critical threshold (30k) arrives in 45k (< 60k): schedules to 30k!
		expect(getNextTickDelayMs(75_000, 300_000, false)).toBe(45_000);
	});

	it("formatFooterPwdLineWithGuardian right-aligns guardian content on footer line 0", () => {
		const theme = createMockTheme();
		const pwdLine = "/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf (detached)";
		const guardian = "10m TTL [█████] 182.6k cached";

		// Wide width (120): right-aligned with padding
		const wide = formatFooterPwdLineWithGuardian(pwdLine, guardian, 120, theme);
		expect(wide.startsWith(pwdLine)).toBe(true);
		expect(wide.endsWith(guardian)).toBe(true);
		expect(wide.length).toBe(120);

		// Narrow width (70): left is truncated with ellipsis while right is preserved
		const narrow = formatFooterPwdLineWithGuardian(pwdLine, guardian, 70, theme);
		expect(narrow.endsWith(guardian)).toBe(true);

		// Empty guardian returns pwdLine untouched
		expect(formatFooterPwdLineWithGuardian(pwdLine, "", 120, theme)).toBe(pwdLine);
	});

	it("patchFooterComponent modifies FooterComponent.prototype.render to include active guardian", () => {
		initTheme();
		patchFooterComponent();
		setActiveGuardianState({
			remainingMs: 600_000,
			totalTtlMs: 600_000,
			tokens: 50_000,
		});

		const mockSession = {
			sessionManager: {
				getCwd: () => "/test/project",
				getEntries: () => [],
				getSessionName: () => undefined,
			},
			state: { model: { id: "test-model", provider: "anthropic" } },
			modelRuntime: {
				isUsingSubscription: () => false,
			},
			getContextUsage: () => ({ percent: 10, contextWindow: 200_000 }),
		};
		const mockFooterData = {
			getGitBranch: () => "main",
			getExtensionStatuses: () => new Map(),
			getAvailableProviderCount: () => 1,
		};
		const footer = new FooterComponent(mockSession as any, mockFooterData as any);
		const lines = footer.render(120);

		expect(lines[0]).toContain("10m TTL [█████] 50.0k cached");
		expect(lines[0]).toContain("/test/project (main)");

		// Clear state
		setActiveGuardianState(null);
		const clearedLines = footer.render(120);
		expect(clearedLines[0]).not.toContain("10m TTL");

		unpatchFooterComponent();
	});

	it("formatTokens formats token counts into k and m representations", () => {
		expect(formatTokens(500)).toBe("500");
		expect(formatTokens(48_200)).toBe("48.2k");
		expect(formatTokens(50_000)).toBe("50.0k");
		expect(formatTokens(182_600)).toBe("182.6k");
		expect(formatTokens(1_200_000)).toBe("1.2m");
		expect(formatTokens(10_500_000)).toBe("10.5m");
	});

	it("renderProgressBar drains from right to left like a battery meter", () => {
		// 100% full (300k/300k)
		expect(renderProgressBar(300_000, 300_000)).toBe("[█████]");
		// 84% full (252k/300k, 4:12) -> 4 pips
		expect(renderProgressBar(252_000, 300_000)).toBe("[████░]");
		// 50% full (150k/300k, 2:30) -> 2 pips
		expect(renderProgressBar(150_000, 300_000)).toBe("[██░░░]");
		// 25% full (75k/300k, 1:15) -> 1 pip
		expect(renderProgressBar(75_000, 300_000)).toBe("[█░░░░]");
		// 8.33% full (25k/300k, 0:25) -> 0 pips
		expect(renderProgressBar(25_000, 300_000)).toBe("[░░░░░]");
		// 0% full (0s remaining)
		expect(renderProgressBar(0, 300_000)).toBe("[░░░░░]");
		// negative / zero total
		expect(renderProgressBar(-1000, 300_000)).toBe("[░░░░░]");
		expect(renderProgressBar(100, 0)).toBe("[░░░░░]");
	});

	it("getGuardianThreshold identifies calm, warning, critical, and elapsed thresholds", () => {
		// Calm: > 30%
		expect(getGuardianThreshold(252_000, 300_000)).toBe("calm");
		expect(getGuardianThreshold(91_000, 300_000)).toBe("calm");

		// Warning: <= 30% and > 10%
		expect(getGuardianThreshold(90_000, 300_000)).toBe("warning");
		expect(getGuardianThreshold(75_000, 300_000)).toBe("warning");
		expect(getGuardianThreshold(31_000, 300_000)).toBe("warning");

		// Critical: <= 10% and > 0
		expect(getGuardianThreshold(30_000, 300_000)).toBe("critical");
		expect(getGuardianThreshold(25_000, 300_000)).toBe("critical");
		expect(getGuardianThreshold(1_000, 300_000)).toBe("critical");

		// Elapsed: <= 0
		expect(getGuardianThreshold(0, 300_000)).toBe("elapsed");
		expect(getGuardianThreshold(-5_000, 300_000)).toBe("elapsed");
	});

	it("parseTtlValue parses duration strings and numeric values correctly", () => {
		expect(parseTtlValue(5)).toBe(300_000); // 5 minutes
		expect(parseTtlValue(10)).toBe(600_000); // 10 minutes
		expect(parseTtlValue(300_000)).toBe(300_000); // ms
		expect(parseTtlValue("5m")).toBe(300_000);
		expect(parseTtlValue("10m")).toBe(600_000);
		expect(parseTtlValue("300s")).toBe(300_000);
		expect(parseTtlValue("600000ms")).toBe(600_000);
		expect(parseTtlValue("1h")).toBe(3_600_000);
		expect(parseTtlValue("invalid")).toBeNull();
		expect(parseTtlValue(undefined)).toBeNull();
	});

	it("formatNotificationTime formats critical alert duration accurately", () => {
		expect(formatNotificationTime(30_000)).toBe("30s");
		expect(formatNotificationTime(60_000)).toBe("60s");
		expect(formatNotificationTime(120_000)).toBe("2m");
	});

	it("resolveCacheTtlMs and isSupportedProvider support Anthropic (5m), Codex (10m), and settings overrides", () => {
		// Defaults
		expect(resolveCacheTtlMs("anthropic", "claude-3-7-sonnet")).toBe(DEFAULT_ANTHROPIC_TTL_MS);
		expect(resolveCacheTtlMs("openai-codex", "gpt-5.6-terra")).toBe(DEFAULT_CODEX_TTL_MS);
		expect(resolveCacheTtlMs("openai", "gpt-4o")).toBe(DEFAULT_CODEX_TTL_MS);
		expect(resolveCacheTtlMs("google", "gemini-2.5-pro")).toBeNull();

		// isSupportedProvider defaults
		expect(isSupportedProvider("anthropic", {})).toBe(true);
		expect(isSupportedProvider("anthropic", { PI_CACHE_RETENTION: "short" })).toBe(true);
		expect(isSupportedProvider("anthropic", { PI_CACHE_RETENTION: "long" })).toBe(false);
		expect(isSupportedProvider("openai-codex", {})).toBe(true);
		expect(isSupportedProvider("openai", {})).toBe(true);
		expect(isSupportedProvider("google", {})).toBe(false);
		expect(isSupportedProvider(undefined, {})).toBe(false);

		// Settings overrides via cacheTtl
		const customSettings = {
			cacheTtl: {
				anthropic: "7m",
				"openai-codex": "15m",
				google: "5m",
				"openai-codex/gpt-5.6-terra": "20m",
			},
		};
		expect(resolveCacheTtlMs("anthropic", "claude-3-7-sonnet", customSettings)).toBe(420_000);
		expect(resolveCacheTtlMs("openai-codex", "gpt-5.6-sol", customSettings)).toBe(900_000);
		expect(resolveCacheTtlMs("openai-codex", "gpt-5.6-terra", customSettings)).toBe(1_200_000);
		expect(resolveCacheTtlMs("google", "gemini-2.5-pro", customSettings)).toBe(300_000);
		expect(isSupportedProvider("google", {}, customSettings)).toBe(true);
	});

	it("renderGuardianWidgetContent renders calm state in muted color", () => {
		const theme = createMockTheme();
		const output = renderGuardianWidgetContent(252_000, 300_000, 182_600, theme);
		expect(theme.fg).toHaveBeenCalledWith("muted", "5m TTL [████░] 182.6k cached");
		expect(output).toBe("[muted]5m TTL [████░] 182.6k cached[/muted]");
	});

	it("renderGuardianWidgetContent renders warning state with warning emoji in yellow", () => {
		const theme = createMockTheme();
		const output = renderGuardianWidgetContent(75_000, 300_000, 182_600, theme);
		expect(theme.fg).toHaveBeenCalledWith("warning", "⚠️ 2m TTL [█░░░░] 182.6k cached");
		expect(output).toBe("[warning]⚠️ 2m TTL [█░░░░] 182.6k cached[/warning]");
	});

	it("renderGuardianWidgetContent renders critical state with siren emoji in error red", () => {
		const theme = createMockTheme();
		const output = renderGuardianWidgetContent(25_000, 300_000, 182_600, theme);
		expect(theme.fg).toHaveBeenCalledWith("error", "🚨 25s TTL [░░░░░] 182.6k cached");
		expect(output).toBe("[error]🚨 25s TTL [░░░░░] 182.6k cached[/error]");
	});

	it("renderGuardianWidgetContent renders elapsed state matching Claude Code styling", () => {
		const theme = createMockTheme();
		const output = renderGuardianWidgetContent(0, 300_000, 182_600, theme);
		expect(theme.fg).toHaveBeenCalledWith("dim", "new task? ");
		expect(theme.fg).toHaveBeenCalledWith("accent", "/clear");
		expect(theme.fg).toHaveBeenCalledWith("dim", " to save ");
		expect(theme.fg).toHaveBeenCalledWith("accent", "182.6k tokens");
		expect(output).toBe("[dim]new task? [/dim][accent]/clear[/accent][dim] to save [/dim][accent]182.6k tokens[/accent]");
	});
});

let mockCurrentTime = 1_000_000;

function setTime(time: number) {
	mockCurrentTime = time;
	if (typeof vi.setSystemTime === "function") {
		vi.setSystemTime(time);
	}
}

function advanceTime(ms: number) {
	mockCurrentTime += ms;
	vi.advanceTimersByTime(ms);
}

describe("rbfCacheGuardian extension lifecycle", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mockCurrentTime = 1_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => mockCurrentTime);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("registers no custom commands and makes no provider background calls", () => {
		const mockAPI = createMockExtensionAPI();
		rbfCacheGuardian(mockAPI.api);
		expect(mockAPI.registerCommandMock).not.toHaveBeenCalled();
	});

	it("activates countdown widget after a successful cache-bearing Anthropic turn", async () => {
		const mockAPI = createMockExtensionAPI();
		rbfCacheGuardian(mockAPI.api);
		const mockCtx = createMockExtensionContext();

		const t0 = 1_000_000;
		setTime(t0);

		await mockAPI.emit("agent_start", {}, mockCtx.ctx);
		await mockAPI.emit("turn_start", { turnIndex: 0, timestamp: t0 });
		await mockAPI.emit("before_provider_request", { payload: {} });

		// Generation takes 48 seconds
		setTime(t0 + 48_000);
		await mockAPI.emit("after_provider_response", { status: 200, headers: {} });

		const assistantMessage = {
			role: "assistant",
			usage: {
				input: 100,
				output: 200,
				cacheRead: 150_000,
				cacheWrite: 32_600,
			},
		} as AgentMessage;

		await mockAPI.emit("turn_end", { turnIndex: 0, message: assistantMessage, toolResults: [] }, mockCtx.ctx);
		await mockAPI.emit("agent_settled", {}, mockCtx.ctx);

		expect(getActiveGuardianState()).toEqual({
			remainingMs: 252_000,
			totalTtlMs: 300_000,
			tokens: 182_600,
		});
		expect(mockCtx.setWidgetMock).toHaveBeenCalledWith(WIDGET_KEY, undefined);
	});

	it("activates 10m countdown widget for openai-codex on turn 1 when input >= 1024 tokens", async () => {
		const mockAPI = createMockExtensionAPI();
		rbfCacheGuardian(mockAPI.api);
		const mockCtx = createMockExtensionContext({ provider: "openai-codex" });

		const t0 = 1_000_000;
		setTime(t0);

		await mockAPI.emit("agent_start", {}, mockCtx.ctx);
		await mockAPI.emit("turn_start", { turnIndex: 0, timestamp: t0 });
		await mockAPI.emit("before_provider_request", { payload: {} });
		await mockAPI.emit("after_provider_response", { status: 200, headers: {} });

		// On turn 1, OpenAI reports input tokens but 0 cacheRead/cacheWrite
		const assistantMessage = {
			role: "assistant",
			usage: { input: 28_400, output: 200, cacheRead: 0, cacheWrite: 0 },
		} as AgentMessage;

		await mockAPI.emit("turn_end", { turnIndex: 0, message: assistantMessage, toolResults: [] }, mockCtx.ctx);
		await mockAPI.emit("agent_settled", {}, mockCtx.ctx);

		expect(getActiveGuardianState()).toEqual({
			remainingMs: 600_000,
			totalTtlMs: 600_000,
			tokens: 28_400,
		});
		expect(mockCtx.setWidgetMock).toHaveBeenCalledWith(WIDGET_KEY, undefined);
	});

	it("activates 10m countdown widget for openai-codex over WebSocket transport without after_provider_response", async () => {
		const mockAPI = createMockExtensionAPI();
		rbfCacheGuardian(mockAPI.api);
		const mockCtx = createMockExtensionContext({ provider: "openai-codex" });

		const t0 = 1_000_000;
		setTime(t0);

		await mockAPI.emit("agent_start", {}, mockCtx.ctx);
		await mockAPI.emit("turn_start", { turnIndex: 0, timestamp: t0 });
		await mockAPI.emit("before_provider_request", { payload: {} });
		// Note: WebSocket transport does NOT emit after_provider_response

		const assistantMessage = {
			role: "assistant",
			stopReason: "stop",
			usage: { input: 28_400, output: 200, cacheRead: 0, cacheWrite: 0 },
		} as AgentMessage;

		await mockAPI.emit("turn_end", { turnIndex: 0, message: assistantMessage, toolResults: [] }, mockCtx.ctx);
		await mockAPI.emit("agent_settled", {}, mockCtx.ctx);

		expect(getActiveGuardianState()).toEqual({
			remainingMs: 600_000,
			totalTtlMs: 600_000,
			tokens: 28_400,
		});
		expect(mockCtx.setWidgetMock).toHaveBeenCalledWith(WIDGET_KEY, undefined);
	});

	it("discards candidate on WebSocket transport when assistant message stopReason is error or aborted", async () => {
		const mockAPI = createMockExtensionAPI();
		rbfCacheGuardian(mockAPI.api);
		const mockCtx = createMockExtensionContext({ provider: "openai-codex" });

		const t0 = 1_000_000;
		setTime(t0);

		await mockAPI.emit("agent_start", {}, mockCtx.ctx);
		await mockAPI.emit("turn_start", { turnIndex: 0, timestamp: t0 });
		await mockAPI.emit("before_provider_request", { payload: {} });
		// No after_provider_response

		const assistantMessage = {
			role: "assistant",
			stopReason: "error",
			usage: { input: 28_400, output: 200, cacheRead: 0, cacheWrite: 0 },
		} as AgentMessage;

		await mockAPI.emit("turn_end", { turnIndex: 0, message: assistantMessage, toolResults: [] }, mockCtx.ctx);
		await mockAPI.emit("agent_settled", {}, mockCtx.ctx);

		expect(getActiveGuardianState()).toBeNull();
	});

	it("remains quiet for openai-codex on turn 1 when input is below 1024 tokens", async () => {
		const mockAPI = createMockExtensionAPI();
		rbfCacheGuardian(mockAPI.api);
		const mockCtx = createMockExtensionContext({ provider: "openai-codex" });

		const t0 = 1_000_000;
		setTime(t0);

		await mockAPI.emit("agent_start", {}, mockCtx.ctx);
		await mockAPI.emit("turn_start", { turnIndex: 0, timestamp: t0 });
		await mockAPI.emit("before_provider_request", { payload: {} });
		await mockAPI.emit("after_provider_response", { status: 200, headers: {} });

		const assistantMessage = {
			role: "assistant",
			usage: { input: 500, output: 50, cacheRead: 0, cacheWrite: 0 },
		} as AgentMessage;

		await mockAPI.emit("turn_end", { turnIndex: 0, message: assistantMessage, toolResults: [] }, mockCtx.ctx);
		await mockAPI.emit("agent_settled", {}, mockCtx.ctx);

		expect(getActiveGuardianState()).toBeNull();
	});

	it("transitions through 30% and 10% thresholds with 60s alert for 10m Codex TTL", async () => {
		const mockAPI = createMockExtensionAPI();
		rbfCacheGuardian(mockAPI.api);
		const mockCtx = createMockExtensionContext({ provider: "openai-codex" });

		const t0 = 1_000_000;
		setTime(t0);

		await mockAPI.emit("agent_start", {}, mockCtx.ctx);
		await mockAPI.emit("turn_start", { turnIndex: 0, timestamp: t0 });
		await mockAPI.emit("before_provider_request", { payload: {} });
		await mockAPI.emit("after_provider_response", { status: 200, headers: {} });

		const assistantMessage = {
			role: "assistant",
			usage: { input: 100, output: 200, cacheRead: 28_400, cacheWrite: 0 },
		} as AgentMessage;

		await mockAPI.emit("turn_end", { turnIndex: 0, message: assistantMessage, toolResults: [] }, mockCtx.ctx);
		await mockAPI.emit("agent_settled", {}, mockCtx.ctx);

		// Initial render at T0 (10m TTL): Calm state
		expect(getActiveGuardianState()?.remainingMs).toBe(600_000);

		// Advance 7 minutes (420s), remaining = 180s (3m = 30% threshold): Warning state
		advanceTime(420_000);
		expect(getActiveGuardianState()?.remainingMs).toBe(180_000);
		expect(mockCtx.notifyMock).not.toHaveBeenCalled();

		// Advance to 540s (9 minutes, remaining = 60s = 10% threshold): Critical state
		advanceTime(120_000);
		expect(getActiveGuardianState()?.remainingMs).toBe(60_000);
		expect(mockCtx.notifyMock).toHaveBeenCalledTimes(1);
		expect(mockCtx.notifyMock).toHaveBeenCalledWith("Prompt cache guarantee ends in 60s · 28.4k cached", "warning");
		expect(mockAPI.execMock).toHaveBeenCalledWith(
			"/usr/bin/osascript",
			["-e", expect.stringContaining("Prompt cache guarantee ends in 60s · 28.4k cached")],
		);
	});

	it("remains quiet when provider is unconfigured", async () => {
		const mockAPI = createMockExtensionAPI();
		rbfCacheGuardian(mockAPI.api);
		const mockCtx = createMockExtensionContext({ provider: "google" });

		const t0 = 1_000_000;
		setTime(t0);

		await mockAPI.emit("agent_start", {}, mockCtx.ctx);
		await mockAPI.emit("turn_start", { turnIndex: 0, timestamp: t0 });
		await mockAPI.emit("before_provider_request", { payload: {} });
		await mockAPI.emit("after_provider_response", { status: 200, headers: {} });

		const assistantMessage = {
			role: "assistant",
			usage: { cacheRead: 50_000, cacheWrite: 0 },
		} as AgentMessage;

		await mockAPI.emit("turn_end", { turnIndex: 0, message: assistantMessage, toolResults: [] }, mockCtx.ctx);
		await mockAPI.emit("agent_settled", {}, mockCtx.ctx);

		expect(getActiveGuardianState()).toBeNull();
	});

	it("remains quiet when PI_CACHE_RETENTION is long", async () => {
		const originalEnv = process.env.PI_CACHE_RETENTION;
		process.env.PI_CACHE_RETENTION = "long";

		try {
			const mockAPI = createMockExtensionAPI();
			rbfCacheGuardian(mockAPI.api);
			const mockCtx = createMockExtensionContext({ provider: "anthropic" });

			const t0 = 1_000_000;
			setTime(t0);

			await mockAPI.emit("agent_start", {}, mockCtx.ctx);
			await mockAPI.emit("turn_start", { turnIndex: 0, timestamp: t0 });
			await mockAPI.emit("before_provider_request", { payload: {} });
			await mockAPI.emit("after_provider_response", { status: 200, headers: {} });

			const assistantMessage = {
				role: "assistant",
				usage: { cacheRead: 50_000, cacheWrite: 0 },
			} as AgentMessage;

			await mockAPI.emit("turn_end", { turnIndex: 0, message: assistantMessage, toolResults: [] }, mockCtx.ctx);
			await mockAPI.emit("agent_settled", {}, mockCtx.ctx);

			expect(getActiveGuardianState()).toBeNull();
		} finally {
			process.env.PI_CACHE_RETENTION = originalEnv;
		}
	});

	it("remains quiet when turn reports zero cached tokens", async () => {
		const mockAPI = createMockExtensionAPI();
		rbfCacheGuardian(mockAPI.api);
		const mockCtx = createMockExtensionContext();

		const t0 = 1_000_000;
		setTime(t0);

		await mockAPI.emit("agent_start", {}, mockCtx.ctx);
		await mockAPI.emit("turn_start", { turnIndex: 0, timestamp: t0 });
		await mockAPI.emit("before_provider_request", { payload: {} });
		await mockAPI.emit("after_provider_response", { status: 200, headers: {} });

		const assistantMessage = {
			role: "assistant",
			usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
		} as AgentMessage;

		await mockAPI.emit("turn_end", { turnIndex: 0, message: assistantMessage, toolResults: [] }, mockCtx.ctx);
		await mockAPI.emit("agent_settled", {}, mockCtx.ctx);

		expect(getActiveGuardianState()).toBeNull();
	});

	it("discards candidate on non-2xx provider response", async () => {
		const mockAPI = createMockExtensionAPI();
		rbfCacheGuardian(mockAPI.api);
		const mockCtx = createMockExtensionContext();

		const t0 = 1_000_000;
		setTime(t0);

		await mockAPI.emit("agent_start", {}, mockCtx.ctx);
		await mockAPI.emit("turn_start", { turnIndex: 0, timestamp: t0 });
		await mockAPI.emit("before_provider_request", { payload: {} });
		await mockAPI.emit("after_provider_response", { status: 529, headers: {} });

		const assistantMessage = {
			role: "assistant",
			usage: { cacheRead: 50_000, cacheWrite: 0 },
		} as AgentMessage;

		await mockAPI.emit("turn_end", { turnIndex: 0, message: assistantMessage, toolResults: [] }, mockCtx.ctx);
		await mockAPI.emit("agent_settled", {}, mockCtx.ctx);

		expect(getActiveGuardianState()).toBeNull();
	});

	it("discards candidate if multiple requests fire in one turn (correlation unsafe)", async () => {
		const mockAPI = createMockExtensionAPI();
		rbfCacheGuardian(mockAPI.api);
		const mockCtx = createMockExtensionContext();

		const t0 = 1_000_000;
		setTime(t0);

		await mockAPI.emit("agent_start", {}, mockCtx.ctx);
		await mockAPI.emit("turn_start", { turnIndex: 0, timestamp: t0 });
		await mockAPI.emit("before_provider_request", { payload: {} });
		// Second request fires before first is consumed
		await mockAPI.emit("before_provider_request", { payload: {} });
		await mockAPI.emit("after_provider_response", { status: 200, headers: {} });

		const assistantMessage = {
			role: "assistant",
			usage: { cacheRead: 50_000, cacheWrite: 0 },
		} as AgentMessage;

		await mockAPI.emit("turn_end", { turnIndex: 0, message: assistantMessage, toolResults: [] }, mockCtx.ctx);
		await mockAPI.emit("agent_settled", {}, mockCtx.ctx);

		expect(getActiveGuardianState()).toBeNull();
	});

	it("transitions through warning (30%) and critical (10%) thresholds and fires notification once", async () => {
		const mockAPI = createMockExtensionAPI();
		rbfCacheGuardian(mockAPI.api);
		const mockCtx = createMockExtensionContext();

		const t0 = 1_000_000;
		setTime(t0);

		await mockAPI.emit("agent_start", {}, mockCtx.ctx);
		await mockAPI.emit("turn_start", { turnIndex: 0, timestamp: t0 });
		await mockAPI.emit("before_provider_request", { payload: {} });
		await mockAPI.emit("after_provider_response", { status: 200, headers: {} });

		const assistantMessage = {
			role: "assistant",
			usage: { cacheRead: 182_600, cacheWrite: 0 },
		} as AgentMessage;

		await mockAPI.emit("turn_end", { turnIndex: 0, message: assistantMessage, toolResults: [] }, mockCtx.ctx);
		await mockAPI.emit("agent_settled", {}, mockCtx.ctx);

		// Initial render at T0 (5m TTL): Calm state
		expect(getActiveGuardianState()?.remainingMs).toBe(300_000);
		expect(mockCtx.notifyMock).not.toHaveBeenCalled();
		expect(mockAPI.execMock).not.toHaveBeenCalled();

		// Advance to 225s after T0 (75s remaining = 25% <= 30%): Warning state
		advanceTime(225_000);
		expect(getActiveGuardianState()?.remainingMs).toBe(75_000);
		expect(mockCtx.notifyMock).not.toHaveBeenCalled();

		// Next scheduled tick arrives at 30s remaining (45s later, critical threshold)
		advanceTime(45_000);
		expect(getActiveGuardianState()?.remainingMs).toBe(30_000);
		expect(mockCtx.notifyMock).toHaveBeenCalledTimes(1);
		expect(mockCtx.notifyMock).toHaveBeenCalledWith("Prompt cache guarantee ends in 30s · 182.6k cached", "warning");
		expect(mockAPI.execMock).toHaveBeenCalledTimes(1);
		expect(mockAPI.execMock).toHaveBeenCalledWith(
			"/usr/bin/osascript",
			["-e", expect.stringContaining("Prompt cache guarantee ends in 30s · 182.6k cached")],
		);

		// Advance 10 more seconds: notification does NOT repeat
		advanceTime(10_000);
		expect(mockCtx.notifyMock).toHaveBeenCalledTimes(1);
		expect(mockAPI.execMock).toHaveBeenCalledTimes(1);

		// Advance to 300s (deadline reached): Elapsed state
		advanceTime(20_000);
		expect(getActiveGuardianState()?.remainingMs).toBe(0);
	});

	it("skips notification on wake-up if sleep jumps past deadline", async () => {
		const mockAPI = createMockExtensionAPI();
		rbfCacheGuardian(mockAPI.api);
		const mockCtx = createMockExtensionContext();

		const t0 = 1_000_000;
		setTime(t0);

		await mockAPI.emit("agent_start", {}, mockCtx.ctx);
		await mockAPI.emit("turn_start", { turnIndex: 0, timestamp: t0 });
		await mockAPI.emit("before_provider_request", { payload: {} });
		await mockAPI.emit("after_provider_response", { status: 200, headers: {} });

		const assistantMessage = {
			role: "assistant",
			usage: { cacheRead: 50_000, cacheWrite: 0 },
		} as AgentMessage;

		await mockAPI.emit("turn_end", { turnIndex: 0, message: assistantMessage, toolResults: [] }, mockCtx.ctx);
		await mockAPI.emit("agent_settled", {}, mockCtx.ctx);

		// Sudden jump past deadline (e.g. laptop slept for 10 minutes)
		setTime(t0 + 600_000);
		advanceTime(60_000);

		// Immediately shows elapsed state without triggering notification
		expect(mockCtx.notifyMock).not.toHaveBeenCalled();
		expect(mockAPI.execMock).not.toHaveBeenCalled();
		expect(getActiveGuardianState()?.remainingMs).toBe(0);
	});

	it("clears widget and invalidates epoch on session events", async () => {
		const mockAPI = createMockExtensionAPI();
		rbfCacheGuardian(mockAPI.api);

		const lifecycleEvents = [
			"input",
			"session_shutdown",
			"session_tree",
			"session_compact",
			"model_select",
			"thinking_level_select",
		];

		for (const eventName of lifecycleEvents) {
			const mockCtx = createMockExtensionContext();
			await mockAPI.emit(eventName, {}, mockCtx.ctx);
			expect(mockCtx.setWidgetMock).toHaveBeenCalledWith(WIDGET_KEY, undefined);
		}
	});

	it("clears state and stops interval when agent_start fires", async () => {
		const mockAPI = createMockExtensionAPI();
		rbfCacheGuardian(mockAPI.api);
		const mockCtx = createMockExtensionContext();

		const t0 = 1_000_000;
		setTime(t0);

		await mockAPI.emit("agent_start", {}, mockCtx.ctx);
		await mockAPI.emit("turn_start", { turnIndex: 0, timestamp: t0 });
		await mockAPI.emit("before_provider_request", { payload: {} });
		await mockAPI.emit("after_provider_response", { status: 200, headers: {} });

		const assistantMessage = {
			role: "assistant",
			usage: { cacheRead: 50_000, cacheWrite: 0 },
		} as AgentMessage;

		await mockAPI.emit("turn_end", { turnIndex: 0, message: assistantMessage, toolResults: [] }, mockCtx.ctx);
		await mockAPI.emit("agent_settled", {}, mockCtx.ctx);
		expect(getActiveGuardianState()).not.toBeNull();

		// Next user prompt starts agent
		await mockAPI.emit("agent_start", {}, mockCtx.ctx);
		expect(getActiveGuardianState()).toBeNull();
	});

	it("source code contains zero unauthorized sinks or network imports", () => {
		const sourcePath = resolve(__dirname, "rbf-cache-guardian.ts");
		const content = readFileSync(sourcePath, "utf-8");

		expect(content).not.toMatch(/node:child_process|child_process/);
		expect(content).not.toMatch(/node:net|node:http|fetch/);
		expect(content).not.toMatch(/process\.exit/);
	});
});
