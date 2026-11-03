// Actual runtime SessionManager disk failure/reopen proof; no native process.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { captureAgyActivity, recordAgyActivity, newAgyActivityBudget, AGY_ACTIVITY, type AgyHistoryGuard, type AgyObservationScope, type NativeToolObservation } from "../lib/agy-history.js";

const base = execFileSync("bash", [join(process.env.HOME!, ".agents/skills/eng-use-external-tmp/scripts/resolve-external-tmp.sh"), "pi-21.8"], { encoding: "utf8" }).trim();
const root = join(base, "storage-" + Date.now()); mkdirSync(root);
const executable = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
const target = readFileSync(executable, "utf8").split("# cmd-shim-target=")[1]?.trim();
if (!target) throw new Error("Cannot resolve current Pi package");
const packageRoot = dirname(dirname(dirname(realpathSync(target))));
const runtime = await import(pathToFileURL(join(packageRoot, "dist/core/session-manager.js")).href);
const sm = runtime.SessionManager.create(root, root), inputEntryId = sm.appendMessage({ role: "user", content: "Inspect previously reported work", timestamp: Date.now() });
const scope: AgyObservationScope = { piSessionId: sm.getSessionId(), inputEntryId, rootConversationId: "storage-root", turnCount: 1, source: { kind: "root", conversationId: "storage-root" } };
const tool: NativeToolObservation = { kind: "tool", conversationId: "storage-root", index: 4, toolName: "run_command", state: "ACTIVE", info: { name: "run_command", parameters: { CommandLine: "printf hello" } } };
const guard: AgyHistoryGuard = { assertCurrent() {}, entries: () => sm.getBranch(), leafId: () => sm.getLeafId(), fingerprint: entries => JSON.stringify(entries), expectedFingerprint: JSON.stringify(sm.getBranch()), append: (type, data) => sm.appendCustomEntry(type, data) };
const budget = newAgyActivityBudget(), first = recordAgyActivity(tool, scope, budget, guard); guard.expectedFingerprint = first.fingerprint;
const file = sm.getSessionFile(); if (!file || !existsSync(file)) throw new Error("Runtime did not persist the first report");
const preserved = file + ".before-disk-failure"; renameSync(file, preserved); mkdirSync(file);
let diskError = "";
try { recordAgyActivity({ ...tool, state: "DONE", info: { name: "run_command", output: "hello" } }, scope, budget, guard); } catch (error) { diskError = String(error); }
if (!diskError.includes("EISDIR")) throw new Error("Expected a real append-to-directory disk failure: " + diskError);
if (sm.getBranch().filter((e: any) => e.customType === AGY_ACTIVITY).length !== 2 || budget.observations !== 1) throw new Error("Disk failure was accepted as a saved observation");
const reopened = runtime.SessionManager.open(preserved), reports = reopened.getBranch().filter((e: any) => e.customType === AGY_ACTIVITY);
if (reports.length !== 1 || reports[0].data.state !== "ACTIVE") throw new Error("Prior saved report did not survive normal reopen");
const context = reopened.buildSessionContext(); if (context.messages.some((m: unknown) => JSON.stringify(m).includes("printf hello"))) throw new Error("Display data entered model context");
const oversized = captureAgyActivity({ ...tool, info: { name: "run_command", output: "x".repeat(65537) } }, scope, newAgyActivityBudget()).data;
const receipt = { packageRoot, runtimeVersion: JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version, diskError, memoryReports: 2, verifiedSavedReports: reports.length, unacceptedWriteNotCounted: budget.observations === 1, preserved, contextExcludesActivity: true, partialOutputOmittedBytes: oversized.output?.omittedBytes, nativeLaunches: 0 };
writeFileSync(join(root, "receipt.json"), JSON.stringify(receipt, null, 2)); console.log(JSON.stringify(receipt, null, 2));
