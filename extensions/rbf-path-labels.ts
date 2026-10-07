import { relative, resolve, isAbsolute, sep } from "node:path";
import { AssistantMessageComponent, FooterComponent, InteractiveMode } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Editor, getCapabilities, Markdown, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const OWNER = Symbol.for("rbf.pathLabels.owner");
const TOKEN_RENDERERS = Symbol.for("rbf.pathLabels.tokenRenderers");
type TokenRendererRegistry = typeof globalThis & { [TOKEN_RENDERERS]?: WeakMap<Function, object> };

// Copying may recognize only actual path-label wrappers over an inherited
// native token renderer. A pre-existing custom delegate is not such a seam.
export function isPathLabelTokenRenderer(render: Function, native: Function): boolean {
	const prototype = (globalThis as TokenRendererRegistry)[TOKEN_RENDERERS]?.get(render) as Native | undefined;
	return !!prototype && Object.getOwnPropertyDescriptor(prototype, "renderToken")?.value === native;
}

const PI_THEME = Symbol.for("@earendil-works/pi-coding-agent:theme");
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const unsafe = /[\x00-\x1f\x7f-\x9f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;

type Token = {
	type: string;
	raw?: string;
	text?: string;
	href?: string;
	tokens?: Token[];
	depth?: number;
	header?: Token[];
	rows?: Token[][];
};
type Native = Record<string, any>;
type Notify = (surface: string) => void;

function methodCleanup(targetRef: WeakRef<Native>, key: string, wrappedRef: WeakRef<Function>, originalRef?: WeakRef<Function>): () => void {
	return () => {
		const target = targetRef.deref();
		const wrapped = wrappedRef.deref();
		if (!target || !wrapped || target[key] !== wrapped) return;
		if (originalRef) target[key] = originalRef.deref();
		else delete target[key];
		if (Object.prototype.hasOwnProperty.call(target, "cachedText")) target.invalidate?.();
	};
}


// ─────────────────────────────────────────────────────────────────────────────
// Cell-aware display values

function graphemes(text: string): string[] {
	return Array.from(segmenter.segment(text), (part) => part.segment);
}

function takeCells(text: string, width: number, fromEnd = false): string {
	const parts = graphemes(text);
	if (fromEnd) parts.reverse();
	const kept: string[] = [];
	let used = 0;
	for (const part of parts) {
		const cells = visibleWidth(part);
		if (used + cells > width) break;
		kept.push(part);
		used += cells;
	}
	return (fromEnd ? kept.reverse() : kept).join("");
}

export function formatPathLabel(path: string, budget: number): string {
	const width = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0;
	if (!path || !width) return "";
	if (unsafe.test(path) || path.includes("…") || visibleWidth(path) <= width) return path;
	if (width === 1) return "…";
	const end = path.endsWith("/") ? path.length - 1 : path.length;
	const slash = path.lastIndexOf("/", end - 1);
	const filename = path.slice(slash + 1);
	if (visibleWidth(`…/${filename}`) <= width && slash >= 0) {
		// Every considered prefix ends before the last directory: at least one is omitted.
		for (let i = slash - 1; i >= 0; i--) {
			if (path[i] !== "/") continue;
			const candidate = `${path.slice(0, i + 1)}…/${filename}`;
			if (visibleWidth(candidate) <= width) return candidate;
		}
		return `…/${filename}`;
	}
	if (visibleWidth(filename) <= width) return filename;
	const dot = filename.lastIndexOf(".");
	const extension = dot > 0 && !filename.endsWith("/") ? filename.slice(dot) : "";
	const stem = extension ? filename.slice(0, dot) : filename;
	const prefix = takeCells(stem, width - visibleWidth(extension) - 1);
	if (prefix) return `${prefix}…${extension}`;
	return `…${takeCells(filename, width - 1, true)}`;
}

function isPath(text: string, filenameOnly = false): boolean {
	return !!text && !unsafe.test(text) && !/[`\[\]{}<>|;&$*?\\"']|…/.test(text)
		&& !/^[a-z][a-z\d+.-]*:\/\//i.test(text)
		&& !/(?:^|\s)--?\w/.test(text)
		&& !/\s(?:~\/|\.{1,2}\/|\/)/.test(text)
		&& (filenameOnly || /^(?:~\/|\.{1,2}\/|\/)/.test(text) || !/\s+[^\s/]+\//.test(text))
		&& (filenameOnly || /^(?:~\/|\.{1,2}\/|\/)/.test(text) || /^[^\s/]+\/.+/.test(text));
}

const instructionWords = /\b(?:run|execute|invoke|launch|start|try|install|delete|remove|copy|move|cat|cd|cp|mv|rm|sudo|bash|sh|npm|npx|bun|python\d*|chmod|source)\b/i;

function referenceContext(raw: string): boolean {
	const text = raw.trim().replace(/^[ \t]*(?:(?:[-+*]|\d+[.)]|>|#{1,6})\s+)+/gm, "");
	if (instructionWords.test(text)
		|| /(?:^|\s)--?\w|[|;&$<>]/.test(text)
		|| (text.match(/`/g)?.length ?? 0) % 2 !== 0
		|| /\[[^\]\n]*$|\]\([^\)\n]*$/.test(text)) return false;
	// Standalone references and explicit reference prose form the allowlist.
	if (/^(?:`[^`]+`|\[[^\]\n]+\]\([^\n]+\)|(?:~\/|\.{1,2}\/|\/)[^\n]+)$/.test(text)) return true;
	return /^(?:see|file|path|reference|references|updated|changed|created|found|located|here (?:is|are)|the (?:file|path|reference|verification)|verification (?:brief|file))\b/i.test(text);
}

type Location = { line: string; column?: string };
function position(fragment: string): Location | undefined {
	const match = /^L([1-9]\d*)(?:C([1-9]\d*))?$/.exec(fragment);
	return match ? { line: match[1], ...(match[2] ? { column: match[2] } : {}) } : undefined;
}

export function isLocalFileReference(label: string, href: string): boolean {
	if (!isPath(label, true) || unsafe.test(href) || /[\s<>`]/.test(href)) return false;
	let target = href;
	let targetPosition: Location | undefined;
	try {
		if (/^file:/i.test(href)) {
			const url = new URL(href);
			if (url.protocol !== "file:" || url.host || url.search || !href.startsWith("file:///")) return false;
			target = decodeURIComponent(url.pathname);
			if (url.hash) {
				targetPosition = position(url.hash.slice(1));
				if (!targetPosition) return false;
			}
		} else {
			if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//") || href.includes("?")) return false;
			const hash = href.indexOf("#");
			if (hash >= 0) {
				targetPosition = position(href.slice(hash + 1));
				if (!targetPosition) return false;
				target = href.slice(0, hash);
			}
			target = decodeURIComponent(target);
		}
	} catch { return false; }
	if (!isPath(target, true)) return false;
	const basename = (path: string) => path.replace(/\/$/, "").split("/").at(-1);
	if (basename(label) === basename(target)) return true;
	const match = /^(.*?):([1-9]\d*)(?::([1-9]\d*))?$/.exec(label);
	if (!match || basename(match[1]) !== basename(target)) return false;
	return !targetPosition || (match[2] === targetPosition.line
		&& (!match[3] || targetPosition.column === undefined || match[3] === targetPosition.column));
}

