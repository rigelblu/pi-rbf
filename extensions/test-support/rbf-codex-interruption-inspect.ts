// Read-only synthetic/daily-session inspector. Never dispatches input or changes a session.
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AppServerClient, ENTRY_TYPE, verifyEmptyBranchHistory } from "../rbf-codex.ts";

type Rec = Record<string, any>;
export function binding(path: string) {
	const sm = SessionManager.open(path);
	const entries = sm.getBranch();
	const bindings = entries.filter((e) => e.type === "custom" && e.customType === ENTRY_TYPE);
	const data = (bindings.at(-1) as { data?: Rec } | undefined)?.data;
	if (!data || data.sessionId !== sm.getSessionId() || typeof data.threadId !== "string" || !data.threadId || data.cwd !== sm.getCwd()) throw new Error("Own saved binding required");
	return { threadId: data.threadId as string, cwd: sm.getCwd(), bindings: bindings.length, entries };
}

async function withClient<T>(cwd: string, codex: string, run: (client: AppServerClient) => Promise<T>): Promise<T> {
	const client = await AppServerClient.start(cwd, { bin: codex, args: ["app-server"] });
	try {
		await client.request("initialize", { clientInfo: { name: "pi-rbf-interruption-inspect", version: "1" }, capabilities: { experimentalApi: true } }, 30_000);
		client.notify("initialized", {});
		return await run(client);
	} catch (error) {
		const detail = (error as { detail?: string }).detail;
		throw new Error(`Read-only inspector failed: ${detail ?? (error instanceof Error ? error.message : "unknown error")}`);
	} finally {
		await client.close();
		if (!client.exited) await new Promise<void>((done, reject) => {
			const timer = setTimeout(() => reject(new Error("Inspector child did not exit")), 1000);
			client.child.once("exit", () => { clearTimeout(timer); done(); });
		});
	}
}

async function resume(client: AppServerClient, threadId: string) {
	const result = await client.request("thread/resume", { threadId, excludeTurns: true }, 30_000) as Rec;
	if (result?.thread?.id !== threadId) throw new Error("Native thread mismatch");
}

async function fullHistory(client: AppServerClient, threadId: string): Promise<Rec[]> {
	const deadline = Date.now() + 30_000;
	const turns: Rec[] = [];
	const seenIds = new Set<string>();
	const seenCursors = new Set<string>();
	let cursor: string | undefined;
	for (let page = 0; page < 100 && Date.now() < deadline; page++) {
		const res = await client.request("thread/turns/list", { threadId, sortDirection: "desc", itemsView: "full", limit: page === 0 ? 5 : 20, ...(cursor ? { cursor } : {}) }, Math.max(1, deadline - Date.now())) as Rec;
		if (Date.now() >= deadline || !Array.isArray(res?.data) || res.nextCursor === "" || (res.nextCursor != null && typeof res.nextCursor !== "string") || (!res.data.length && res.nextCursor)) throw new Error("Malformed or expired native history");
		for (const turn of res.data) {
			if (!turn || typeof turn.id !== "string" || !turn.id || seenIds.has(turn.id) || !Array.isArray(turn.items) || typeof turn.status !== "string") throw new Error("Malformed native turn");
			seenIds.add(turn.id); turns.push(turn);
		}
		if (res.nextCursor == null) return turns;
		if (seenCursors.has(res.nextCursor)) throw new Error("Repeated native cursor");
		seenCursors.add(res.nextCursor); cursor = res.nextCursor;
	}
	throw new Error("Native history budget exhausted");
}

