export type RuntimeLifecycle = "clean" | "active" | "resetting" | "dirty";

export interface LifecycleSentinel {
	authorityDigest?: string;
	authorityRoot?: string;
	readonly argvDigest: string;
	readonly packageIdentity: string;
	readonly sandboxRequested: true;
	state: RuntimeLifecycle;
}

const SENTINEL_KEY = Symbol.for("rbf.sandbox.lifecycle.v1");

type GlobalWithSentinel = typeof globalThis & { [SENTINEL_KEY]?: LifecycleSentinel };

export function acquireLifecycleSentinel(identity: {
	readonly argvDigest: string;
	readonly packageIdentity: string;
	readonly sandboxRequested: boolean;
}): LifecycleSentinel | undefined {
	if (!identity.sandboxRequested) return undefined;
	const host = globalThis as GlobalWithSentinel;
	const existing = host[SENTINEL_KEY];
	if (existing) {
		if (existing.argvDigest !== identity.argvDigest || existing.packageIdentity !== identity.packageIdentity) {
			existing.state = "dirty";
		}
		return existing;
	}
	const sentinel: LifecycleSentinel = {
		argvDigest: identity.argvDigest,
		packageIdentity: identity.packageIdentity,
		sandboxRequested: true,
		state: "clean",
	};
	host[SENTINEL_KEY] = sentinel;
	return sentinel;
}

export function setAuthorityRoot(sentinel: LifecycleSentinel, authorityRoot: string): string {
	if (sentinel.authorityRoot && sentinel.authorityRoot !== authorityRoot) {
		sentinel.state = "dirty";
		throw new Error("Sandbox authority root changed; restart");
	}
	sentinel.authorityRoot ??= authorityRoot;
	return sentinel.authorityRoot;
}

export function beginActivation(sentinel: LifecycleSentinel, authorityDigest: string): void {
	if (sentinel.state !== "clean") throw new Error("Sandbox runtime was not reset cleanly; restart");
	if (sentinel.authorityDigest && sentinel.authorityDigest !== authorityDigest) {
		sentinel.state = "dirty";
		throw new Error("Sandbox policy changed; restart");
	}
	sentinel.authorityDigest ??= authorityDigest;
}

export function markActive(sentinel: LifecycleSentinel): void {
	if (sentinel.state !== "clean") throw new Error("Sandbox cannot activate from an unclean lifecycle");
	sentinel.state = "active";
}

export function beginReset(sentinel: LifecycleSentinel): void {
	if (sentinel.state !== "active") {
		sentinel.state = "dirty";
		throw new Error("Sandbox reset started from an unexpected state");
	}
	sentinel.state = "resetting";
}

export function finishReset(sentinel: LifecycleSentinel): void {
	if (sentinel.state !== "resetting") {
		sentinel.state = "dirty";
		throw new Error("Sandbox reset completion was uncertain");
	}
	sentinel.state = "clean";
}

export function markDirty(sentinel: LifecycleSentinel): void {
	sentinel.state = "dirty";
}
