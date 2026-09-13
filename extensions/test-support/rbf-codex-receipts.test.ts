import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	ADMITTED_RUNTIME,
	CANDIDATE_RESULT_MAPPING,
	CANDIDATE_SCHEMA,
	QUALIFICATION_RESULT_MAPPING,
	QUALIFICATION_SCHEMA,
	SLICE,
	candidateManifest,
	parseStrictJsonObject,
	qualificationManifest,
	resolveManifestPaths,
	resultMap,
	serializeDeterministicReceipt,
	sha256Bytes,
	validateReceiptBytes,
	type CandidateReceiptV1,
	type QualificationReceiptV1,
} from "./rbf-codex-receipts.js";

const ARTIFACT_SHA256 = "a".repeat(64);
const QUALIFICATION_SHA256 = "b".repeat(64);
const stateRoot = mkdtempSync("/private/tmp/rbf-codex-receipts-");
const paths = resolveManifestPaths(stateRoot);

afterAll(() => rmSync(stateRoot, { recursive: true, force: true }));

function qualification(): QualificationReceiptV1 {
	return {
		schema: QUALIFICATION_SCHEMA,
		slice: SLICE,
		artifactSha256: ARTIFACT_SHA256,
		runtime: ADMITTED_RUNTIME,
		commandManifest: qualificationManifest(paths),
		results: resultMap(QUALIFICATION_RESULT_MAPPING, ARTIFACT_SHA256),
	};
}

function candidate(): CandidateReceiptV1 {
	return {
		schema: CANDIDATE_SCHEMA,
		slice: SLICE,
		artifactSha256: ARTIFACT_SHA256,
		runtime: ADMITTED_RUNTIME,
		qualificationSha256: QUALIFICATION_SHA256,
		commandManifest: candidateManifest(paths),
		results: resultMap(CANDIDATE_RESULT_MAPPING, ARTIFACT_SHA256),
	};
}

function validateQualification(receipt: QualificationReceiptV1): QualificationReceiptV1 {
	const bytes = serializeDeterministicReceipt(receipt);
	return validateReceiptBytes(bytes, {
		paths,
		artifactSha256: ARTIFACT_SHA256,
		suppliedDigest: sha256Bytes(bytes),
	}) as QualificationReceiptV1;
}

