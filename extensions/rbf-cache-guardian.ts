import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type AgentSettledEvent,
	type AgentStartEvent,
	type BeforeProviderRequestEvent,
	type ExtensionAPI,
	type ExtensionContext,
	FooterComponent,
	type TurnEndEvent,
	type TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface AfterProviderResponseEvent {
	type?: "after_provider_response";
	status: number;
	headers?: Record<string, string>;
}

export const WIDGET_KEY = "rbf-cache-guardian";
export const DEFAULT_ANTHROPIC_TTL_MS = 300_000; // 5 minutes
export const DEFAULT_CODEX_TTL_MS = 600_000; // 10 minutes
export const DEFAULT_PROVIDER_TTL_MS: Record<string, number> = {
	anthropic: DEFAULT_ANTHROPIC_TTL_MS,
	"openai-codex": DEFAULT_CODEX_TTL_MS,
	openai: DEFAULT_CODEX_TTL_MS,
};
export const WARNING_THRESHOLD = 0.30; // 30% (1:30 on 5m, 3:00 on 10m)
export const CRITICAL_THRESHOLD = 0.10; // 10% (30s on 5m, 60s on 10m)
export const TOTAL_PIPS = 5;
export const OPENAI_CACHE_MIN_INPUT_TOKENS = 1024;
export const FOOTER_PATCHED_KEY = Symbol.for("rbf.cacheGuardian.footerPatched");
export const ORIGINAL_FOOTER_RENDER_KEY = Symbol.for("rbf.cacheGuardian.originalFooterRender");

export type GuardianThreshold = "calm" | "warning" | "critical" | "elapsed";

export interface PendingRequest {
	epoch: number;
	turnIndex: number;
	sequence: number;
	startedAt: number;
	responseStatus: number | null;
}

export interface ActiveGuardianState {
	remainingMs: number;
	totalTtlMs: number;
	tokens: number;
}

const FALLBACK_THEME = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};

export function getActiveTheme(): any {
	return (
		(typeof globalThis !== "undefined"
			? (globalThis as any)[Symbol.for("@earendil-works/pi-coding-agent:theme")] ??
				(globalThis as any)[Symbol.for("@mariozechner/pi-coding-agent:theme")]
			: undefined) ?? FALLBACK_THEME
	);
}

export const GUARDIAN_STATE_KEY = Symbol.for("rbf.cacheGuardian.activeState");
export const GUARDIAN_GET_CONTENT_KEY = Symbol.for("rbf.cacheGuardian.getActiveContent");

export function getActiveGuardianState(): ActiveGuardianState | null {
	return (globalThis as any)[GUARDIAN_STATE_KEY] ?? null;
}

export function setActiveGuardianState(state: ActiveGuardianState | null): void {
	if (state === null) {
		delete (globalThis as any)[GUARDIAN_STATE_KEY];
	} else {
		(globalThis as any)[GUARDIAN_STATE_KEY] = state;
	}
}

export function formatCountdown(ms: number, format: "minute" | "exact" = "minute"): string {
	const totalSec = Math.max(0, Math.floor(ms / 1000));
	if (format === "exact") {
		const m = Math.floor(totalSec / 60);
		const s = totalSec % 60;
		return `${m}:${s.toString().padStart(2, "0")}`;
	}
	if (totalSec <= 0) {
		return "0m";
	}
	if (totalSec >= 60) {
		const m = Math.ceil(totalSec / 60);
		return `${m}m`;
	}
	return `${totalSec}s`;
}

export function formatTokens(count: number): string {
	if (count >= 1_000_000) {
		return `${(count / 1_000_000).toFixed(1)}m`;
	}
	if (count >= 1_000) {
		return `${(count / 1_000).toFixed(1)}k`;
	}
	return String(count);
}

export function parseTtlValue(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		// If small (<= 120), assume minutes, otherwise milliseconds
		return value <= 120 ? Math.round(value * 60_000) : Math.round(value);
	}
	if (typeof value === "string") {
		const trimmed = value.trim().toLowerCase();
		const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/);
		if (match) {
			const num = parseFloat(match[1]);
			const unit = match[2] || "m";
			switch (unit) {
				case "ms":
					return Math.round(num);
				case "s":
					return Math.round(num * 1000);
				case "m":
					return Math.round(num * 60_000);
				case "h":
					return Math.round(num * 3_600_000);
			}
		}
	}
	return null;
}

