import { createInterface } from "node:readline";

const text = "line\u2028paragraph\u2029emoji🪐\r\nnext";
const chunked = process.argv.includes("--chunked");

/** Returns history or fragmented frames without escaping Unicode separators. */
createInterface({ input: process.stdin }).on("line", async (line) => {
	const request = JSON.parse(line);
	if (request.id === undefined) return;
	if (!chunked) {
		process.stdout.write(JSON.stringify({ id: request.id, result: { data: [{ id: "checkpoint", status: "completed", items: [{ id: "user", type: "userMessage", content: [{ type: "text", text }] }] }], nextCursor: null } }) + "\n");
		return;
	}
	const notice = JSON.stringify({ method: "fixture/notice", params: { text } });
	const reply = JSON.stringify({ id: request.id, result: { text } });
	const last = JSON.stringify({ method: "fixture/eof", params: { text } });
	const bytes = Buffer.from(notice + "\n" + reply + "\r\n" + last);
	const separator = bytes.indexOf(Buffer.from("\u2028"));
	const emoji = bytes.indexOf(Buffer.from("🪐"));
	const boundaries = [separator + 1, separator + 2, emoji + 1, emoji + 3, bytes.length];
	let start = 0;
	for (const end of boundaries) {
		process.stdout.write(bytes.subarray(start, end));
		start = end;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	process.stdout.end(() => process.exit(0));
});
