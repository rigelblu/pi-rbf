import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { parseArgs } from "@earendil-works/pi-coding-agent";

export interface LaunchAuthority {
	readonly argvDigest: string;
	readonly cliEntry: string;
	readonly sandboxRequested: boolean;
}

export function deriveLaunchAuthority(argv: readonly string[]): LaunchAuthority {
	if (argv.length < 2) throw new Error("Sandbox requires the Pi CLI entrypoint");

	const cliEntry = realpathSync(argv[1]);
	if (!cliEntry.endsWith("/dist/cli.js") && !cliEntry.endsWith("/dist/bundle/cli.js")) {
		throw new Error("Sandbox supports only the canonical Pi CLI");
	}

	const args = [...argv.slice(2)];
	const parsed = parseArgs(args);
	return Object.freeze({
		argvDigest: createHash("sha256").update(JSON.stringify(args)).digest("hex"),
		cliEntry,
		sandboxRequested: parsed.unknownFlags.has("sandbox"),
	});
}