export function formatNotificationTime(ms: number): string {
	const sec = Math.max(1, Math.round(ms / 1000));
	if (sec >= 120 && sec % 60 === 0) {
		return `${Math.round(sec / 60)}m`;
	}
	return `${sec}s`;
}

export function getSettingsPaths(cwd?: string): string[] {
	const paths: string[] = [];
	if (cwd) {
		paths.push(join(cwd, ".pi", "settings.json"));
	}
	const agentDir = process.env.PI_AGENT_DIR || join(homedir(), ".pi", "agent");
	paths.push(join(agentDir, "settings.json"));
	return paths;
}

export function loadMergedSettings(cwd?: string): Record<string, any> {
	let merged: Record<string, any> = {};
	const paths = getSettingsPaths(cwd);
	// Global first, then local project overrides
	for (let i = paths.length - 1; i >= 0; i--) {
		const p = paths[i];
		try {
			if (existsSync(p)) {
				const content = readFileSync(p, "utf-8");
				const parsed = JSON.parse(content);
				if (parsed && typeof parsed === "object") {
					merged = { ...merged, ...parsed };
				}
			}
		} catch {
			// Fall back gracefully if unreadable or invalid JSON
		}
	}
	return merged;
}

export function resolveCacheTtlMs(
	provider: string | undefined,
	modelId?: string,
	settings?: Record<string, any>,
	env: Record<string, string | undefined> = process.env,
): number | null {
	if (!provider) {
		return null;
	}
	if (provider === "anthropic" && env.PI_CACHE_RETENTION === "long") {
		return null;
	}

	const config = settings?.cacheTtl ?? settings?.cacheTtlMinutes ?? settings?.cacheTtlMs;
	if (config !== undefined && config !== null) {
		if (typeof config === "object") {
			const modelKey = modelId ? `${provider}/${modelId}` : undefined;
			if (modelKey && modelKey in config) {
				const parsed = parseTtlValue(config[modelKey]);
				if (parsed !== null) return parsed;
			}
			if (provider in config) {
				const parsed = parseTtlValue(config[provider]);
				if (parsed !== null) return parsed;
			}
		} else {
			const parsed = parseTtlValue(config);
			if (parsed !== null) return parsed;
		}
	}

	return DEFAULT_PROVIDER_TTL_MS[provider] ?? null;
}

export function renderProgressBar(remainingMs: number, totalTtlMs: number, totalPips = TOTAL_PIPS): string {
	if (totalTtlMs <= 0 || remainingMs <= 0) {
		return `[${"░".repeat(totalPips)}]`;
	}
	const ratio = Math.max(0, Math.min(1, remainingMs / totalTtlMs));
	const filled = ratio >= 1 ? totalPips : Math.max(0, Math.min(totalPips, Math.floor(ratio * totalPips)));
	const empty = totalPips - filled;
	return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}

export function getGuardianThreshold(remainingMs: number, totalTtlMs: number): GuardianThreshold {
	if (remainingMs <= 0) {
		return "elapsed";
	}
	const fraction = remainingMs / totalTtlMs;
	if (fraction <= CRITICAL_THRESHOLD) {
		return "critical";
	}
	if (fraction <= WARNING_THRESHOLD) {
		return "warning";
	}
	return "calm";
}

export function isSupportedProvider(
	provider: string | undefined,
	env: Record<string, string | undefined> = process.env,
	settings?: Record<string, any>,
	modelId?: string,
): boolean {
	return resolveCacheTtlMs(provider, modelId, settings, env) !== null;
}

