import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const REPOSITORY_ROOT = "/Volumes/tom-ssd/src/rb/craftmans-shop/pi-rbf";
export const BUN_EXECUTABLE = "/Users/tomhosiawa/homebrew/bin/bun";
export const GIT_EXECUTABLE = "/Users/tomhosiawa/homebrew/bin/git";
export const CODEX_EXECUTABLE = "/Users/tomhosiawa/.local/bin/codex";

export const QUALIFICATION_SCHEMA = "rbf-codex-qualification/v1" as const;
export const CANDIDATE_SCHEMA = "rbf-codex-candidate/v1" as const;
export const SLICE = "pi-10.2" as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UNSIGNED_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;

export interface RuntimeV1 {
	readonly codexVersion: "0.154.0";
	readonly piVersion: "0.85.1";
	readonly bunVersion: "1.4.0";
	readonly osBuild: "25G83";
	readonly arch: "arm64";
}

export const ADMITTED_RUNTIME: RuntimeV1 = Object.freeze({
	codexVersion: "0.154.0",
	piVersion: "0.85.1",
	bunVersion: "1.4.0",
	osBuild: "25G83",
	arch: "arm64",
});

export interface CommandV1 {
	readonly id: string;
	readonly executable: string;
	readonly argv: readonly string[];
	readonly cwdPhysicalPathNfc: string;
	readonly environmentNames: readonly string[];
}

export interface ResultV1 {
	readonly commandId: string;
	readonly status: "PASS";
	readonly observed: true | string;
}

export interface QualificationReceiptV1 {
	readonly schema: typeof QUALIFICATION_SCHEMA;
	readonly slice: typeof SLICE;
	readonly artifactSha256: string;
	readonly runtime: RuntimeV1;
	readonly commandManifest: readonly CommandV1[];
	readonly results: Readonly<Record<string, ResultV1>>;
}

export interface CandidateReceiptV1 {
	readonly schema: typeof CANDIDATE_SCHEMA;
	readonly slice: typeof SLICE;
	readonly artifactSha256: string;
	readonly runtime: RuntimeV1;
	readonly qualificationSha256: string;
	readonly commandManifest: readonly CommandV1[];
	readonly results: Readonly<Record<string, ResultV1>>;
}

export type ReceiptV1 = QualificationReceiptV1 | CandidateReceiptV1;

type ExpectedObservation = true | "0" | "artifactSha256";
interface ResultMapping {
	readonly commandId: string;
	readonly observed: ExpectedObservation;
}

