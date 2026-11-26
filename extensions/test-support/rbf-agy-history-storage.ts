// Actual runtime SessionManager disk failure/reopen proof for the ACP activity records; no AGY process.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { captureAgyAcpActivity, recordAgyAcpActivity, newAgyActivityBudget, AGY_ACP_ACTIVITY, type AgyAcpActivityInput, type AgyAcpActivityObservation, type AgyHistoryGuard } from "../lib/agy-history.js";

const base = process.env.RBF_AGY_TEST_ROOT ?? tmpdir();
mkdirSync(base, { recursive: true });
const root = join(base, "storage-" + Date.now()); mkdirSync(root);
const executable = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
const target = readFileSync(executable, "utf8").split("# cmd-shim-target=")[1]?.trim();
if (!target) throw new Error("Cannot resolve current Pi package");
const packageRoot = dirname(dirname(dirname(realpathSync(target))));
const runtime = await import(pathToFileURL(join(packageRoot, "dist/core/session-manager.js")).href);
// Pi 1.5.0 and 1.6.0 drop an entry whose write failed (changelog #11460; session-manager.js _appendEntry). This recipe expects exactly that, so refuse any other Pi.
if (JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version !== "1.6.0") throw new Error("Revalidate actual-host recipe for this new Pi version");
const sm = runtime.SessionManager.create(root, root), inputEntryId = sm.appendMessage({ role: "user", content: "Inspect previously reported work", timestamp: Date.now() });
const activity = (toolCallId: string, extra: Partial<AgyAcpActivityInput> = {}): AgyAcpActivityInput => ({ piSessionId: sm.getSessionId(), inputEntryId, acpSessionId: "storage-acp", toolCallId, name: "run_command", kind: "execute", title: "printf hello", state: "completed", command: "printf hello", ...extra });
const guard: AgyHistoryGuard<AgyAcpActivityObservation> = { assertCurrent() {}, entries: () => sm.getBranch(), leafId: () => sm.getLeafId(), fingerprint: entries => JSON.stringify(entries), expectedFingerprint: JSON.stringify(sm.getBranch()), append: (type, data) => sm.appendCustomEntry(type, data) };
const budget = newAgyActivityBudget(), first = recordAgyAcpActivity(activity("call-1"), budget, guard); guard.expectedFingerprint = first.fingerprint;
const file = sm.getSessionFile(); if (!file || !existsSync(file)) throw new Error("Runtime did not persist the first report");
const preserved = file + ".before-disk-failure"; renameSync(file, preserved); mkdirSync(file);
let diskError = "";
try { recordAgyAcpActivity(activity("call-2", { output: "hello" }), budget, guard); } catch (error) { diskError = String(error); }
if (!diskError.includes("EISDIR")) throw new Error("Expected a real append-to-directory disk failure: " + diskError);
const memoryReports = sm.getBranch().filter((e: any) => e.customType === AGY_ACP_ACTIVITY).length;
if (memoryReports !== 1 || budget.observations !== 1) throw new Error("Disk failure was accepted as a saved observation");
const reopened = runtime.SessionManager.open(preserved), reports = reopened.getBranch().filter((e: any) => e.customType === AGY_ACP_ACTIVITY);
if (reports.length !== 1 || reports[0].data.toolCallId !== "call-1") throw new Error("Prior saved report did not survive normal reopen");
const context = reopened.buildSessionContext(); if (context.messages.some((m: unknown) => JSON.stringify(m).includes("printf hello"))) throw new Error("Display data entered model context");
const oversized = captureAgyAcpActivity(activity("call-3", { output: "x".repeat(65537) }), newAgyActivityBudget()).data;
const receipt = { packageRoot, runtimeVersion: JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version, diskError, memoryReports, verifiedSavedReports: reports.length, unacceptedWriteNotCounted: budget.observations === 1, preserved, contextExcludesActivity: true, partialOutputOmittedBytes: oversized.output?.omittedBytes, nativeLaunches: 0 };
writeFileSync(join(root, "receipt.json"), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt, null, 2));
