import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const PRODUCTION_FILES = [
	"authority-digest.ts",
	"broker-client.ts",
	"broker-rpc.ts",
	"broker.mjs",
	"index.ts",
	"integrity.ts",
	"launch-authority.ts",
	"lifecycle.ts",
	"policy.ts",
	"preflight.ts",
	"state.ts",
	"tool-operations.ts",
	"tools.ts",
] as const;

export function digestPackage(packageRoot: string): string {
	const hash = createHash("sha256");
	for (const name of PRODUCTION_FILES) {
		hash.update(name, "utf8");
		hash.update("\0");
		hash.update(readFileSync(path.join(packageRoot, name)));
		hash.update("\0");
	}
	return hash.digest("hex");
}

export function assertPackageIntegrity(packageRoot: string, expectedDigest: string): void {
	if (digestPackage(packageRoot) !== expectedDigest) throw new Error("Sandbox package changed; restart Pi");
}