export const QUALIFICATION_RESULT_MAPPING = Object.freeze({
	install: { commandId: "q01_install", observed: true },
	typecheck: { commandId: "q02_typecheck", observed: true },
	build: { commandId: "q03_build", observed: "artifactSha256" },
	focused_tests: { commandId: "q04_focused", observed: true },
	native_developer_context: { commandId: "q05_native_context", observed: true },
	nested_agents_context: { commandId: "q05_native_context", observed: true },
	direct_child_signal_rejected: { commandId: "q07_task_zero", observed: true },
	accepted_input: { commandId: "q07_task_zero", observed: true },
	isolated_launch: { commandId: "q07_task_zero", observed: true },
	selection_binding: { commandId: "q07_task_zero", observed: true },
	bound_input_guard: { commandId: "q07_task_zero", observed: true },
	hook_failure_refusal: { commandId: "q07_task_zero", observed: true },
	refusal_envelope_recovery: { commandId: "q07_task_zero", observed: true },
	append_crash_anchors: { commandId: "q07_task_zero", observed: true },
	private_envelope_schemas: { commandId: "q07_task_zero", observed: true },
	binding_store: { commandId: "q07_task_zero", observed: true },
	wake_recovery: { commandId: "q07_task_zero", observed: true },
	terminal_projector: { commandId: "q07_task_zero", observed: true },
	reducer_closed: { commandId: "q07_task_zero", observed: true },
	effect_results_closed: { commandId: "q07_task_zero", observed: true },
	interrupt_recovery: { commandId: "q07_task_zero", observed: true },
	cancel_complete_precedence: { commandId: "q07_task_zero", observed: true },
	thread_ack_blocked: { commandId: "q07_task_zero", observed: true },
	orphan_turns_zero: { commandId: "q07_task_zero", observed: "0" },
	successor_client_id: { commandId: "q07_task_zero", observed: true },
	exact_turn_scan: { commandId: "q07_task_zero", observed: true },
	final_phase_exact: { commandId: "q07_task_zero", observed: true },
	pagination_complete: { commandId: "q07_task_zero", observed: true },
	workspace_identity: { commandId: "q07_task_zero", observed: true },
	workspace_bigint: { commandId: "q07_task_zero", observed: true },
	codex_workspace_binding: { commandId: "q07_task_zero", observed: true },
	workspace_override_sdk: { commandId: "q07_task_zero", observed: true },
	session_control_matrix: { commandId: "q07_task_zero", observed: true },
	session_control_result: { commandId: "q07_task_zero", observed: true },
	compact_guard: { commandId: "q07_task_zero", observed: true },
	proxy_cleanup: { commandId: "q06_daemon", observed: true },
	proxy_close_result: { commandId: "q07_task_zero", observed: true },
	daemon_shared: { commandId: "q06_daemon", observed: true },
	sandbox_preload: { commandId: "q07_task_zero", observed: true },
	model_bootstrap: { commandId: "q07_task_zero", observed: true },
	receipt_validation: { commandId: "q07_task_zero", observed: true },
	receipt_orchestration: { commandId: "q07_task_zero", observed: true },
	pi_tool_calls_zero: { commandId: "q07_task_zero", observed: "0" },
	approval_callbacks_zero: { commandId: "q07_task_zero", observed: "0" },
	duplicate_turns_zero: { commandId: "q07_task_zero", observed: "0" },
	duplicate_assistants_zero: { commandId: "q07_task_zero", observed: "0" },
	daemon_stop_invocations_zero: { commandId: "q07_task_zero", observed: "0" },
	final_pi_owned_proxies_zero: { commandId: "q07_task_zero", observed: "0" },
} satisfies Readonly<Record<string, ResultMapping>>);

export const CANDIDATE_RESULT_MAPPING = Object.freeze({
	...QUALIFICATION_RESULT_MAPPING,
	full_suite: { commandId: "c01_full_suite", observed: true },
	automated_scenarios_01_06: { commandId: "c02_automated_scenarios", observed: true },
	workspace_override_candidate: { commandId: "c03_workspace_candidate", observed: true },
	privacy_scan: { commandId: "c04_privacy", observed: true },
	whitespace: { commandId: "c05_whitespace", observed: true },
} satisfies Readonly<Record<string, ResultMapping>>);

export interface ManifestPaths {
	readonly repositoryRoot: string;
	readonly stateRoot: string;
	readonly artifact: string;
	readonly qualification: string;
	readonly candidate: string;
	readonly pi: string;
}

export function resolveManifestPaths(stateRoot: string, repositoryRoot = REPOSITORY_ROOT): ManifestPaths {
	if (repositoryRoot !== REPOSITORY_ROOT) throw new Error("Qualification repository root is not admitted");
	if (!path.isAbsolute(stateRoot)) throw new Error("Manifest state root must be absolute");
	let repositoryRealpath: string;
	let stateRealpath: string;
	try {
		repositoryRealpath = realpathSync.native(repositoryRoot);
		stateRealpath = realpathSync.native(stateRoot);
	} catch {
		throw new Error("Manifest roots must be existing native realpaths");
	}
	if (repositoryRealpath !== repositoryRoot || stateRealpath !== stateRoot || stateRoot.normalize("NFC") !== stateRoot) {
		throw new Error("Manifest roots must use exact NFC native-realpath spelling");
	}
	if (!statSync(stateRoot).isDirectory()) throw new Error("Manifest state root must be a directory");
	const productionStateRoot = path.join(realpathSync.native(homedir()), ".pi", "agent", "state", "rbf-codex", "v3");
	if (stateRoot === productionStateRoot || stateRoot.startsWith(`${productionStateRoot}${path.sep}`)) {
		throw new Error("Qualification state root must be separate from the production binding root");
	}
	return Object.freeze({
		repositoryRoot,
		stateRoot,
		artifact: path.join(repositoryRoot, "dist", "rbf-codex-provider.js"),
		qualification: path.join(stateRoot, "qualification-receipt.json"),
		candidate: path.join(stateRoot, "candidate-receipt.json"),
		pi: path.join(repositoryRoot, "node_modules", ".bin", "pi"),
	});
}

