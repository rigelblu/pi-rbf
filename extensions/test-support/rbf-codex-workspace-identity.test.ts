import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	deriveWorkspaceIdentity,
	workspaceIdentitiesEqual,
	type WorkspaceIdentityOperations,
} from "./rbf-codex-workspace-identity.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
	const value = mkdtempSync(path.join(tmpdir(), "rbf-codex-workspace-"));
	roots.push(value);
	return value;
}

function syntheticOperations(
	physicalPath: string,
	dev: bigint,
	ino: bigint,
	isDirectory = true,
): WorkspaceIdentityOperations {
	return {
		realpathNative: () => physicalPath,
		accessReadable: () => undefined,
		statBigInt: () => ({ dev, ino, isDirectory: () => isDirectory }),
	};
}

describe("rbf-codex workspace identity", () => {
	it("treats a direct path and symlink alias as one physical workspace", () => {
		const base = root();
		const workspace = path.join(base, "workspace");
		const alias = path.join(base, "alias");
		mkdirSync(workspace);
		symlinkSync(workspace, alias);

		expect(workspaceIdentitiesEqual(deriveWorkspaceIdentity(workspace), deriveWorkspaceIdentity(alias))).toBe(true);
	});

	it("keeps genuinely distinct directories distinct", () => {
		const base = root();
		const left = path.join(base, "left");
		const right = path.join(base, "right");
		mkdirSync(left);
		mkdirSync(right);

		expect(workspaceIdentitiesEqual(deriveWorkspaceIdentity(left), deriveWorkspaceIdentity(right))).toBe(false);
	});

	it("preserves identifiers above Number.MAX_SAFE_INTEGER without number conversion", () => {
		const dev = BigInt(Number.MAX_SAFE_INTEGER) + 41n;
		const ino = BigInt(Number.MAX_SAFE_INTEGER) + 97n;
		const identity = deriveWorkspaceIdentity("/synthetic", syntheticOperations("/synthetic", dev, ino));

		expect(identity.deviceDecimal).toBe(dev.toString(10));
		expect(identity.inodeDecimal).toBe(ino.toString(10));
	});

	it("normalizes only the native realpath spelling and still requires inode equality", () => {
		const decomposed = "/tmp/Cafe\u0301";
		const composed = "/tmp/Caf\u00e9";
		const left = deriveWorkspaceIdentity("/left", syntheticOperations(decomposed, 1n, 2n));
		const alias = deriveWorkspaceIdentity("/right", syntheticOperations(composed, 1n, 2n));
		const collision = deriveWorkspaceIdentity("/other", syntheticOperations(composed, 1n, 3n));

		expect(left.physicalPathNfc).toBe(composed);
		expect(workspaceIdentitiesEqual(left, alias)).toBe(true);
		expect(workspaceIdentitiesEqual(left, collision)).toBe(false);
	});

	it("rejects an NFC spelling that resolves to a different inode in one derivation", () => {
		const decomposed = "/tmp/Cafe\u0301";
		const composed = "/tmp/Caf\u00e9";
		const operations: WorkspaceIdentityOperations = {
			realpathNative: () => decomposed,
			accessReadable: () => undefined,
			statBigInt: (input) => ({ dev: 1n, ino: input === decomposed ? 2n : 3n, isDirectory: () => true }),
		};

		expect(() => deriveWorkspaceIdentity("/synthetic", operations)).toThrow("must resolve to the same directory");
		expect(composed).not.toBe(decomposed);
	});

	it("rejects relative, missing, non-directory, and symlink-loop inputs", () => {
		const base = root();
		const file = path.join(base, "file");
		const loop = path.join(base, "loop");
		writeFileSync(file, "x");
		symlinkSync(loop, loop);

		expect(() => deriveWorkspaceIdentity("relative")).toThrow("must be absolute");
		expect(() => deriveWorkspaceIdentity(path.join(base, "missing"))).toThrow("readable existing directory");
		expect(() => deriveWorkspaceIdentity(file)).toThrow("must resolve to a directory");
		expect(() => deriveWorkspaceIdentity(loop)).toThrow("readable existing directory");
	});

	it("rejects lossy or negative synthetic stat identifiers", () => {
		expect(() =>
			deriveWorkspaceIdentity("/synthetic", {
				...syntheticOperations("/synthetic", 1n, 2n),
				statBigInt: () => ({ dev: Number.MAX_SAFE_INTEGER as unknown as bigint, ino: 2n, isDirectory: () => true }),
			}),
		).toThrow("nonnegative bigint");
		expect(() => deriveWorkspaceIdentity("/synthetic", syntheticOperations("/synthetic", -1n, 2n))).toThrow(
			"nonnegative bigint",
		);
	});
});
