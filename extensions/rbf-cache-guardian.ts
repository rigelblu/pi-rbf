import type {
	AgentSettledEvent,
	AgentStartEvent,
	BeforeProviderRequestEvent,
	ExtensionAPI,
	ExtensionContext,
	TurnEndEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";

export interface AfterProviderResponseEvent {
	type?: "after_provider_response";
	status: number;
	headers?: Record<string, string>;
}

export const WIDGET_KEY = "rbf-cache-guardian";
export const DEFAULT_ANTHROPIC_TTL_MS = 300_000; // 5 minutes
export const WARNING_THRESHOLD = 0.30; // 30% (1:30 remaining on 5m)
export const CRITICAL_THRESHOLD = 0.10; // 10% (30s remaining on 5m)
export const TOTAL_PIPS = 10;

export type GuardianThreshold = "calm" | "warning" | "critical" | "elapsed";

export interface PendingRequest {
	epoch: number;
	turnIndex: number;
	sequence: number;
	startedAt: number;
	responseStatus: number | null;
}

export function formatCountdown(ms: number): string {
	const totalSec = Math.max(0, Math.floor(ms / 1000));
	const m = Math.floor(totalSec / 60);
	const s = totalSec % 60;
	return `${m}:${s.toString().padStart(2, "0")}`;
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
): boolean {
	if (provider !== "anthropic") {
		return false;
	}
	if (env.PI_CACHE_RETENTION === "long") {
		return false;
	}
	return true;
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

export default function rbfCacheGuardian(pi: ExtensionAPI): void {
	let epoch = 0;
	let intervalId: ReturnType<typeof setInterval> | undefined;
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
		if (intervalId !== undefined) {
			clearInterval(intervalId);
			intervalId = undefined;
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
		ctx?.ui?.setWidget?.(WIDGET_KEY, undefined);
	}

	pi.on("agent_start", (_event: AgentStartEvent, ctx: ExtensionContext) => {
		correlationUnsafe = false;
		clearTimers();
		ctx.ui?.setWidget?.(WIDGET_KEY, undefined);
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

		if (
			candidate.responseStatus === null ||
			candidate.responseStatus < 200 ||
			candidate.responseStatus >= 300
		) {
			return;
		}

		if (event.message.role !== "assistant") {
			return;
		}

		if (!isSupportedProvider(ctx.model?.provider)) {
			return;
		}

		const usage = event.message.usage;
		const cacheRead = usage?.cacheRead ?? 0;
		const cacheWrite = usage?.cacheWrite ?? 0;
		const cached = cacheRead + cacheWrite;
		if (cached <= 0) {
			return;
		}

		lastCachedTokens = cached;
		totalTtlMs = DEFAULT_ANTHROPIC_TTL_MS;
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
				return;
			}

			const now = Date.now();
			const remainingMs = Math.max(0, deadlineAt - now);

			// Critical notification transition (<= 10%, 30s on 5m)
			if (0 < remainingMs && remainingMs <= totalTtlMs * CRITICAL_THRESHOLD && !warnedAtCritical) {
				if (previousRemainingMs !== null && previousRemainingMs > 0) {
					warnedAtCritical = true;
					const tokenSummary = formatTokens(lastCachedTokens);
					ctx.ui?.notify?.(`Prompt cache guarantee ends in 30s · ${tokenSummary} cached`, "warning");

					const script = `display notification "Prompt cache guarantee ends in 30s · ${tokenSummary} cached" with title "Pi Cache Guardian" sound name "Ping"`;
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

			const theme = ctx.ui?.theme ?? { fg: (_c: string, text: string) => text };
			const widgetLine = renderGuardianWidgetContent(remainingMs, totalTtlMs, lastCachedTokens, theme);
			ctx.ui?.setWidget?.(WIDGET_KEY, [widgetLine], { placement: "belowEditor" });

			if (remainingMs <= 0) {
				clearTimers();
			}
		};

		tick();
		const remainingMsNow = Math.max(0, deadlineAt - Date.now());
		if (remainingMsNow > 0) {
			intervalId = setInterval(tick, 1000);
		}
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