function command(
	id: string,
	executable: string,
	argv: readonly string[],
	cwdPhysicalPathNfc: string,
	environmentNames: readonly string[],
): CommandV1 {
	return Object.freeze({
		id,
		executable,
		argv: Object.freeze([...argv]),
		cwdPhysicalPathNfc,
		environmentNames: Object.freeze([...environmentNames]),
	});
}

export function qualificationManifest(paths: ManifestPaths): readonly CommandV1[] {
	const r = paths.repositoryRoot;
	const s = paths.stateRoot;
	return Object.freeze([
		command("q01_install", BUN_EXECUTABLE, ["install", "--frozen-lockfile"], r, []),
		command("q02_typecheck", BUN_EXECUTABLE, ["run", "typecheck"], r, []),
		command(
			"q03_build",
			BUN_EXECUTABLE,
			["build", "extensions/rbf-codex-provider.ts", "--outdir", "dist", "--target", "bun"],
			r,
			[],
		),
		command(
			"q04_focused",
			BUN_EXECUTABLE,
			[
				"test",
				"extensions/rbf-codex/provider-conversation.test.ts",
				"extensions/rbf-codex/recovery.test.ts",
				"extensions/rbf-codex/authority.test.ts",
				"extensions/rbf-codex/ownership.test.ts",
			],
			r,
			[],
		),
		command(
			"q05_native_context",
			BUN_EXECUTABLE,
			[
				"run",
				"extensions/test-support/rbf-codex-native-context-probe.ts",
				"--mode",
				"direct",
				"--root",
				path.join(s, "native-context"),
				"--codex",
				CODEX_EXECUTABLE,
				"--output",
				path.join(s, "native-context", "receipt.json"),
			],
			r,
			[],
		),
		command(
			"q06_daemon",
			BUN_EXECUTABLE,
			[
				"run",
				"extensions/test-support/rbf-codex-daemon-ownership-probe.ts",
				"--root",
				path.join(s, "daemon"),
				"--codex",
				CODEX_EXECUTABLE,
				"--output",
				path.join(s, "daemon", "receipt.json"),
			],
			r,
			[],
		),
		command(
			"q07_task_zero",
			BUN_EXECUTABLE,
			[
				"run",
				"extensions/test-support/rbf-codex-prebuild-probe.ts",
				"--codex",
				CODEX_EXECUTABLE,
				"--pi",
				paths.pi,
				"--output",
				path.join(s, "task-zero.json"),
			],
			r,
			["PI10_STATE_ROOT"],
		),
	]);
}

const ADMISSION_ENVIRONMENT = Object.freeze([
	"PI10_ADMISSION_RECEIPT",
	"PI10_ADMISSION_RECEIPT_SHA256",
	"PI10_QUALIFICATION_RECEIPT",
	"PI10_QUALIFICATION_RECEIPT_SHA256",
]);

export function candidateManifest(paths: ManifestPaths): readonly CommandV1[] {
	const r = paths.repositoryRoot;
	const s = paths.stateRoot;
	return Object.freeze([
		...qualificationManifest(paths),
		command("c01_full_suite", BUN_EXECUTABLE, ["test"], r, ADMISSION_ENVIRONMENT),
		command(
			"c02_automated_scenarios",
			BUN_EXECUTABLE,
			[
				"run",
				"extensions/test-support/rbf-codex-candidate-automated.ts",
				"--artifact",
				paths.artifact,
				"--qualification",
				paths.qualification,
				"--state-root",
				s,
			],
			r,
			[...ADMISSION_ENVIRONMENT, "PI10_STATE_ROOT"],
		),
		command(
			"c03_workspace_candidate",
			BUN_EXECUTABLE,
			["test", "extensions/test-support/rbf-codex-workspace-mismatch-pi.test.ts"],
			r,
			[...ADMISSION_ENVIRONMENT, "PI10_STATE_ROOT"],
		),
		command(
			"c04_privacy",
			BUN_EXECUTABLE,
			[
				"run",
				"extensions/test-support/rbf-codex-privacy-scan.ts",
				"--artifact",
				paths.artifact,
				"--qualification",
				paths.qualification,
				"--state-root",
				s,
			],
			r,
			["PI10_STATE_ROOT"],
		),
		command("c05_whitespace", GIT_EXECUTABLE, ["diff", "--check"], r, []),
	]);
}