export function renderGuardianWidgetContent(
	remainingMs: number,
	totalTtlMs: number,
	tokens: number,
	theme: { fg: (color: any, text: string) => string },
): string {
	const threshold = getGuardianThreshold(remainingMs, totalTtlMs);

	if (threshold === "elapsed") {
		const dimPrefix = theme.fg("dim", "new task? ");
		const clearCmd = theme.fg("accent", "/clear");
		const dimMid = theme.fg("dim", " to save ");
		const tokenPart = theme.fg("accent", `${formatTokens(tokens)} tokens`);
		return `${dimPrefix}${clearCmd}${dimMid}${tokenPart}`;
	}

	const countdown = formatCountdown(remainingMs);
	const bar = renderProgressBar(remainingMs, totalTtlMs);
	const tokensFormatted = `${formatTokens(tokens)} cached`;

	if (threshold === "calm") {
		const raw = `${countdown} TTL ${bar} ${tokensFormatted}`;
		return theme.fg("muted", raw);
	}

	if (threshold === "warning") {
		const raw = `⚠️ ${countdown} TTL ${bar} ${tokensFormatted}`;
		return theme.fg("warning", raw);
	}

	const raw = `🚨 ${countdown} TTL ${bar} ${tokensFormatted}`;
	return theme.fg("error", raw);
}

export function getNextTickDelayMs(
	remainingMs: number,
	totalTtlMs: number,
	warnedAtCritical: boolean,
): number {
	if (remainingMs <= 0) {
		return 0;
	}
	const criticalMs = totalTtlMs * CRITICAL_THRESHOLD;
	if (!warnedAtCritical && remainingMs > criticalMs) {
		const msUntilCritical = remainingMs - criticalMs;
		if (msUntilCritical < 60_000) {
			return Math.max(1_000, msUntilCritical);
		}
	}
	if (remainingMs < 60_000) {
		return Math.max(1_000, remainingMs);
	}
	return 60_000;
}

export function formatFooterPwdLineWithGuardian(
	pwdLine: string,
	guardianContent: string,
	width: number,
	theme?: { fg: (color: any, text: string) => string },
): string {
	if (!guardianContent) {
		return pwdLine;
	}
	if (pwdLine.endsWith(guardianContent)) {
		return pwdLine;
	}

	const leftWidth = visibleWidth(pwdLine);
	const rightWidth = visibleWidth(guardianContent);
	const minPadding = 2;

	if (leftWidth + minPadding + rightWidth <= width) {
		const pad = " ".repeat(Math.max(minPadding, width - leftWidth - rightWidth));
		return pwdLine + pad + guardianContent;
	}

	const availableForLeft = width - rightWidth - minPadding;
	if (availableForLeft >= 8) {
		const ellipsis = theme?.fg ? theme.fg("dim", "...") : "...";
		const truncatedLeft = truncateToWidth(pwdLine, availableForLeft, ellipsis);
		const pad = " ".repeat(Math.max(minPadding, width - visibleWidth(truncatedLeft) - rightWidth));
		return truncatedLeft + pad + guardianContent;
	}

	if (width >= rightWidth) {
		return guardianContent;
	}
	return truncateToWidth(guardianContent, width, "");
}

export function patchFooterComponent(): boolean {
	if (typeof FooterComponent === "undefined" || !FooterComponent.prototype) {
		return false;
	}

	(FooterComponent.prototype as any)[GUARDIAN_GET_CONTENT_KEY] = function (this: any): string {
		const state = getActiveGuardianState();
		if (!state) return "";
		const theme = this.session?.theme ?? getActiveTheme();
		return renderGuardianWidgetContent(
			state.remainingMs,
			state.totalTtlMs,
			state.tokens,
			theme,
		);
	};

	if ((FooterComponent.prototype as any)[FOOTER_PATCHED_KEY]) {
		return true;
	}

	const originalRender = FooterComponent.prototype.render;
	(FooterComponent.prototype as any)[ORIGINAL_FOOTER_RENDER_KEY] = originalRender;
	(FooterComponent.prototype as any)[FOOTER_PATCHED_KEY] = true;

	FooterComponent.prototype.render = function (this: any, width: number): string[] {
		const lines = originalRender.call(this, width);
		const state = getActiveGuardianState();
		if (state && lines && lines.length > 0) {
			const theme = this.session?.theme ?? getActiveTheme();
			const guardianContent = renderGuardianWidgetContent(
				state.remainingMs,
				state.totalTtlMs,
				state.tokens,
				theme,
			);
			lines[0] = formatFooterPwdLineWithGuardian(lines[0], guardianContent, width, theme);
		}
		return lines;
	};

	return true;
}

