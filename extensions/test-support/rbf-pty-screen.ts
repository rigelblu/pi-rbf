// The final screen of a Pi run under a pseudo-terminal, replayed from every byte it wrote.
// A small terminal: enough of one for what Pi's two TUI modes emit (row addressing, relative moves,
// erase in line and in display, the alternate screen, colors), so a test can assert on what a user would see
// rather than on what scrolled past in the stream.

export type Cell = { ch: string; fg: string; bg: string; bold: boolean; dim: boolean; inverse: boolean };
export type Screen = { cells: Cell[][]; lines: string[] };
/** The terminal's size from byte `at` on, for a run that resized it. */
export type Resize = { at: number; cols: number; rows: number };

const TOKEN = /\x1b\[([0-9;?<>=]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x1b]*(?:\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>78DEMc]|([\x00-\x1a\x1c-\x1f])|([^\x00-\x1f]+)/gy;

export function replayScreen(raw: Buffer, cols: number, rows: number, resizes: Resize[] = []): Screen {
	const blank = (): Cell => ({ ch: " ", fg: "", bg: "", bold: false, dim: false, inverse: false });
	const grid = (r: number, c: number) => Array.from({ length: r }, () => Array.from({ length: c }, blank));
	let screen = grid(rows, cols);
	let saved = screen;
	let row = 0;
	let col = 0;
	let pen = blank();

	const resize = (c: number, r: number) => {
		const next = grid(r, c);
		for (let y = 0; y < Math.min(r, rows); y++) for (let x = 0; x < Math.min(c, cols); x++) next[y]![x] = screen[y]![x]!;
		screen = next;
		cols = c;
		rows = r;
		row = Math.min(row, rows - 1);
		col = Math.min(col, cols - 1);
	};
	const lineFeed = () => {
		if (row < rows - 1) row++;
		else {
			screen.shift();
			screen.push(Array.from({ length: cols }, blank));
		}
	};
	const color = (params: number[], i: number): [string, number] => {
		if (params[i + 1] === 5) return [`5;${params[i + 2]}`, i + 2];
		if (params[i + 1] === 2) return [`2;${params[i + 2]};${params[i + 3]};${params[i + 4]}`, i + 4];
		return ["", i];
	};
	const sgr = (text: string) => {
		const params = text === "" ? [0] : text.split(";").map((p) => parseInt(p, 10) || 0);
		for (let i = 0; i < params.length; i++) {
			const p = params[i]!;
			if (p === 0) pen = blank();
			else if (p === 1) pen.bold = true;
			else if (p === 2) pen.dim = true;
			else if (p === 22) pen.bold = pen.dim = false;
			else if (p === 7) pen.inverse = true;
			else if (p === 27) pen.inverse = false;
			else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) pen.fg = String(p);
			else if (p === 39) pen.fg = "";
			else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) pen.bg = String(p);
			else if (p === 49) pen.bg = "";
			else if (p === 38) [pen.fg, i] = color(params, i);
			else if (p === 48) [pen.bg, i] = color(params, i);
		}
	};
	const erase = (y: number, from: number, to: number) => {
		for (let x = Math.max(0, from); x < Math.min(cols, to); x++) screen[y]![x] = { ...blank(), bg: pen.bg };
	};

	const pending = [...resizes].sort((a, b) => a.at - b.at);
	const text = raw.toString("utf8");
	// Offsets in `resizes` count bytes; the replay walks characters, so it tracks how many bytes it has passed.
	let bytes = 0;
	TOKEN.lastIndex = 0;
	for (let m = TOKEN.exec(text); m; m = TOKEN.exec(text)) {
		while (pending.length > 0 && bytes >= pending[0]!.at) {
			const next = pending.shift()!;
			resize(next.cols, next.rows);
		}
		bytes += Buffer.byteLength(m[0]);
		if (m[2] !== undefined) {
			const args = (m[1] ?? "").split(";").map((p) => parseInt(p, 10) || 0);
			const n = args[0] || 1;
			switch (m[2]) {
				case "H":
				case "f":
					row = Math.min(rows - 1, Math.max(0, (args[0] || 1) - 1));
					col = Math.min(cols - 1, Math.max(0, (args[1] || 1) - 1));
					break;
				case "A":
					row = Math.max(0, row - n);
					break;
				case "B":
					row = Math.min(rows - 1, row + n);
					break;
				case "C":
					col = Math.min(cols - 1, col + n);
					break;
				case "D":
					col = Math.max(0, col - n);
					break;
				case "G":
					col = Math.min(cols - 1, n - 1);
					break;
				case "d":
					row = Math.min(rows - 1, n - 1);
					break;
				case "K":
					if (args[0] === 1) erase(row, 0, col + 1);
					else if (args[0] === 2) erase(row, 0, cols);
					else erase(row, col, cols);
					break;
				case "J":
					if (args[0] === 2 || args[0] === 3) for (let y = 0; y < rows; y++) erase(y, 0, cols);
					else if (args[0] === 1) {
						for (let y = 0; y < row; y++) erase(y, 0, cols);
						erase(row, 0, col + 1);
					} else {
						erase(row, col, cols);
						for (let y = row + 1; y < rows; y++) erase(y, 0, cols);
					}
					break;
				case "m":
					if (!(m[1] ?? "").startsWith("?") && !(m[1] ?? "").startsWith(">")) sgr(m[1] ?? "");
					break;
				case "h":
				case "l":
					if (m[1] === "?1049") {
						// The alternate screen starts blank; leaving it brings the first one back.
						if (m[2] === "h") {
							saved = screen;
							screen = grid(rows, cols);
						} else screen = saved.length === rows ? saved : grid(rows, cols);
						row = col = 0;
					}
					break;
			}
		} else if (m[3] !== undefined) {
			if (m[3] === "\n") lineFeed();
			else if (m[3] === "\r") col = 0;
			else if (m[3] === "\b") col = Math.max(0, col - 1);
			else if (m[3] === "\t") col = Math.min(cols - 1, (Math.floor(col / 8) + 1) * 8);
		} else if (m[4] !== undefined) {
			for (const ch of m[4]) {
				if (col >= cols) continue; // Pi turns line wrap off: what doesn't fit is not drawn
				screen[row]![col] = { ...pen, ch };
				col++;
			}
		}
	}
	return { cells: screen, lines: screen.map((cells) => cells.map((cell) => cell.ch).join("").trimEnd()) };
}