class StrictJsonParser {
	private index = 0;

	constructor(private readonly input: string) {}

	parse(): unknown {
		this.space();
		const value = this.value();
		this.space();
		if (this.index !== this.input.length) throw new Error("Receipt contains trailing data");
		return value;
	}

	private value(): unknown {
		const next = this.input[this.index];
		if (next === "{") return this.object();
		if (next === "[") return this.array();
		if (next === '"') return this.string();
		if (this.input.startsWith("true", this.index)) return this.literal("true", true);
		if (this.input.startsWith("false", this.index)) return this.literal("false", false);
		if (this.input.startsWith("null", this.index)) return this.literal("null", null);
		if (next === "-" || (next !== undefined && /[0-9]/.test(next))) return this.number();
		throw new Error("Receipt is not valid JSON");
	}

	private object(): Record<string, unknown> {
		this.index += 1;
		this.space();
		const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
		const keys = new Set<string>();
		if (this.input[this.index] === "}") {
			this.index += 1;
			return result;
		}
		while (true) {
			if (this.input[this.index] !== '"') throw new Error("Receipt object key must be a string");
			const key = this.string();
			if (keys.has(key)) throw new Error(`Receipt contains duplicate key: ${key}`);
			keys.add(key);
			this.space();
			this.expect(":");
			this.space();
			result[key] = this.value();
			this.space();
			if (this.input[this.index] === "}") {
				this.index += 1;
				return result;
			}
			this.expect(",");
			this.space();
		}
	}

	private array(): unknown[] {
		this.index += 1;
		this.space();
		const result: unknown[] = [];
		if (this.input[this.index] === "]") {
			this.index += 1;
			return result;
		}
		while (true) {
			result.push(this.value());
			this.space();
			if (this.input[this.index] === "]") {
				this.index += 1;
				return result;
			}
			this.expect(",");
			this.space();
		}
	}

	private string(): string {
		const start = this.index;
		this.index += 1;
		while (this.index < this.input.length) {
			const character = this.input[this.index++];
			if (character === '"') {
				try {
					return JSON.parse(this.input.slice(start, this.index)) as string;
				} catch {
					throw new Error("Receipt contains an invalid JSON string");
				}
			}
			if (character === "\\") {
				const escaped = this.input[this.index++];
				if (escaped === "u") {
					if (!/^[0-9a-fA-F]{4}$/.test(this.input.slice(this.index, this.index + 4))) {
						throw new Error("Receipt contains an invalid JSON escape");
					}
					this.index += 4;
				} else if (!escaped || !'"\\/bfnrt'.includes(escaped)) {
					throw new Error("Receipt contains an invalid JSON escape");
				}
			} else if (character.charCodeAt(0) < 0x20) {
				throw new Error("Receipt contains an invalid JSON control character");
			}
		}
		throw new Error("Receipt contains an unterminated JSON string");
	}

	private number(): number {
		const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.input.slice(this.index));
		if (!match) throw new Error("Receipt contains an invalid JSON number");
		this.index += match[0].length;
		const value = Number(match[0]);
		if (!Number.isFinite(value)) throw new Error("Receipt contains a non-finite number");
		return value;
	}

	private literal<T>(token: string, value: T): T {
		this.index += token.length;
		return value;
	}

	private expect(character: string): void {
		if (this.input[this.index] !== character) throw new Error("Receipt is not valid JSON");
		this.index += 1;
	}

	private space(): void {
		while ([" ", "\t", "\r", "\n"].includes(this.input[this.index] ?? "")) this.index += 1;
	}
}