function referenceLabel(path: string, width: number, block: string, inline: string): string {
	const display = formatPathLabel(path, width);
	if (!display || block.trim() === inline.trim()) return display;
	// Ask native wrapping whether preceding prose can split this label internally.
	const probe = wrapTextWithAnsi(`x ${display}`, visibleWidth(display));
	return probe[0]?.trim() !== "x" ? `\n${display}\n` : display;
}

function projectBarePaths(text: string, width: number): string {
	return text.replace(/(?:~\/|\.{1,2}\/|\/)[^\s`\[\]<>"'|;$]+/g, (candidate, offset: number) => {
		if (offset && /[\w:/]/.test(text[offset - 1])) return candidate;
		const path = candidate.replace(/[.,:!?]+$/, "");
		return isPath(path) ? referenceLabel(path, width, text, candidate) + candidate.slice(path.length) : candidate;
	});
}

export function projectInlineReferences(tokens: Token[], width: number, raw: string): Token[] {
	if (!referenceContext(raw)) return tokens;
	return tokens.map((token) => {
		if (token.type === "link" && token.text && token.href && isLocalFileReference(token.text, token.href)) {
			const text = referenceLabel(token.text, width, raw, token.raw ?? token.text);
			if (!getCapabilities().hyperlinks) return { type: "text", raw: text, text };
			return { ...token, text, tokens: [{ type: "text", raw: text, text }] };
		}
		if (token.type === "codespan" && token.text && isPath(token.text)) {
			return { ...token, text: referenceLabel(token.text, width, raw, token.raw ?? token.text) };
		}
		if (["text", "paragraph", "strong", "em", "del"].includes(token.type)) {
			if (token.tokens) return { ...token, tokens: projectInlineReferences(token.tokens, width, raw) };
			if (token.type === "text" && token.text && !token.text.includes("`")) return { ...token, text: projectBarePaths(token.text, width) };
		}
		return token;
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Owned native rendering seams

export function installPathLabels(notify: Notify = () => {}): () => void {
	const registry = globalThis as typeof globalThis & { [OWNER]?: { dispose: () => void } };
	registry[OWNER]?.dispose();
	let active = true;
	const cleanups: (() => void)[] = [];
	const markdownOwners = new WeakSet<object>();
	const diagnostics = new Set<string>();
	const warn = (surface: string) => {
		if (!diagnostics.has(surface)) { diagnostics.add(surface); notify(surface); }
	};
	function own(target: Native, key: string, wrapper: (original: (...args: any[]) => any) => (...args: any[]) => any): boolean {
		const captured = target[key];
		if (typeof captured !== "function") return false;
		const hadOwn = Object.prototype.hasOwnProperty.call(target, key);
		// An instance must keep observing later native/prototype display owners.
		const original = hadOwn ? captured : function (this: Native, ...args: any[]) {
			const inherited = Reflect.get(Object.getPrototypeOf(target), key);
			return (typeof inherited === "function" ? inherited : captured).apply(this, args);
		};
		const wrapped = wrapper(original);
		target[key] = wrapped;
		if (key === "renderToken" && !hadOwn) {
			const registry = globalThis as TokenRendererRegistry;
			(registry[TOKEN_RENDERERS] ??= new WeakMap()).set(wrapped, Object.getPrototypeOf(target));
		}
		// Streaming replaces components; the session owner must not retain their old text.
		cleanups.push(methodCleanup(new WeakRef(target), key, new WeakRef(wrapped), hadOwn ? new WeakRef(captured) : undefined));
		return true;
	}
	function ownMarkdown(md: Native): void {
		if (markdownOwners.has(md)) return;
		if (!["renderToken", "renderInlineTokens", "renderTable", "wrapCellText"].every((key) => typeof md[key] === "function")) {
			warn("assistant layout"); return;
		}
		markdownOwners.add(md);
		let hyperlinks = getCapabilities().hyperlinks;
		let renderDepth = 0;
		let instructionPending = false;
		own(md, "render", (original) => function (this: Native, width: number) {
			renderDepth = 0;
			instructionPending = false;
			if (active && hyperlinks !== getCapabilities().hyperlinks) {
				hyperlinks = getCapabilities().hyperlinks;
				this.invalidate?.();
			}
			return original.call(this, width);
		});
		const blocked = new WeakSet<object>();
		function block(token: Native): void {
			blocked.add(token);
			for (const child of token.tokens ?? []) block(child);
			for (const item of token.items ?? []) block(item);
		}
		if (typeof md.renderList === "function") own(md, "renderList", (original) => function (this: Native, token: Native, ...args: any[]) {
			if (active) for (const item of token.items ?? []) {
				const context = (item.raw ?? "").replace(/^[ \t]*(?:(?:[-+*]|\d+[.)]|>)\s+)+/gm, "");
				if (!referenceContext(context)) block(item);
			}
			return original.call(this, token, ...args);
		});
		own(md, "renderToken", (original) => function (this: Native, token: Token, width: number, ...rest: any[]) {
			if (active && token.type === "blockquote" && !referenceContext(token.raw ?? "")) block(token);
			const raw = token.raw ?? token.text ?? "";
			// Follow native sibling-token order, so repeated source text cannot erase intent.
			if (active && renderDepth === 0) {
				if (token.type !== "list" && instructionWords.test(raw)) instructionPending = true;
				else if (referenceContext(raw) && /^(?:see|file|path|reference|references|updated|changed|created|found|located|here|the|verification)\b/i.test(raw.trim())) instructionPending = false;
				if (instructionPending) block(token);
			}
			renderDepth++;
			try {
			if (!active || blocked.has(token) || !["heading", "paragraph", "text"].includes(token.type)) return original.call(this, token, width, ...rest);
			const budget = Math.max(0, width - (token.type === "heading" && (token.depth ?? 0) >= 3 ? (token.depth ?? 0) + 1 : 0));
			const projected = token.tokens
				? { ...token, tokens: projectInlineReferences(token.tokens, budget, raw) }
				: projectInlineReferences([token], budget, raw)[0];
			return original.call(this, projected, width, ...rest).flatMap((line: string) => wrapTextWithAnsi(line, width));
			} finally { renderDepth--; }
		});
		own(md, "renderTable", (original) => function (this: Native, token: Token, width: number, next?: string, style?: any) {
			if (!active || blocked.has(token) || !Array.isArray(token.header) || !Array.isArray(token.rows)) return original.call(this, token, width, next, style);
			const cells = [...token.header, ...token.rows.flat()];
			const originalWrap = this.wrapCellText;
			const hadOwn = Object.prototype.hasOwnProperty.call(this, "wrapCellText");
			let index = 0;
			let mismatch = false;
			const wrapped = (text: string, cellWidth: number, prefix?: string) => {
				const cell = cells[index++];
				if (!cell || this !== md || text !== this.renderInlineTokens(cell.tokens ?? [], style) || !Number.isFinite(cellWidth)) {
					mismatch = true;
					return originalWrap.call(this, text, cellWidth, prefix);
				}
				const tokens = projectInlineReferences(cell.tokens ?? [], cellWidth, cell.raw ?? cell.text ?? "");
				return originalWrap.call(this, this.renderInlineTokens(tokens, style), cellWidth, prefix);
			};
			this.wrapCellText = wrapped;
			let lines: string[];
			try { lines = original.call(this, token, width, next, style); }
			finally {
				if (this.wrapCellText === wrapped) {
					if (hadOwn) this.wrapCellText = originalWrap;
					else delete this.wrapCellText;
				} else mismatch = true;
			}
			if (mismatch || (index > 0 && index !== cells.length)) {
				warn("table layout");
				return original.call(this, token, width, next, style);
			}
			if (!index && cells.length && width >= 4 * token.header.length + 1) warn("table layout");
			return lines;
		});
		md.invalidate?.();
	}
	if (!own(AssistantMessageComponent.prototype as unknown as Native, "render", (original) => function (this: Native, width: number) {
		if (active) {
			const children = this.contentContainer?.children;
			const content = this.lastMessage?.content;
			if (Array.isArray(children) && Array.isArray(content)) {
				const texts = content.filter((c: Native) => c.type === "text").map((c: Native) => c.text.trim()).filter(Boolean);
				let matched = 0;
				for (const child of children) if (child instanceof Markdown && texts.includes((child as unknown as Native).text)) { ownMarkdown(child as unknown as Native); matched++; }
				if (matched < texts.length) warn("assistant layout");
			} else warn("assistant layout");
		}
		return original.call(this, width);
	})) warn("assistant layout");

	if (!own(FooterComponent.prototype as unknown as Native, "render", (original) => function (this: Native, width: number) {
		const lines = original.call(this, width);
		if (!active || Reflect.get(FooterComponent.prototype, Symbol.for("rbf.statusLine.footerPatched"))) return lines;
		const manager = this.session?.sessionManager;
		const theme = Reflect.get(globalThis, PI_THEME) as Theme | undefined;
		if (!manager?.getCwd || !this.footerData?.getGitBranch || typeof theme?.fg !== "function") { warn("footer layout"); return lines; }
		const cwd = manager.getCwd();
		if (typeof cwd !== "string" || unsafe.test(cwd)) return lines;
		let path = cwd;
		const homeDirectory = process.env.HOME || process.env.USERPROFILE;
		if (homeDirectory) {
			const relativePath = relative(resolve(homeDirectory), resolve(cwd));
			if (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)) path = relativePath ? `~${sep}${relativePath}` : "~";
		}
		const branch = this.footerData.getGitBranch();
		const name = manager.getSessionName?.();
		const suffix = (branch ? ` (${branch})` : "") + (name ? ` • ${name}` : "");
		const expected = truncateToWidth(theme.fg("dim", path + suffix), width, theme.fg("dim", "..."));
		if (lines[0] !== expected) { warn("footer layout"); return lines; }
		const budget = width - visibleWidth(suffix);
		if (budget <= 0) return lines;
		return [theme.fg("dim", formatPathLabel(path, budget) + suffix), ...lines.slice(1)];
	})) warn("footer layout");

	if (!own(InteractiveMode.prototype as unknown as Native, "handleSessionCommand", (original) => function (this: Native, ...args: any[]) {
		if (!active) return original.apply(this, args);
		const path = this.session?.getSessionStats?.().sessionFile;
		const before = this.chatContainer?.children?.length;
		const result = original.apply(this, args);
		if (!isPath(path ?? "")) return result;
		if (typeof before !== "number" || !Array.isArray(this.chatContainer?.children)) { warn("session layout"); return result; }
		let owned = false;
		for (const child of this.chatContainer.children.slice(before)) {
			if (!(child instanceof Text)) continue;
			owned = true;
			const text = child as unknown as Native;
			if (!own(text, "render", (render) => function (this: Native, width: number) {
				// Pi 1.0 rebuilds ThemedText on invalidation. Let it refresh the original first.
				const native = render.call(this, width);
				if (!active) return native;
				if (typeof this.text !== "string" || !Number.isFinite(this.paddingX)) { warn("session layout"); return native; }
				const originalText: string = this.text;
				const targetLine = originalText.split("\n").find((line) => line.replace(/\x1b\[[\d;]*m/g, "") === `File: ${path}`);
				if (!targetLine) { warn("session layout"); return native; }
				const padding = Math.min(this.paddingX, Math.max(0, Math.floor((width - 1) / 2)));
				const display = formatPathLabel(path, Math.max(0, width - 2 * padding - 6));
				const copy = new Text(originalText.replace(targetLine, targetLine.slice(0, -path.length) + display), this.paddingX, this.paddingY, this.customBgFn);
				return copy.render(width);
			})) warn("session layout");
		}
		if (!owned) warn("session layout");
		return result;
	})) warn("session layout");

	if (!own(Editor.prototype as unknown as Native, "createAutocompleteList", (original) => function (this: Native, prefix: string, items: any[]) {
		const list = original.call(this, prefix, items);
		if (!active || !prefix.startsWith("@")) return list;
		if (!list || typeof list.truncatePrimary !== "function") { warn("autocomplete layout"); return list; }
		if (!own(list, "renderItem", (render) => function (this: Native, item: Native, selected: boolean, width: number, description: string, primary: number) {
			if (!active || !isPath(description ?? "") || width <= 40) return render.call(this, item, selected, width, description, primary);
			const column = Math.max(1, Math.min(primary, width - 6));
			const primaryText = this.truncatePrimary(item, selected, Math.max(1, column - 2), column);
			const spacing = Math.max(1, column - visibleWidth(primaryText));
			const budget = width - 2 - visibleWidth(primaryText) - spacing - 2;
			return render.call(this, item, selected, width, budget > 10 ? formatPathLabel(description, budget) : description, primary);
		})) warn("autocomplete layout");
		return list;
	})) warn("autocomplete layout");

	const owner = { dispose: () => {
		if (!active) return;
		active = false;
		for (const cleanup of cleanups.reverse()) cleanup();
		if (registry[OWNER] === owner) delete registry[OWNER];
	} };
	registry[OWNER] = owner;
	return owner.dispose;
}


// ─────────────────────────────────────────────────────────────────────────────
// Extension lifecycle

export default function pathLabels(pi: ExtensionAPI): void {
	let enabled = false;
	let dispose: (() => void) | undefined;
	// Source stays byte-for-byte intact. Owned parsed leaves supply the actual local budget.
	pi.registerMarkdownTransformer((source) => source);
	pi.on("session_start", (_event, ctx) => {
		dispose?.();
		enabled = ctx.hasUI;
		if (enabled) dispose = installPathLabels((surface) => ctx.ui.notify(`Path labels: unsupported ${surface}; using native rendering.`, "warning"));
	});
	pi.on("session_shutdown", () => {
		enabled = false;
		dispose?.();
		dispose = undefined;
	});
}
