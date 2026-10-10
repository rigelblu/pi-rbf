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


// pi-43: last-message age on the token row. Each case loads a fresh status-line module, the
// way Pi does on /reload, over a two-row native footer whose token row has padding.
describe("pi-43: last-message age footer lifecycle", () => {
	const MIN = 60_000;
	const T0 = Date.UTC(2026, 9, 5, 12, 0);
	const CWD = "/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf";
	const TOKEN_ROW = `↑10k ↓5k $0.01${" ".repeat(40)}gate-model`;
	const AGE_GETTER = Symbol.for("rbf.statusLine.getAgeState");
	const AGE_WRAPPER = Symbol.for("rbf.statusLine.ageWrapper");
	const AGE_WARNED = Symbol.for("rbf.statusLine.ageRestartWarned");
	const PATCHED = Symbol.for("rbf.statusLine.footerPatched");
	const proto = FooterComponent.prototype as any;
	let nativeRender: any;
	let nativeCalls = 0;
	let nativeRows: () => string[];

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		vi.resetModules();
		nativeRender = FooterComponent.prototype.render;
		nativeCalls = 0;
		nativeRows = () => [`${CWD} (detached)`, TOKEN_ROW];
		FooterComponent.prototype.render = function (): string[] {
			nativeCalls++;
			return nativeRows();
		};
	});

	afterEach(() => {
		FooterComponent.prototype.render = nativeRender;
		for (const key of [
			PATCHED,
			Symbol.for("rbf.statusLine.originalFooterRender"),
			Symbol.for("rbf.statusLine.invalidateCache"),
			AGE_GETTER,
			AGE_WRAPPER,
			AGE_WARNED,
		]) {
			delete proto[key];
		}
		delete (globalThis as any)[Symbol.for("rbf.statusLine.cache")];
		vi.useRealTimers();
	});

	async function load(entries: any[] = [], options: { hasUI?: boolean; mode?: string; throwingSetStatus?: boolean } = {}) {
		const mod = await import("./rbf-status-line.ts");
		const pi = createMockExtensionAPI();
		const branch = { entries };
		const setStatus = vi.fn(() => {
			if (options.throwingSetStatus) throw new Error("status boom");
		});
		const notify = vi.fn();
		const ctx = {
			hasUI: options.hasUI ?? true,
			mode: options.mode ?? "tui",
			ui: { setStatus, notify },
			sessionManager: { getBranch: () => branch.entries },
		};
		mod.default(pi.api as any);
		const emit = (event: string, payload: unknown = {}) => pi.emit(event, payload, ctx);
		await emit("session_start");
		return { mod, pi, branch, setStatus, notify, ctx, emit };
	}
	const userEntry = (timestamp: number) => ({ type: "message", message: { role: "user", timestamp } });
	const render = (width = 120): string[] =>
		FooterComponent.prototype.render.call(createMockFooter({ cwd: CWD, sessionName: "s" }) as any, width);
	const seedCache = (mod: any, ageMs: number) =>
		mod.setCachedStatusLine({ cwd: CWD, sessionName: "s", line: "📁 SEEDED", timestamp: Date.now() - ageMs });

	describe("age baseline cache", () => {
		it("follows the two-second workspace expiry exactly as a render without the cue", async () => {
			const s = await load([userEntry(T0 - 5 * MIN)]);
			for (const withAge of [true, false]) {
				if (!withAge) delete proto[AGE_GETTER];
				seedCache(s.mod, 1000);
				render();
				expect(s.mod.getCachedStatusLine()?.line, `warm, age ${withAge}`).toBe("📁 SEEDED");

				seedCache(s.mod, 2500);
				render();
				const refreshed = s.mod.getCachedStatusLine();
				expect(refreshed?.line, `expired, age ${withAge}`).not.toBe("📁 SEEDED");
				expect(refreshed?.timestamp).toBe(Date.now());
			}
		});

		it("deletes the cache on the baseline events only, not on tree navigation or compaction", async () => {
			const s = await load([userEntry(T0 - 5 * MIN)]);
			for (const event of ["session_start", "turn_start", "turn_end", "agent_settled", "user_bash"]) {
				seedCache(s.mod, 0);
				await s.emit(event);
				expect(s.mod.getCachedStatusLine(), event).toBeNull();
			}
			for (const event of ["session_tree", "session_compact"]) {
				seedCache(s.mod, 0);
				await s.emit(event);
				expect(s.mod.getCachedStatusLine()?.line, event).toBe("📁 SEEDED");
			}
			seedCache(s.mod, 0);
			await s.emit("message_start", { message: { role: "user", timestamp: T0 } });
			expect(s.mod.getCachedStatusLine()?.line).toBe("📁 SEEDED");
		});

		it("calls the native render once, keeps a native error's identity, and survives a throwing redraw request", async () => {
			const s = await load([userEntry(T0 - 5 * MIN)], { throwingSetStatus: true });
			seedCache(s.mod, 0);
			nativeCalls = 0;
			const rows = render();
			expect(nativeCalls).toBe(1);
			expect(rows[1].startsWith("💬 5m | ")).toBe(true);

			await expect(s.emit("message_start", { message: { role: "user", timestamp: T0 } })).resolves.toBeUndefined();
			expect(s.setStatus).toHaveBeenCalled();

			const boom = new Error("native boom");
			nativeRows = () => {
				throw boom;
			};
			expect(() => render()).toThrow(boom);
			nativeRows = () => [];
			expect(render()).toEqual([]);
		});
	});

	describe("age timer lifecycle", () => {
		it("fires only at minute boundaries of the selected timestamp and redraws only on a changed label", async () => {
			const s = await load();
			expect(vi.getTimerCount()).toBe(0);
			await s.emit("message_start", { message: { role: "user", timestamp: T0 } });
			const afterDelivery = s.setStatus.mock.calls.length;
			expect(afterDelivery).toBe(1);
			expect(vi.getTimerCount(), "no timer until the cue is drawn").toBe(0);

			const armed = vi.spyOn(globalThis, "setTimeout");
			vi.advanceTimersByTime(12_345);
			expect(render()[1].startsWith("💬 <1m | ")).toBe(true);
			expect(vi.getTimerCount()).toBe(1);
			expect(armed.mock.calls.map((call) => call[1]), "one timer, aimed at the minute boundary").toEqual([MIN - 12_345]);
			armed.mockRestore();
			render();
			render();
			expect(vi.getTimerCount(), "repeated renders keep one timer").toBe(1);

			vi.advanceTimersByTime(MIN - 12_345 - 1);
			expect(s.setStatus.mock.calls.length, "no tick inside the first minute").toBe(afterDelivery);
			vi.advanceTimersByTime(1);
			expect(s.setStatus.mock.calls.length).toBe(afterDelivery + 1);
			expect(vi.getTimerCount(), "a tick waits for the render to re-arm").toBe(0);
			expect(render()[1].startsWith("💬 1m | ")).toBe(true);
			expect(vi.getTimerCount()).toBe(1);

			vi.advanceTimersByTime(MIN);
			expect(s.setStatus.mock.calls.length).toBe(afterDelivery + 2);
		});

		it("holds no timer while the cue is hidden by width, unknown, empty, headless or shut down", async () => {
			const s = await load([userEntry(T0 - 5 * MIN)]);
			render(120);
			expect(vi.getTimerCount()).toBe(1);

			nativeRows = () => [`${CWD}`, "↑10k ↓5k $0.01 gate-model"]; // no padding: the cue cannot fit
			expect(render(30)[1]).toBe("↑10k ↓5k $0.01 gate-model");
			expect(vi.getTimerCount(), "width-hidden").toBe(0);

			nativeRows = () => [`${CWD}`, TOKEN_ROW];
			expect(render(120)[1].startsWith("💬 5m | ")).toBe(true);
			expect(vi.getTimerCount(), "widening re-arms").toBe(1);

			await s.emit("message_start", { message: { role: "user" } });
			expect(render(120)[1].startsWith("💬 ? | ")).toBe(true);
			expect(vi.getTimerCount(), "unknown").toBe(0);

			await s.emit("session_shutdown");
			expect(render(120)[1]).toBe(TOKEN_ROW);
			expect(vi.getTimerCount(), "shutdown").toBe(0);

			vi.resetModules();
			const empty = await load([]);
			expect(render(120)[1]).toBe(TOKEN_ROW);
			expect(vi.getTimerCount(), "empty branch").toBe(0);
			await empty.emit("session_shutdown");

			vi.resetModules();
			await load([userEntry(T0 - 5 * MIN)], { hasUI: false, mode: "print" });
			expect(render(120)[1]).toBe(TOKEN_ROW);
			expect(vi.getTimerCount(), "print").toBe(0);

			vi.resetModules();
			const rpc = await load([userEntry(T0 - 5 * MIN)], { hasUI: true, mode: "rpc" });
			expect(render(120)[1]).toBe(TOKEN_ROW);
			expect(vi.getTimerCount(), "rpc").toBe(0);
			expect(rpc.setStatus).not.toHaveBeenCalled();
		});

		it("checks a future timestamp at most once a minute and recomputes after a wall-clock jump", async () => {
			const s = await load([userEntry(T0 + 150_000)]);
			expect(render()[1].startsWith("💬 ? | ")).toBe(true);
			expect(vi.getTimerCount()).toBe(1);
			const before = s.setStatus.mock.calls.length;
			vi.advanceTimersByTime(59_999);
			expect(vi.getTimerCount(), "one check per minute").toBe(1);
			vi.advanceTimersByTime(150_000);
			render();
			expect(render()[1].startsWith("💬 <1m | ")).toBe(true);
			expect(s.setStatus.mock.calls.length).toBeLessThanOrEqual(before + 4);

			vi.setSystemTime(T0 + 150_000 + 5 * 60 * MIN + 1);
			expect(render()[1].startsWith("💬 5h | "), "wake recomputes without replaying ticks").toBe(true);
			expect(vi.getTimerCount()).toBe(1);
		});

		it("re-arms on the new message's minute when the selection changes without changing the label", async () => {
			const s = await load();
			await s.emit("message_start", { message: { role: "user", timestamp: T0 } });
			render();
			vi.advanceTimersByTime(20_000);
			await s.emit("message_start", { message: { role: "user", timestamp: T0 + 20_000 } });
			const calls = s.setStatus.mock.calls.length;
			vi.advanceTimersByTime(40_000); // old message's boundary
			expect(s.setStatus.mock.calls.length, "label is still <1m for the newer message").toBe(calls);
			vi.advanceTimersByTime(20_000); // new message's boundary
			expect(s.setStatus.mock.calls.length).toBe(calls + 1);
		});
	});

	describe("age fresh ownership", () => {
		it("dispatches to the current module after reloads and survives late disposal of the old one", async () => {
			const first = await load([userEntry(T0 - 2 * MIN)]);
			expect(render()[1].startsWith("💬 2m | ")).toBe(true);

			vi.resetModules();
			const second = await load([userEntry(T0 - 7 * MIN)]);
			expect(second.mod).not.toBe(first.mod);
			expect(render()[1].startsWith("💬 7m | "), "current callbacks, not first-factory").toBe(true);

			await first.emit("session_shutdown"); // old disposal after new activation
			expect(render()[1].startsWith("💬 7m | "), "old disposal must not clear the new slot").toBe(true);

			vi.resetModules();
			const third = await load([userEntry(T0 - 9 * MIN)]);
			await second.emit("session_shutdown");
			const row = render()[1];
			expect(row.startsWith("💬 9m | ")).toBe(true);
			expect(row.match(/💬/g)?.length, "one cue").toBe(1);
			expect(vi.getTimerCount(), "one timer").toBe(1);
			expect(third.notify).not.toHaveBeenCalled();
		});

		it("leaves the footer as it was when a factory fails partway", async () => {
			const mod = await import("./rbf-status-line.ts");
			const control = (() => {
				mod.patchFooterComponent();
				return render();
			})();
			const pi = createMockExtensionAPI();
			const failing = {
				...pi.api,
				on: (event: string, handler: any) => {
					if (event === "message_start") throw new Error("factory boom");
					pi.api.on(event, handler);
				},
			};
			expect(() => mod.default(failing as any)).toThrow("factory boom");
			expect(render()).toEqual(control);
			expect(vi.getTimerCount()).toBe(0);
		});

		for (const [label, version] of [
			["no version, as released in v0.23.0", undefined],
			["a lower version", 0],
		] as const) {
			it(`stays off and warns once over a wrapper with ${label}`, async () => {
				// A wrapper from before this feature: patched, top row only, never reads the age slot.
				const inner = FooterComponent.prototype.render;
				FooterComponent.prototype.render = function (this: any, width: number): string[] {
					const lines = inner.call(this, width);
					lines[0] = "📁 legacy";
					return lines;
				};
				proto[PATCHED] = true;
				if (version !== undefined) proto[AGE_WRAPPER] = version;
				const control = render();

				const first = await load([userEntry(T0 - 5 * MIN)]);
				expect(render()).toEqual(control);
				expect(first.notify).toHaveBeenCalledTimes(1);
				expect(first.notify).toHaveBeenCalledWith("Last msg needs a Pi restart to appear.", "warning");
				await first.emit("session_start");
				await first.emit("message_start", { message: { role: "user", timestamp: T0 } });
				expect(first.notify).toHaveBeenCalledTimes(1);

				vi.resetModules();
				const second = await load([userEntry(T0 - 5 * MIN)]);
				await second.emit("session_start");
				expect(second.notify, "a fresh factory in the same process must not warn again").not.toHaveBeenCalled();
				expect(render()).toEqual(control);
				expect(vi.getTimerCount()).toBe(0);
				FooterComponent.prototype.render = inner;
			});
		}
	});
});
