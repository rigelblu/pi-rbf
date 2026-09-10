import { createHash } from "node:crypto";

export interface AuthorityDigestV1 {
	readonly admittedToolSourcesAndDigests: Readonly<Record<string, string>>;
	readonly authorityRoot: string;
	readonly environmentNamesAndLaunchValues: Readonly<Record<string, string>>;
	readonly protectedPaths: readonly string[];
	readonly readRoots: readonly string[];
	readonly runtimeRoots: readonly string[];
	readonly srtConfig: Readonly<Record<string, unknown>>;
	readonly version: 1;
	readonly versions: Readonly<Record<string, string>>;
	readonly workspace: string;
	readonly writeRoots: readonly string[];
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) {
		return [...new Set(value.map((item) => String(item)))].sort();
	}
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, canonicalize(child)]),
		);
	}
	return value;
}

export function digestAuthority(authority: AuthorityDigestV1): string {
	const canonicalJson = JSON.stringify(canonicalize(authority));
	return createHash("sha256").update(canonicalJson, "utf8").digest("hex");
}
