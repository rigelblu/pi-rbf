import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FooterComponent, initTheme } from "@earendil-works/pi-coding-agent";

function createMockExtensionAPI() {
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	return {
		api: {
			on: (event: string, handler: (...args: any[]) => any) => {
				const existing = handlers.get(event) ?? [];
				existing.push(handler);
				handlers.set(event, existing);
			},
			registerCommand: vi.fn(),
			registerTool: vi.fn(),
			registerProvider: vi.fn(),
			exec: vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 }),
		},
		emit: async (event: string, ...args: any[]) => {
			const list = handlers.get(event) ?? [];
			for (const h of list) {
				await h(...args);
			}
		},
		handlers,
	};
}

function createMockExtensionContext(options?: { cwd?: string; provider?: string }) {
	return {
		cwd: options?.cwd ?? "/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf",
		hasUI: true,
		mode: "tui",
		model: {
			provider: options?.provider ?? "anthropic",
			id: "claude-3-7-sonnet",
		},
		ui: {
			notify: vi.fn(),
			setWidget: vi.fn(),
			theme: {
				fg: (_color: string, text: string) => text,
				bg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
		},
	};
}

function createMockFooter(options?: { cwd?: string; sessionName?: string }) {
	return {
		session: {
			sessionManager: {
				getCwd: () => options?.cwd ?? "/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf",
				getSessionName: () => options?.sessionName ?? "pi17-test",
			},
			theme: {
				fg: (_color: string, text: string) => text,
				bg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			},
		},
	};
}

describe("pi-17.2: footer guardian countdown and status-line cache lifecycle", () => {
	let originalRender: any;

	beforeEach(() => {
		initTheme();
		originalRender = FooterComponent.prototype.render;
		FooterComponent.prototype.render = function (this: any, _width: number): string[] {
			return [
				"/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf (detached)",
				"↑10k ↓5k R2k $0.01 (sub) 10%/200k",
			];
		};
	});

	afterEach(() => {
		FooterComponent.prototype.render = originalRender;
		delete (FooterComponent.prototype as any)[Symbol.for("rbf.statusLine.footerPatched")];
		delete (FooterComponent.prototype as any)[Symbol.for("rbf.statusLine.originalFooterRender")];
		delete (FooterComponent.prototype as any)[Symbol.for("rbf.cacheGuardian.footerPatched")];
		delete (FooterComponent.prototype as any)[Symbol.for("rbf.cacheGuardian.originalFooterRender")];
		delete (FooterComponent.prototype as any)[Symbol.for("rbf.cacheGuardian.getActiveContent")];
	});

	it("retained footer wrapper reads current module guardian state and immediately invalidates status cache", async () => {
		const mockFooter = createMockFooter({
			cwd: "/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf",
			sessionName: "pi17-test",
		});
		const mockCtx = createMockExtensionContext();

		// Round 1: Load Module 1 for status-line and cache-guardian
		const status1 = await import("./rbf-status-line.ts");
		const guardian1 = await import("./rbf-cache-guardian.ts");

		const pi1 = createMockExtensionAPI();
		status1.default(pi1.api as any);
		guardian1.default(pi1.api as any);
		await pi1.emit("session_start", {}, mockCtx);

		// Seed distinguishable old guardian state in Module 1
		guardian1.setActiveGuardianState({
			remainingMs: 240_000,
			totalTtlMs: 300_000,
			tokens: 25_000,
		});

		// Seed OLD-SESSION in status-line cache with same cwd/session name and unexpired timestamp
		status1.setCachedStatusLine({
			cwd: "/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf",
			sessionName: "pi17-test",
			line: "📁 OLD-SESSION",
			timestamp: Date.now(),
		});

		let lines = FooterComponent.prototype.render.call(mockFooter as any, 120);
		expect(lines[0]).toContain("OLD-SESSION");
		expect(lines[0]).toContain("25.0k cached");

		// Shutdown Module 1
		await pi1.emit("session_shutdown", {}, mockCtx);

		// Immediately on shutdown, guardian meter must be empty
		lines = FooterComponent.prototype.render.call(mockFooter as any, 120);
		expect(lines[0], "guardian meter must be empty on shutdown").not.toContain("cached");
		expect(lines[0]).not.toContain("TTL");

		// Cycle 2: Load fresh module instances
		vi.resetModules();
		const status2 = await import("./rbf-status-line.ts");
		const guardian2 = await import("./rbf-cache-guardian.ts");

		const pi2 = createMockExtensionAPI();
		status2.default(pi2.api as any);
		guardian2.default(pi2.api as any);
		await pi2.emit("session_start", {}, mockCtx);

		// State must remain empty through fresh factory activation
		lines = FooterComponent.prototype.render.call(mockFooter as any, 120);
		expect(lines[0], "guardian meter must remain empty through fresh factory activation").not.toContain("cached");
		expect(lines[0]).not.toContain("TTL");

		// Status line invalidation check:
		// Fresh module invalidation must make retained renderer produce current rich row immediately, not wait 2s
		expect(lines[0], "status line must immediately clear OLD-SESSION cache").not.toContain("OLD-SESSION");
		expect(lines[0], "status line must immediately resolve current rich row").toContain("📁 pi-rbf");

		// Now simulate a new eligible cached turn in Module 2
		const t0 = Date.now();
		await pi2.emit("turn_start", { turnIndex: 0, timestamp: t0 });
		await pi2.emit("before_provider_request", { payload: {} });
		await pi2.emit("after_provider_response", { status: 200, headers: {} });
		await pi2.emit(
			"turn_end",
			{
				turnIndex: 0,
				message: {
					role: "assistant",
					usage: { cacheRead: 1024, cacheWrite: 0 },
				},
				toolResults: [],
			},
			mockCtx,
		);
		await pi2.emit("agent_settled", {}, mockCtx);

		// The retained renderer must now reflect Module 2's new guardian state: 5m TTL ... 1.0k cached
		lines = FooterComponent.prototype.render.call(mockFooter as any, 140);
		expect(lines[0], "retained footer wrapper must show new module's guardian state").toMatch(/5m TTL.*1\.0k cached/);
	});

	it("retained guardian getter binds to new module activeGuardianState and does not return empty string", async () => {
		const mockFooter = createMockFooter({
			cwd: "/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf",
			sessionName: "pi17-test",
		});
		const mockCtx = createMockExtensionContext();

		// Round 1: Load Module 1
		const guardian1 = await import("./rbf-cache-guardian.ts");
		const pi1 = createMockExtensionAPI();
		guardian1.default(pi1.api as any);
		await pi1.emit("session_start", {}, mockCtx);

		// Seed initial state in Module 1
		guardian1.setActiveGuardianState({
			remainingMs: 300_000,
			totalTtlMs: 300_000,
			tokens: 2048,
		});

		const getter1 = (FooterComponent.prototype as any)[Symbol.for("rbf.cacheGuardian.getActiveContent")];
		expect(getter1.call(mockFooter)).toContain("2.0k cached");

		// Shutdown Module 1
		await pi1.emit("session_shutdown", {}, mockCtx);

		// Cycle 2: Fresh Module 2
		vi.resetModules();
		const guardian2 = await import("./rbf-cache-guardian.ts");
		const pi2 = createMockExtensionAPI();
		guardian2.default(pi2.api as any);
		await pi2.emit("session_start", {}, mockCtx);

		// Module 2 updates state on a fresh turn
		guardian2.setActiveGuardianState({
			remainingMs: 300_000,
			totalTtlMs: 300_000,
			tokens: 1024,
		});

		// Retained getter from prototype must reflect Module 2 state, NOT empty string or Module 1 state
		const getter2 = (FooterComponent.prototype as any)[Symbol.for("rbf.cacheGuardian.getActiveContent")];
		const content = getter2.call(mockFooter);
		expect(content, "retained guardian getter must reflect new module state").toMatch(/5m TTL.*1\.0k cached/);
	});
});

