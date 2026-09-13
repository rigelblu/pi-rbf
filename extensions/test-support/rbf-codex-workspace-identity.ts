import { constants, realpathSync, statSync, accessSync } from "node:fs";
import path from "node:path";

export interface WorkspaceIdentity {
	readonly source: "pi-session-manager-cwd";
	readonly physicalPathNfc: string;
	readonly deviceDecimal: string;
	readonly inodeDecimal: string;
}

interface BigIntStat {
	readonly dev: bigint;
	readonly ino: bigint;
	isDirectory(): boolean;
}

export interface WorkspaceIdentityOperations {
	realpathNative(input: string): string;
	accessReadable(input: string): void;
	statBigInt(input: string): BigIntStat;
}

const defaultOperations: WorkspaceIdentityOperations = {
	realpathNative: (input) => realpathSync.native(input),
	accessReadable: (input) => accessSync(input, constants.R_OK),
	statBigInt: (input) => statSync(input, { bigint: true }),
};

function requireUnsignedBigInt(value: unknown, label: string): bigint {
	if (typeof value !== "bigint" || value < 0n) throw new Error(`${label} must be a nonnegative bigint`);
	return value;
}

export function deriveWorkspaceIdentity(
	cwd: string,
	operations: WorkspaceIdentityOperations = defaultOperations,
): WorkspaceIdentity {
	if (!path.isAbsolute(cwd)) throw new Error("Pi workspace cwd must be absolute");

	let physicalPath: string;
	try {
		physicalPath = operations.realpathNative(cwd);
		operations.accessReadable(physicalPath);
	} catch {
		throw new Error("Pi workspace cwd must resolve to a readable existing directory");
	}
	if (!path.isAbsolute(physicalPath)) throw new Error("Native realpath must be absolute");

	const physicalPathNfc = physicalPath.normalize("NFC");
	let stat: BigIntStat;
	try {
		stat = operations.statBigInt(physicalPath);
	} catch {
		throw new Error("Pi workspace cwd could not be inspected");
	}
	if (!stat.isDirectory()) throw new Error("Pi workspace cwd must resolve to a directory");
	if (physicalPathNfc !== physicalPath) {
		let normalizedStat: BigIntStat;
		try {
			operations.accessReadable(physicalPathNfc);
			normalizedStat = operations.statBigInt(physicalPathNfc);
		} catch {
			throw new Error("Normalized Pi workspace path must resolve to the same directory");
		}
		if (
			!normalizedStat.isDirectory() ||
			requireUnsignedBigInt(normalizedStat.dev, "Normalized workspace device") !==
				requireUnsignedBigInt(stat.dev, "Workspace device") ||
			requireUnsignedBigInt(normalizedStat.ino, "Normalized workspace inode") !==
				requireUnsignedBigInt(stat.ino, "Workspace inode")
		) {
			throw new Error("Normalized Pi workspace path must resolve to the same directory");
		}
	}

	return Object.freeze({
		source: "pi-session-manager-cwd",
		physicalPathNfc,
		deviceDecimal: requireUnsignedBigInt(stat.dev, "Workspace device").toString(10),
		inodeDecimal: requireUnsignedBigInt(stat.ino, "Workspace inode").toString(10),
	});
}

export function workspaceIdentitiesEqual(left: WorkspaceIdentity, right: WorkspaceIdentity): boolean {
	return (
		left.source === right.source &&
		left.physicalPathNfc === right.physicalPathNfc &&
		left.deviceDecimal === right.deviceDecimal &&
		left.inodeDecimal === right.inodeDecimal
	);
}