export function unpatchFooterComponent(): void {
	if (typeof FooterComponent === "undefined" || !FooterComponent.prototype) {
		return;
	}
	setActiveGuardianState(null);
	if ((FooterComponent.prototype as any)[FOOTER_PATCHED_KEY]) {
		const originalRender = (FooterComponent.prototype as any)[ORIGINAL_FOOTER_RENDER_KEY];
		if (originalRender) {
			FooterComponent.prototype.render = originalRender;
		}
		delete (FooterComponent.prototype as any)[ORIGINAL_FOOTER_RENDER_KEY];
		delete (FooterComponent.prototype as any)[FOOTER_PATCHED_KEY];
		delete (FooterComponent.prototype as any)[GUARDIAN_GET_CONTENT_KEY];
	}
}

export function triggerFooterRerender(ctx?: ExtensionContext): void {
	if (!ctx?.ui) return;
	try {
		ctx.ui.setWidget?.(WIDGET_KEY, undefined);
	} catch {
		// Ignore if ui or setWidget is unavailable
	}
}

export default function rbfCacheGuardian(pi: ExtensionAPI): void {
	patchFooterComponent();

	let epoch = 0;
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	let deadlineAt: number | null = null;
	let totalTtlMs = DEFAULT_ANTHROPIC_TTL_MS;
	let lastCachedTokens: number | null = null;
	let warnedAtCritical = false;
	let previousRemainingMs: number | null = null;
	let activeTurnIndex: number | null = null;
	let requestSequence = 0;
	let pendingRequest: PendingRequest | null = null;
	let correlationUnsafe = false;

	function clearTimers(): void {
		if (timeoutId !== undefined) {
			clearTimeout(timeoutId);
			timeoutId = undefined;
		}
	}

	function resetLifecycleState(ctx?: ExtensionContext): void {
		epoch++;
		clearTimers();
		deadlineAt = null;
		lastCachedTokens = null;
		warnedAtCritical = false;
		previousRemainingMs = null;
		activeTurnIndex = null;
		pendingRequest = null;
		correlationUnsafe = false;
		setActiveGuardianState(null);
		triggerFooterRerender(ctx);
	}

	pi.on("agent_start", (_event: AgentStartEvent, ctx: ExtensionContext) => {
		correlationUnsafe = false;
		clearTimers();
		setActiveGuardianState(null);
		triggerFooterRerender(ctx);
	});

	pi.on("turn_start", (event: TurnStartEvent) => {
		if (pendingRequest !== null) {
			correlationUnsafe = true;
			pendingRequest = null;
		}
		activeTurnIndex = event.turnIndex;
	});

	pi.on("before_provider_request", (_event: BeforeProviderRequestEvent) => {
		if (activeTurnIndex === null) {
			return;
		}
		if (pendingRequest !== null) {
			correlationUnsafe = true;
			pendingRequest = null;
			return;
		}
		requestSequence++;
		pendingRequest = {
			epoch,
			turnIndex: activeTurnIndex,
			sequence: requestSequence,
			startedAt: Date.now(),
			responseStatus: null,
		};
	});

	pi.on("after_provider_response", (event: AfterProviderResponseEvent) => {
		if (pendingRequest !== null && pendingRequest.epoch === epoch) {
			pendingRequest.responseStatus = event.status;
		}
	});

	pi.on("turn_end", (event: TurnEndEvent, ctx: ExtensionContext) => {
		if (
			correlationUnsafe ||
			pendingRequest === null ||
			pendingRequest.epoch !== epoch ||
			pendingRequest.turnIndex !== event.turnIndex
		) {
			pendingRequest = null;
			return;
		}

		const candidate = pendingRequest;
		pendingRequest = null;

		if (event.message.role !== "assistant") {
			return;
		}

		// When using HTTP SSE, responseStatus is populated via after_provider_response.
		// When using WebSocket transport (e.g. openai-codex), after_provider_response is not emitted,
		// leaving responseStatus as null. In that case, we rely on the assistant message stopReason.
		if (
			(candidate.responseStatus !== null &&
				(candidate.responseStatus < 200 || candidate.responseStatus >= 300)) ||
			event.message.stopReason === "error" ||
			event.message.stopReason === "aborted"
		) {
			return;
		}

		const provider = ctx.model?.provider;
		const modelId = ctx.model?.id;
		const settings = loadMergedSettings(ctx.cwd);
		const resolvedTtl = resolveCacheTtlMs(provider, modelId, settings);
		if (resolvedTtl === null) {
			return;
		}

		const usage = event.message.usage;
		const cacheRead = usage?.cacheRead ?? 0;
		const cacheWrite = usage?.cacheWrite ?? 0;
		let cached = cacheRead + cacheWrite;

		// On OpenAI / Codex turn 1, cache writes are not explicitly reported in usage,
		// but OpenAI automatically caches prompt prefixes >= 1024 tokens.
		if (cached <= 0 && (provider === "openai-codex" || provider === "openai")) {
			const inputTokens = usage?.input ?? 0;
			if (inputTokens >= OPENAI_CACHE_MIN_INPUT_TOKENS) {
				cached = inputTokens;
			}
		}

		if (cached <= 0) {
			return;
		}

		lastCachedTokens = cached;
		totalTtlMs = resolvedTtl;
		deadlineAt = candidate.startedAt + totalTtlMs;
		warnedAtCritical = false;
		previousRemainingMs = deadlineAt - Date.now();
	});

	pi.on("agent_settled", (_event: AgentSettledEvent, ctx: ExtensionContext) => {
		if (deadlineAt === null || lastCachedTokens === null) {
			return;
		}

		const currentEpoch = epoch;
		clearTimers();

		const tick = () => {
			if (epoch !== currentEpoch || deadlineAt === null || lastCachedTokens === null) {
				clearTimers();
				setActiveGuardianState(null);
				triggerFooterRerender(ctx);
				return;
			}

			const now = Date.now();
			const remainingMs = Math.max(0, deadlineAt - now);

			// Critical notification transition (<= 10%)
			if (0 < remainingMs && remainingMs <= totalTtlMs * CRITICAL_THRESHOLD && !warnedAtCritical) {
				if (previousRemainingMs !== null && previousRemainingMs > 0) {
					warnedAtCritical = true;
					const tokenSummary = formatTokens(lastCachedTokens);
					const alertTime = formatNotificationTime(totalTtlMs * CRITICAL_THRESHOLD);
					const alertMsg = `Prompt cache guarantee ends in ${alertTime} · ${tokenSummary} cached`;
					ctx.ui?.notify?.(alertMsg, "warning");

					const script = `display notification "${alertMsg}" with title "Pi Cache Guardian" sound name "Ping"`;
					pi.exec("/usr/bin/osascript", ["-e", script]).catch(() => {
						try {
							process.stderr.write("\x07");
						} catch {
							// Terminal bell fallback ignored if unavailable
						}
					});
				}
			} else if (remainingMs <= 0) {
				warnedAtCritical = true;
			}

			previousRemainingMs = remainingMs;

			setActiveGuardianState({
				remainingMs,
				totalTtlMs,
				tokens: lastCachedTokens,
			});

			triggerFooterRerender(ctx);

			if (remainingMs <= 0) {
				clearTimers();
				return;
			}

			const nextDelay = getNextTickDelayMs(remainingMs, totalTtlMs, warnedAtCritical);
			if (nextDelay > 0) {
				timeoutId = setTimeout(tick, nextDelay);
			}
		};

		tick();
	});

	const onSessionInvalidate = (_event: unknown, ctx: ExtensionContext) => {
		resetLifecycleState(ctx);
	};

	pi.on("input", onSessionInvalidate);
	pi.on("session_shutdown", onSessionInvalidate);
	pi.on("session_tree", onSessionInvalidate);
	pi.on("session_compact", onSessionInvalidate);
	pi.on("model_select", onSessionInvalidate);
	pi.on("thinking_level_select", onSessionInvalidate);
}