export function sha256Bytes(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function parseStrictJsonObject(bytes: Uint8Array): Record<string, unknown> {
	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		throw new Error("Receipt must not contain a UTF-8 BOM");
	}
	let decoded: string;
	try {
		decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new Error("Receipt must be strict UTF-8");
	}
	const value = new StrictJsonParser(decoded).parse();
	return requireObject(value, "Receipt");
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
	const actual = Object.keys(value).sort();
	const wanted = [...expected].sort();
	if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
		throw new Error(`${label} has missing or extra properties`);
	}
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a nonempty string`);
	return value;
}

function requireSha256(value: unknown, label: string): string {
	const digest = requireString(value, label);
	if (!SHA256_PATTERN.test(digest)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
	return digest;
}

function validateRuntime(value: unknown): RuntimeV1 {
	const runtime = requireObject(value, "runtime");
	requireExactKeys(runtime, Object.keys(ADMITTED_RUNTIME), "runtime");
	for (const [key, expected] of Object.entries(ADMITTED_RUNTIME)) {
		if (runtime[key] !== expected) throw new Error(`runtime.${key} is not admitted`);
	}
	return runtime as unknown as RuntimeV1;
}

function validateCommand(value: unknown, expected: CommandV1, index: number): CommandV1 {
	const commandValue = requireObject(value, `commandManifest[${index}]`);
	requireExactKeys(commandValue, ["id", "executable", "argv", "cwdPhysicalPathNfc", "environmentNames"], `commandManifest[${index}]`);
	if (commandValue.id !== expected.id || commandValue.executable !== expected.executable || commandValue.cwdPhysicalPathNfc !== expected.cwdPhysicalPathNfc) {
		throw new Error(`commandManifest[${index}] does not match ${expected.id}`);
	}
	for (const [name, expectedValues] of [
		["argv", expected.argv],
		["environmentNames", expected.environmentNames],
	] as const) {
		const values = commandValue[name];
		if (!Array.isArray(values) || values.some((item) => typeof item !== "string" || item.length === 0)) {
			throw new Error(`commandManifest[${index}].${name} must contain nonempty strings`);
		}
		if (values.length !== expectedValues.length || values.some((item, itemIndex) => item !== expectedValues[itemIndex])) {
			throw new Error(`commandManifest[${index}].${name} is not literal`);
		}
	}
	const names = commandValue.environmentNames as string[];
	if (new Set(names).size !== names.length || names.some((name, index) => index > 0 && names[index - 1] >= name)) {
		throw new Error(`commandManifest[${index}].environmentNames must be sorted and unique`);
	}
	return commandValue as unknown as CommandV1;
}

function validateManifest(value: unknown, expected: readonly CommandV1[]): readonly CommandV1[] {
	if (!Array.isArray(value) || value.length !== expected.length) throw new Error("commandManifest has the wrong length");
	const commands = value.map((entry, index) => validateCommand(entry, expected[index], index));
	if (new Set(commands.map((entry) => entry.id)).size !== commands.length) throw new Error("commandManifest IDs must be unique");
	return commands;
}

function validateResults(
	value: unknown,
	mapping: Readonly<Record<string, ResultMapping>>,
	artifactSha256: string,
	manifest: readonly CommandV1[],
): Readonly<Record<string, ResultV1>> {
	const results = requireObject(value, "results");
	requireExactKeys(results, Object.keys(mapping), "results");
	const commandIds = new Set(manifest.map((entry) => entry.id));
	for (const [key, expected] of Object.entries(mapping)) {
		const result = requireObject(results[key], `results.${key}`);
		requireExactKeys(result, ["commandId", "status", "observed"], `results.${key}`);
		if (result.commandId !== expected.commandId || !commandIds.has(expected.commandId)) {
			throw new Error(`results.${key}.commandId is not admitted`);
		}
		if (result.status !== "PASS") throw new Error(`results.${key}.status must be PASS`);
		const observed = expected.observed === "artifactSha256" ? artifactSha256 : expected.observed;
		if (result.observed !== observed) throw new Error(`results.${key}.observed is not admitted`);
		if (
			result.observed !== true &&
			(typeof result.observed !== "string" ||
				(!UNSIGNED_DECIMAL_PATTERN.test(result.observed) && !SHA256_PATTERN.test(result.observed)))
		) {
			throw new Error(`results.${key}.observed has an invalid representation`);
		}
	}
	return results as Readonly<Record<string, ResultV1>>;
}

function structurallyEqual(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((value, index) => structurallyEqual(value, right[index]))
		);
	}
	if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const leftKeys = Object.keys(leftRecord).sort();
	const rightKeys = Object.keys(rightRecord).sort();
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every((key, index) => key === rightKeys[index] && structurallyEqual(leftRecord[key], rightRecord[key]))
	);
}

export interface ReceiptExpectations {
	readonly paths: ManifestPaths;
	readonly artifactSha256: string;
	readonly suppliedDigest: string;
	readonly qualificationSha256?: string;
	readonly qualificationReceipt?: QualificationReceiptV1;
}

export function validateReceiptBytes(bytes: Uint8Array, expectations: ReceiptExpectations): ReceiptV1 {
	const suppliedDigest = requireSha256(expectations.suppliedDigest, "supplied receipt digest");
	if (sha256Bytes(bytes) !== suppliedDigest) throw new Error("Receipt bytes do not match the supplied digest");
	const artifactSha256 = requireSha256(expectations.artifactSha256, "expected artifact digest");
	const receipt = parseStrictJsonObject(bytes);
	if (receipt.schema === QUALIFICATION_SCHEMA) {
		requireExactKeys(receipt, ["schema", "slice", "artifactSha256", "runtime", "commandManifest", "results"], "qualification receipt");
		if (receipt.slice !== SLICE || receipt.artifactSha256 !== artifactSha256) throw new Error("Qualification receipt binding does not match");
		const runtime = validateRuntime(receipt.runtime);
		const manifest = validateManifest(receipt.commandManifest, qualificationManifest(expectations.paths));
		const results = validateResults(receipt.results, QUALIFICATION_RESULT_MAPPING, artifactSha256, manifest);
		return { schema: QUALIFICATION_SCHEMA, slice: SLICE, artifactSha256, runtime, commandManifest: manifest, results };
	}
	if (receipt.schema === CANDIDATE_SCHEMA) {
		requireExactKeys(
			receipt,
			["schema", "slice", "artifactSha256", "runtime", "qualificationSha256", "commandManifest", "results"],
			"candidate receipt",
		);
		const qualificationSha256 = requireSha256(expectations.qualificationSha256, "expected qualification digest");
		if (
			receipt.slice !== SLICE ||
			receipt.artifactSha256 !== artifactSha256 ||
			receipt.qualificationSha256 !== qualificationSha256
		) {
			throw new Error("Candidate receipt binding does not match");
		}
		const runtime = validateRuntime(receipt.runtime);
		const manifest = validateManifest(receipt.commandManifest, candidateManifest(expectations.paths));
		const results = validateResults(receipt.results, CANDIDATE_RESULT_MAPPING, artifactSha256, manifest);
		const qualification = expectations.qualificationReceipt;
		if (!qualification) throw new Error("Candidate validation requires the pinned qualification receipt");
		if (
			qualification.artifactSha256 !== artifactSha256 ||
			!structurallyEqual(runtime, qualification.runtime) ||
			!structurallyEqual(manifest.slice(0, 7), qualification.commandManifest) ||
			Object.entries(qualification.results).some(
				([key, value]) => !structurallyEqual(results[key], value),
			)
		) {
			throw new Error("Candidate receipt does not deeply repeat its qualification");
		}
		return {
			schema: CANDIDATE_SCHEMA,
			slice: SLICE,
			artifactSha256,
			runtime,
			qualificationSha256,
			commandManifest: manifest,
			results,
		};
	}
	throw new Error("Receipt schema is not admitted");
}

export function resultMap(
	mapping: Readonly<Record<string, ResultMapping>>,
	artifactSha256: string,
): Readonly<Record<string, ResultV1>> {
	requireSha256(artifactSha256, "artifact digest");
	return Object.fromEntries(
		Object.entries(mapping).map(([key, expected]) => [
			key,
			{
				commandId: expected.commandId,
				status: "PASS",
				observed: expected.observed === "artifactSha256" ? artifactSha256 : expected.observed,
			},
		]),
	);
}

export function serializeDeterministicReceipt(receipt: ReceiptV1): Uint8Array {
	return new TextEncoder().encode(`${JSON.stringify(receipt)}\n`);
}
