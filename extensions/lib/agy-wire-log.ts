// An opt-in message log for the AGY route. RBF_AGY_WIRE_LOG=1 makes the provider append one JSON line per event, with a time in ms, to `<Pi agent dir>/rbf-agy-wire.jsonl`.
// It exists so the next time a permission answer goes missing, the log says where it went. It holds names, ids and states only: never the text AGY wrote, its thinking, a command, or a command's output.
// Without the variable nothing is read, created or written.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const WIRE_LOG_VARIABLE = "RBF_AGY_WIRE_LOG";
export const WIRE_LOG_FILE = "rbf-agy-wire.jsonl";
/** `in`: a frame AGY sent. `out`: a frame Pi sent. `q`: the approval queue. `dlg`: the approval dialog. `rec`: a record saved to Pi's session. */
export type WireEvent = "in" | "out" | "q" | "dlg" | "rec";
type WireValue = string | number | boolean | null | undefined;
const FIELD_MAX_CHARS = 160;

export const wireLogOn = (): boolean => process.env[WIRE_LOG_VARIABLE] === "1";

export function wireLogPath(): string {
	return join(getAgentDir(), WIRE_LOG_FILE);
}

/** The one place a value is cut to a safe size. A field is a scalar: anything else is dropped, so an object holding text cannot get in. */
function scalar(value: unknown): WireValue {
	if (typeof value === "string") return value.length > FIELD_MAX_CHARS ? value.slice(0, FIELD_MAX_CHARS) + "…" : value;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "boolean" || value === null) return value;
	return undefined;
}

/** Appends one line when the log is on. A log that cannot be written never breaks the provider. */
export function wireLog(ev: WireEvent, fields: Record<string, unknown>): void {
	if (!wireLogOn()) return;
	try {
		const line: Record<string, WireValue> = { t: Date.now(), ev };
		for (const [key, value] of Object.entries(fields)) {
			const clean = scalar(value);
			if (clean !== undefined) line[key] = clean;
		}
		const file = wireLogPath(), text = JSON.stringify(line) + "\n";
		try { appendFileSync(file, text); }
		catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
			mkdirSync(dirname(file), { recursive: true });
			appendFileSync(file, text);
		}
	} catch { /* the log is a help, not a part of the work */ }
}
