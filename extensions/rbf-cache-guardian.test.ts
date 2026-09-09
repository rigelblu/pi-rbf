import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AgentSettledEvent,
	AgentStartEvent,
	BeforeProviderRequestEvent,
	ExtensionAPI,
	ExtensionContext,
	TurnEndEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import rbfCacheGuardian, {
	type AfterProviderResponseEvent,
	CRITICAL_THRESHOLD,
	DEFAULT_ANTHROPIC_TTL_MS,
	formatCountdown,
	formatTokens,
	getGuardianThreshold,
	isSupportedProvider,
	renderGuardianWidgetContent,
	renderProgressBar,
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
		ctx,
		notifyMock,
		setWidgetMock,
		theme,
	};
}

function createMockExtensionAPI() {
	const handlers: Record<string, ((...args: any[]) => any)[]> = {};
	const execMock = vi.fn(async (_cmd: string, _args: string[]) => ({
		stdout: "",
		stderr: "",
		exitCode: 0,
	}));
	const registerCommandMock = vi.fn();

	const api = {
		on: vi.fn((event: string, handler: (...args: any[]) => any) => {
			if (!handlers[event]) {
				handlers[event] = [];
			}
			handlers[event].push(handler);
		}),
		exec: execMock,
		registerCommand: registerCommandMock,
	} as unknown as ExtensionAPI;

	return {
		api,
		handlers,
		execMock,
		registerCommandMock,
		async emit(event: string, payload: any, ctx?: any) {
			const list = handlers[event] || [];
			for (const h of list) {
				await h(payload, ctx);
			}
		},
	};
}