describe("rbf-codex admission receipts", () => {
	it("builds the exact ordered qualification and candidate manifests", () => {
		const q = qualificationManifest(paths);
		const c = candidateManifest(paths);

		expect(q.map((entry) => entry.id)).toEqual([
			"q01_install",
			"q02_typecheck",
			"q03_build",
			"q04_focused",
			"q05_native_context",
			"q06_daemon",
			"q07_task_zero",
		]);
		expect(c.slice(0, 7)).toEqual(q);
		expect(c.slice(7).map((entry) => entry.id)).toEqual([
			"c01_full_suite",
			"c02_automated_scenarios",
			"c03_workspace_candidate",
			"c04_privacy",
			"c05_whitespace",
		]);
		expect(q[6].environmentNames).toEqual(["PI10_STATE_ROOT"]);
		expect(c[8].environmentNames).toEqual([
			"PI10_ADMISSION_RECEIPT",
			"PI10_ADMISSION_RECEIPT_SHA256",
			"PI10_QUALIFICATION_RECEIPT",
			"PI10_QUALIFICATION_RECEIPT_SHA256",
			"PI10_STATE_ROOT",
		]);
	});

	it("validates a complete qualification receipt against its exact byte digest", () => {
		const original = qualification();
		const validated = validateQualification(original);

		expect(validated).toEqual(original);
		expect(Object.keys(validated.results)).toEqual(Object.keys(QUALIFICATION_RESULT_MAPPING));
	});

	it("accepts object reordering and insignificant whitespace only under the matching new digest", () => {
		const receipt = qualification();
		const reordered = {
			results: receipt.results,
			commandManifest: receipt.commandManifest,
			runtime: receipt.runtime,
			artifactSha256: receipt.artifactSha256,
			slice: receipt.slice,
			schema: receipt.schema,
		};
		const bytes = new TextEncoder().encode(`${JSON.stringify(reordered, null, 2)}\n`);

		expect(
			validateReceiptBytes(bytes, {
				paths,
				artifactSha256: ARTIFACT_SHA256,
				suppliedDigest: sha256Bytes(bytes),
			}),
		).toEqual(receipt);
		expect(() =>
			validateReceiptBytes(bytes, {
				paths,
				artifactSha256: ARTIFACT_SHA256,
				suppliedDigest: "0".repeat(64),
			}),
		).toThrow("do not match");
	});

	it("rejects duplicate keys recursively, BOM, invalid UTF-8, and trailing JSON", () => {
		expect(() => parseStrictJsonObject(Buffer.from('{"schema":"a","schema":"b"}'))).toThrow("duplicate key");
		expect(() => parseStrictJsonObject(Buffer.from('{"nested":{"x":1,"x":2}}'))).toThrow("duplicate key");
		expect(() => parseStrictJsonObject(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))).toThrow("BOM");
		expect(() => parseStrictJsonObject(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]))).toThrow(
			"strict UTF-8",
		);
		expect(() => parseStrictJsonObject(Buffer.from("{}{}"))).toThrow("trailing data");
		for (const whitespace of ["\f", "\v", "\u00a0", "\u2028"]) {
			expect(() => parseStrictJsonObject(Buffer.from(`{${whitespace}}`))).toThrow();
		}
	});

	it("rejects noncanonical manifest roots", () => {
		const alias = `${stateRoot}-alias`;
		symlinkSync(stateRoot, alias);
		try {
			expect(() => resolveManifestPaths(alias)).toThrow("native-realpath spelling");
			expect(() => resolveManifestPaths(`${stateRoot}/../${path.basename(stateRoot)}`)).toThrow(
				"native-realpath spelling",
			);
			expect(() => resolveManifestPaths(path.join(stateRoot, "missing"))).toThrow("existing native realpaths");
			expect(() => resolveManifestPaths(stateRoot, "/tmp/not-the-repository")).toThrow("not admitted");
		const fileRoot = path.join(stateRoot, "not-a-directory");
		mkdirSync(fileRoot);
		expect(() => resolveManifestPaths(fileRoot)).not.toThrow();
		} finally {
			rmSync(alias, { force: true });
		}
	});

	it("rejects schema drift, non-PASS results, and nonliteral manifest values", () => {
		const extra = JSON.parse(JSON.stringify(qualification())) as Record<string, unknown>;
		extra.ambientPass = true;
		const extraBytes = new TextEncoder().encode(JSON.stringify(extra));
		expect(() =>
			validateReceiptBytes(extraBytes, {
				paths,
				artifactSha256: ARTIFACT_SHA256,
				suppliedDigest: sha256Bytes(extraBytes),
			}),
		).toThrow("missing or extra");

		const failed = JSON.parse(JSON.stringify(qualification())) as QualificationReceiptV1;
		(failed.results.install as { status: string }).status = "FAIL";
		const failedBytes = new TextEncoder().encode(JSON.stringify(failed));
		expect(() =>
			validateReceiptBytes(failedBytes, {
				paths,
				artifactSha256: ARTIFACT_SHA256,
				suppliedDigest: sha256Bytes(failedBytes),
			}),
		).toThrow("must be PASS");

		const changed = JSON.parse(JSON.stringify(qualification())) as QualificationReceiptV1;
		(changed.commandManifest[0].argv as string[]).push("--silent");
		const changedBytes = new TextEncoder().encode(JSON.stringify(changed));
		expect(() =>
			validateReceiptBytes(changedBytes, {
				paths,
				artifactSha256: ARTIFACT_SHA256,
				suppliedDigest: sha256Bytes(changedBytes),
			}),
		).toThrow("not literal");
	});

	it("validates candidate receipts only with the pinned qualification chain", () => {
		const qualificationReceipt = validateQualification(qualification());
		const receipt = candidate();
		const bytes = serializeDeterministicReceipt(receipt);
		const expectations = {
			paths,
			artifactSha256: ARTIFACT_SHA256,
			suppliedDigest: sha256Bytes(bytes),
			qualificationSha256: QUALIFICATION_SHA256,
			qualificationReceipt,
		};

		expect(validateReceiptBytes(bytes, expectations)).toEqual(receipt);
		expect(() => validateReceiptBytes(bytes, { ...expectations, qualificationReceipt: undefined })).toThrow(
			"requires the pinned qualification",
		);
		expect(() => validateReceiptBytes(bytes, { ...expectations, qualificationSha256: "c".repeat(64) })).toThrow(
			"binding does not match",
		);
	});

	it("compares candidate and qualification objects independently of object key order", () => {
		const source = qualification();
		const reorderedQualification = {
			...source,
			runtime: {
				arch: source.runtime.arch,
				osBuild: source.runtime.osBuild,
				bunVersion: source.runtime.bunVersion,
				piVersion: source.runtime.piVersion,
				codexVersion: source.runtime.codexVersion,
			},
			commandManifest: source.commandManifest.map((entry) => ({
				environmentNames: entry.environmentNames,
				cwdPhysicalPathNfc: entry.cwdPhysicalPathNfc,
				argv: entry.argv,
				executable: entry.executable,
				id: entry.id,
			})),
			results: Object.fromEntries(
				Object.entries(source.results).map(([key, result]) => [
					key,
					{ observed: result.observed, status: result.status, commandId: result.commandId },
				]),
			),
		};
		const qualificationBytes = new TextEncoder().encode(JSON.stringify(reorderedQualification));
		const qualificationReceipt = validateReceiptBytes(qualificationBytes, {
			paths,
			artifactSha256: ARTIFACT_SHA256,
			suppliedDigest: sha256Bytes(qualificationBytes),
		}) as QualificationReceiptV1;
		const receipt = candidate();
		const bytes = serializeDeterministicReceipt(receipt);

		expect(
			validateReceiptBytes(bytes, {
				paths,
				artifactSha256: ARTIFACT_SHA256,
				suppliedDigest: sha256Bytes(bytes),
				qualificationSha256: QUALIFICATION_SHA256,
				qualificationReceipt,
			}),
		).toEqual(receipt);
	});
});
