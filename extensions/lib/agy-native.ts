// The AGY pieces the ACP route shares: the bounds it uses, the executable and Pi-version floor, version parsing,
// the clean-stop outcome type, and the display sanitizer.
export interface ControllerTracer { record(event: string, payload: Record<string, unknown>): void }
export const BOUNDS = {
	MAX_PROMPT_BYTES: 256 * 1024,
	MAX_FRAME_BYTES: 1024 * 1024,
	IDLE_CLOSE_GRACE_MS: 2_000,
	SIGTERM_GRACE_MS: 1_000,
	PIPE_DRAIN_MS: 1_000,
	SETTLEMENT_DEADLINE_MS: 15_000,
} as const;


export const AGY_EXECUTABLE = "/Users/tomhosiawa/.local/bin/agy";
export const MIN_PI_VERSION = "1.4.0";
export interface CleanupOutcome {
	classification: "not-started" | "clean" | "verified-interrupted" | "stop-unverified";
	retirement: "complete" | "unknown" | "expired";
}

type Version = readonly [number,number,number];
export function parseVersion(text: unknown): Version | null {
	if (typeof text !== "string") return null;
	const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function versionAtLeast(version: Version, floor: Version): boolean {
	for (let i = 0; i < 3; i++) {
		if (version[i]! !== floor[i]!) return version[i]! > floor[i]!;
	}
	return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Display Sanitizer
// ─────────────────────────────────────────────────────────────────────────────

function createDisplaySanitizer() {
	let state: "ground" | "escape" | "csi" | "osc" | "string" = "ground";
	let sawEscape = false, marked = false;
	let escapeBytes = 0, highSurrogate = "";
	const marker = "[control sequence removed]";
	function start(next: typeof state, bytes: number): void {
		state = next; sawEscape = false; marked = false; escapeBytes = bytes;
	}
	function ground(): void { state = "ground"; sawEscape = false; marked = false; escapeBytes = 0; }
	return {
		feed(raw: string): string {
			let output = "";
			let text = highSurrogate + raw;
			highSurrogate = "";
			let offset = 0;
			for (const character of text) {
				offset += character.length;
				const code = character.codePointAt(0)!;
				if (state !== "ground") {
					const bytes = Buffer.byteLength(character, "utf8");
					if (bytes > 4096 - escapeBytes) {
						if (!marked) { output += marker; marked = true; }
						escapeBytes = 4096;
					} else escapeBytes += bytes;
					if (state === "osc" || state === "string") {
						if (code === 0x9c || (state === "osc" && code === 7) || (sawEscape && character === "\\")) { ground(); continue; }
						sawEscape = code === 0x1b;
						continue;
					}
					if (code === 0x1b) { state = "escape"; continue; }
					if (state === "csi") {
						if (code >= 0x40 && code <= 0x7e) ground();
						continue;
					}
					if (character === "[") { state = "csi"; continue; }
					if (character === "]") { state = "osc"; continue; }
					if (["P", "X", "^", "_"].includes(character)) { state = "string"; continue; }
					if (code >= 0x20 && code <= 0x2f) continue;
					ground();
					if (code >= 0x30 && code <= 0x7e) continue;
				}
				if (code === 0x1b) { start("escape", 1); continue; }
				if (code === 0x9b) { start("csi", 2); continue; }
				if (code === 0x9d) { start("osc", 2); continue; }
				if ([0x90, 0x98, 0x9e, 0x9f].includes(code)) { start("string", 2); continue; }
				if ((code < 0x20 && code !== 9 && code !== 10) || (code >= 0x7f && code <= 0x9f) ||
					code === 0x061c || code === 0x200e || code === 0x200f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) continue;
				if (code >= 0xd800 && code <= 0xdbff && offset === text.length) { highSurrogate = character; continue; }
				output += code >= 0xd800 && code <= 0xdfff ? "\ufffd" : character;
			}
			return output;
		},
		finish(): string {
			const output = (highSurrogate ? "\ufffd" : "") + (state !== "ground" && !marked ? marker : "");
			highSurrogate = ""; ground(); return output;
		},
	};
}

export function sanitizeDisplayText(raw: string): string {
	const sanitizer = createDisplaySanitizer();
	return sanitizer.feed(raw) + sanitizer.finish();
}