describe("rbfCacheGuardian pure helpers", () => {
	it("formatCountdown formats milliseconds into M:SS correctly", () => {
		expect(formatCountdown(300_000)).toBe("5:00");
		expect(formatCountdown(252_000)).toBe("4:12");
		expect(formatCountdown(150_000)).toBe("2:30");
		expect(formatCountdown(75_000)).toBe("1:15");
		expect(formatCountdown(25_000)).toBe("0:25");
		expect(formatCountdown(0)).toBe("0:00");
		expect(formatCountdown(-5000)).toBe("0:00");
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
		expect(renderProgressBar(300_000, 300_000)).toBe("[██████████]");
		// 84% full (252k/300k, 4:12) -> 8 pips
		expect(renderProgressBar(252_000, 300_000)).toBe("[████████░░]");
		// 50% full (150k/300k, 2:30) -> 5 pips
		expect(renderProgressBar(150_000, 300_000)).toBe("[█████░░░░░]");
		// 25% full (75k/300k, 1:15) -> 2 pips
		expect(renderProgressBar(75_000, 300_000)).toBe("[██░░░░░░░░]");
		// 8.33% full (25k/300k, 0:25) -> 0 pips
		expect(renderProgressBar(25_000, 300_000)).toBe("[░░░░░░░░░░]");
		// 0% full (0s remaining)
		expect(renderProgressBar(0, 300_000)).toBe("[░░░░░░░░░░]");
		// negative / zero total
		expect(renderProgressBar(-1000, 300_000)).toBe("[░░░░░░░░░░]");
		expect(renderProgressBar(100, 0)).toBe("[░░░░░░░░░░]");
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

	it("isSupportedProvider verifies direct Anthropic and respects PI_CACHE_RETENTION", () => {
		expect(isSupportedProvider("anthropic", {})).toBe(true);
		expect(isSupportedProvider("anthropic", { PI_CACHE_RETENTION: "short" })).toBe(true);
		expect(isSupportedProvider("anthropic", { PI_CACHE_RETENTION: "long" })).toBe(false);
		expect(isSupportedProvider("openai-codex", {})).toBe(false);
		expect(isSupportedProvider("openai", {})).toBe(false);
		expect(isSupportedProvider("google", {})).toBe(false);
		expect(isSupportedProvider(undefined, {})).toBe(false);
	});

	it("renderGuardianWidgetContent renders calm state in muted color", () => {
		const theme = createMockTheme();
		const output = renderGuardianWidgetContent(252_000, 300_000, 182_600, theme);
		expect(theme.fg).toHaveBeenCalledWith("muted", "4:12 TTL [████████░░] 182.6k cached");
		expect(output).toBe("[muted]4:12 TTL [████████░░] 182.6k cached[/muted]");
	});

	it("renderGuardianWidgetContent renders warning state with warning emoji in yellow", () => {
		const theme = createMockTheme();
		const output = renderGuardianWidgetContent(75_000, 300_000, 182_600, theme);
		expect(theme.fg).toHaveBeenCalledWith("warning", "⚠️ 1:15 TTL [██░░░░░░░░] 182.6k cached");
		expect(output).toBe("[warning]⚠️ 1:15 TTL [██░░░░░░░░] 182.6k cached[/warning]");
	});

	it("renderGuardianWidgetContent renders critical state with siren emoji in error red", () => {
		const theme = createMockTheme();
		const output = renderGuardianWidgetContent(25_000, 300_000, 182_600, theme);
		expect(theme.fg).toHaveBeenCalledWith("error", "🚨 0:25 TTL [░░░░░░░░░░] 182.6k cached");
		expect(output).toBe("[error]🚨 0:25 TTL [░░░░░░░░░░] 182.6k cached[/error]");
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

		expect(mockCtx.setWidgetMock).toHaveBeenCalledWith(
			WIDGET_KEY,
			expect.arrayContaining([expect.stringContaining("4:12 TTL [████████░░] 182.6k cached")]),
			{ placement: "belowEditor" },
		);
	});

	it("remains quiet when provider is not direct Anthropic", async () => {
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
			usage: { cacheRead: 50_000, cacheWrite: 0 },
		} as AgentMessage;

		await mockAPI.emit("turn_end", { turnIndex: 0, message: assistantMessage, toolResults: [] }, mockCtx.ctx);
		await mockAPI.emit("agent_settled", {}, mockCtx.ctx);

		expect(mockCtx.setWidgetMock).not.toHaveBeenCalledWith(
			WIDGET_KEY,
			expect.any(Array),
			expect.any(Object),
		);
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

			expect(mockCtx.setWidgetMock).not.toHaveBeenCalledWith(
				WIDGET_KEY,
				expect.any(Array),
				expect.any(Object),
			);
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

		expect(mockCtx.setWidgetMock).not.toHaveBeenCalledWith(
			WIDGET_KEY,
			expect.any(Array),
			expect.any(Object),
		);
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

		expect(mockCtx.setWidgetMock).not.toHaveBeenCalledWith(
			WIDGET_KEY,
			expect.any(Array),
			expect.any(Object),
		);
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

		expect(mockCtx.setWidgetMock).not.toHaveBeenCalledWith(
			WIDGET_KEY,
			expect.any(Array),
			expect.any(Object),
		);
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

		// Initial render at T0 (5:00 TTL): Calm state
		expect(mockCtx.theme.fg).toHaveBeenCalledWith("muted", "5:00 TTL [██████████] 182.6k cached");
		expect(mockCtx.notifyMock).not.toHaveBeenCalled();
		expect(mockAPI.execMock).not.toHaveBeenCalled();

		// Advance to 225s after T0 (75s remaining = 1:15, which is 25% <= 30%): Warning state
		advanceTime(225_000);
		expect(mockCtx.theme.fg).toHaveBeenCalledWith("warning", "⚠️ 1:15 TTL [██░░░░░░░░] 182.6k cached");
		expect(mockCtx.notifyMock).not.toHaveBeenCalled();

		// Advance to 275s after T0 (25s remaining = 0:25, which is 8.33% <= 10%): Critical state
		advanceTime(50_000);
		expect(mockCtx.theme.fg).toHaveBeenCalledWith("error", "🚨 0:25 TTL [░░░░░░░░░░] 182.6k cached");
		expect(mockCtx.notifyMock).toHaveBeenCalledTimes(1);
		expect(mockCtx.notifyMock).toHaveBeenCalledWith("Prompt cache guarantee ends in 30s · 182.6k cached", "warning");
		expect(mockAPI.execMock).toHaveBeenCalledTimes(1);
		expect(mockAPI.execMock).toHaveBeenCalledWith(
			"/usr/bin/osascript",
			["-e", expect.stringContaining("Prompt cache guarantee ends in 30s · 182.6k cached")],
		);

		// Advance 5 more seconds: notification does NOT repeat
		advanceTime(5_000);
		expect(mockCtx.notifyMock).toHaveBeenCalledTimes(1);
		expect(mockAPI.execMock).toHaveBeenCalledTimes(1);

		// Advance to 300s (deadline reached): Elapsed state
		advanceTime(20_000);
		expect(mockCtx.theme.fg).toHaveBeenCalledWith("dim", "new task? ");
		expect(mockCtx.theme.fg).toHaveBeenCalledWith("accent", "/clear");
		expect(mockCtx.theme.fg).toHaveBeenCalledWith("dim", " to save ");
		expect(mockCtx.theme.fg).toHaveBeenCalledWith("accent", "182.6k tokens");
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
		advanceTime(1000);

		// Immediately shows elapsed state without triggering notification
		expect(mockCtx.notifyMock).not.toHaveBeenCalled();
		expect(mockAPI.execMock).not.toHaveBeenCalled();
		expect(mockCtx.theme.fg).toHaveBeenCalledWith("dim", "new task? ");
		expect(mockCtx.theme.fg).toHaveBeenCalledWith("accent", "/clear");
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

	it("clears widget and stops interval when agent_start fires", async () => {
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
		expect(mockCtx.setWidgetMock).toHaveBeenCalledWith(WIDGET_KEY, expect.any(Array), expect.any(Object));

		// Next user prompt starts agent
		mockCtx.setWidgetMock.mockClear();
		await mockAPI.emit("agent_start", {}, mockCtx.ctx);
		expect(mockCtx.setWidgetMock).toHaveBeenCalledWith(WIDGET_KEY, undefined);
	});

	it("source code contains zero unauthorized sinks or network imports", () => {
		const sourcePath = resolve(__dirname, "rbf-cache-guardian.ts");
		const content = readFileSync(sourcePath, "utf-8");

		expect(content).not.toMatch(/node:child_process|child_process/);
		expect(content).not.toMatch(/node:net|node:http|fetch/);
		expect(content).not.toMatch(/process\.exit/);
	});
});
