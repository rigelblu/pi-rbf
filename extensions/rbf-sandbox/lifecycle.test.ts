import { afterEach, describe, expect, test } from "vitest";
import {
	acquireLifecycleSentinel,
	beginActivation,
	beginReset,
	finishReset,
	markActive,
	type LifecycleSentinel,
} from "./lifecycle.js";

const key = Symbol.for("rbf.sandbox.lifecycle.v1");

afterEach(() => {
	delete (globalThis as Record<symbol, unknown>)[key];
});

function sentinel(): LifecycleSentinel {
	return { argvDigest: "argv", packageIdentity: "package", sandboxRequested: true, state: "clean" };
}

describe("lifecycle sentinel", () => {
	test("persists launch identity across extension instances", () => {
		const first = acquireLifecycleSentinel({ argvDigest: "argv", packageIdentity: "package", sandboxRequested: true });
		const second = acquireLifecycleSentinel({ argvDigest: "argv", packageIdentity: "package", sandboxRequested: true });
		expect(second).toBe(first);
	});

	test("keeps the replacement guard alive but marks identity changes dirty", () => {
		acquireLifecycleSentinel({ argvDigest: "argv", packageIdentity: "package", sandboxRequested: true });
		const changed = acquireLifecycleSentinel({ argvDigest: "changed", packageIdentity: "package", sandboxRequested: true });
		expect(changed?.state).toBe("dirty");
	});

	test("fixes authority on first activation and admits equal re-entry", () => {
		const value = sentinel();
		beginActivation(value, "policy");
		markActive(value);
		beginReset(value);
		finishReset(value);
		beginActivation(value, "policy");
		expect(value.state).toBe("clean");
	});

	test("makes a changed authority digest dirty", () => {
		const value = sentinel();
		beginActivation(value, "policy");
		markActive(value);
		beginReset(value);
		finishReset(value);
		expect(() => beginActivation(value, "changed")).toThrow("policy changed");
		expect(value.state).toBe("dirty");
	});
});