const itemText = (item: Rec) => typeof item.text === "string" ? item.text : Array.isArray(item.content) ? item.content.map((part: Rec) => typeof part.text === "string" ? part.text : "").join("\n") : "";
export function historyCounts(all: Rec[], bindings: number, nonce: string, recordedCommands: { id: string; command: string }[] = []) {
	const users = all.filter((turn) => turn.items.some((item: Rec) => item?.type === "userMessage"));
	const items = all.flatMap((turn) => turn.items);
	// Live/abruptly cut native histories can omit a started command. Pi's saved
	// provider-emitted row proves it started; union by native item id avoids
	// double counting when Codex later persists the same command.
	const commands = [...items.filter((item) => item?.type === "commandExecution"), ...recordedCommands];
	const sleepIds = new Set<string>();
	for (const item of commands) if (/\/bin\/sleep\s+8(?=$|[\s'"])/.test(String(item.command))) {
		if (typeof item.id !== "string" || !item.id) throw new Error("Command item id required");
		sleepIds.add(item.id);
	}
	return {
		same_thread: true, bindings, user_turns: users.length,
		interrupted: users.filter((turn) => turn.status === "interrupted").length,
		completed: users.filter((turn) => turn.status === "completed").length,
		nonce_inputs: items.filter((item) => item?.type === "userMessage" && itemText(item).includes(nonce)).length,
		nonce_recall: users.some((turn) => turn.status === "completed") && users.filter((turn) => turn.status === "completed").every((turn) => turn.items.some((item: Rec) => item?.type === "agentMessage" && itemText(item).trim() === nonce)),
		sleep_commands: sleepIds.size,
	};
}

export async function inspect(path: string, codex: string, nonce: string) {
	if (!nonce) throw new Error("Nonce required");
	const saved = binding(path);
	return withClient(saved.cwd, codex, async (client) => {
		const metadata = await client.request("thread/read", { threadId: saved.threadId, includeTurns: false }, 30_000) as Rec;
		if (metadata?.thread?.id !== saved.threadId) throw new Error("Native read thread mismatch");
		const all = await fullHistory(client, saved.threadId);
		const recordedCommands = saved.entries.flatMap((entry) => entry.type === "message" && entry.message.role === "assistant" ? entry.message.content : [])
			.filter((block) => block.type === "toolCall" && block.name === "codex_command")
			.map((block) => {
				const args = (block as { arguments: Rec }).arguments;
				if (typeof args.itemId !== "string" || !args.itemId || typeof args.command !== "string") throw new Error("Malformed recorded command");
				return { id: args.itemId, command: args.command };
			});
		return historyCounts(all, saved.bindings, nonce, recordedCommands);
	});
}

export async function benchmark(path: string, client: AppServerClient, count = 10) {
	if (!Number.isInteger(count) || count < 10) throw new Error("At least ten timing samples required");
	const saved = binding(path);
	const times: number[] = [];
	let lists = 0, resumes = 0, itemCount = 0;
	const observed = { request: async (method: string, params: unknown, timeout?: number, signal?: AbortSignal) => {
		if (method !== "thread/resume" && method !== "thread/turns/list") throw new Error("Read-only benchmark request required");
		const res = await client.request(method, params, timeout, signal) as Rec;
		if (method === "thread/resume") resumes++;
		else { lists++; itemCount += Array.isArray(res?.data) ? res.data.reduce((sum: number, turn: Rec) => sum + (Array.isArray(turn.items) ? turn.items.length : 0), 0) : 0; }
		return res;
	} } as unknown as AppServerClient;
	for (let i = 0; i <= count; i++) {
		itemCount = 0;
		const start = performance.now();
		await resume(observed, saved.threadId);
		if (!await verifyEmptyBranchHistory(observed, saved.threadId)) throw new Error("Native no-U verification refused");
		if (i > 0) times.push(performance.now() - start);
	}
	const p95 = times.slice().sort((a, b) => a - b)[Math.ceil(.95 * count) - 1];
	if (p95 > 2000 || resumes !== count + 1 || lists < count + 1) throw new Error("Native warmed responsiveness target missed");
	return { samples: count, items: itemCount, p95_ms: Number(p95.toFixed(2)), resumes, lists, turn_starts: 0 };
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const get = (key: string) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined; };
	const session = get("--session"), codex = get("--codex"), nonce = get("--nonce"), phase = get("--phase");
	if (!session || !codex || !nonce || !["first-recall", "reopened-recall"].includes(phase ?? "")) throw new Error("Require --session --codex --nonce --phase first-recall|reopened-recall");
	const result = await inspect(session, codex, nonce);
	const later = phase === "reopened-recall";
	if (result.bindings !== 1 || result.user_turns !== (later ? 4 : 2) || result.interrupted !== (later ? 2 : 1) || result.completed !== (later ? 2 : 1) || result.nonce_inputs !== 1 || !result.nonce_recall || result.sleep_commands !== (later ? 2 : 1)) throw new Error("Native retained-context counts differ");
	console.log(Object.entries(result).map(([key, value]) => `${key}=${value}`).join(" "));
}
