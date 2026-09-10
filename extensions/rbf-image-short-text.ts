import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	InputEvent,
	InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { CustomEditor, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export const PATCHED_SYMBOL = Symbol.for("rbf.imageShortText.patched");
export const EDITOR_PATCHED_SYMBOL = Symbol.for("rbf.imageShortText.editorPatched");
export const ACTIVE_MANAGER_SYMBOL = Symbol.for("rbf.imageShortText.activeManager");
export const ORIGINAL_PASTE_KEY = Symbol.for("rbf.imageShortText.originalHandlePaste");
export const ORIGINAL_INSERT_KEY = Symbol.for("rbf.imageShortText.originalInsertTextAtCursor");

export interface ImageEntry {
	chip: string;
	filePath: string;
	mimeType: string;
	data: string; // base64
}

export function normalizePastedPath(input: string): string {
	if (typeof input !== "string") {
		return "";
	}
	let s = input.trim();
	// Strip surrounding double or single quotes
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		s = s.slice(1, -1).trim();
	}
	// Strip file:// scheme if present
	if (s.startsWith("file://")) {
		try {
			s = decodeURIComponent(new URL(s).pathname);
		} catch {
			s = decodeURIComponent(s.slice(7));
		}
	}
	// Unescape terminal-escaped spaces (e.g. "/path/to/my\ image.png")
	s = s.replace(/\\ /g, " ");
	return s;
}

export function isClipboardImageFile(filePath: string): boolean {
	if (typeof filePath !== "string" || !filePath.trim()) {
		return false;
	}
	// Reject multi-line text (pasting text or code blocks that mention paths)
	if (filePath.includes("\n") || filePath.includes("\r")) {
		return false;
	}
	const cleaned = normalizePastedPath(filePath);
	if (!cleaned) {
		return false;
	}
	const fileName = path.basename(cleaned);
	if (!fileName.startsWith("clipboard-") && !fileName.startsWith("pi-clipboard-")) {
		return false;
	}
	const ext = path.extname(cleaned).toLowerCase();
	if (![".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) {
		return false;
	}

	const resolvedPath = path.resolve(cleaned);
	const resolvedTmp = path.resolve(os.tmpdir());
	const dir = path.dirname(resolvedPath);

	const isInTempDir =
		dir === resolvedTmp ||
		resolvedPath.startsWith(resolvedTmp + path.sep) ||
		resolvedPath.startsWith("/tmp/") ||
		resolvedPath.startsWith("/private/tmp/") ||
		resolvedPath.startsWith("/var/tmp/") ||
		resolvedPath.startsWith("/var/folders/");

	if (!isInTempDir) {
		return false;
	}

	try {
		const stat = fs.statSync(cleaned);
		if (!stat.isFile() || stat.size === 0) {
			return false;
		}
		// Max file size: 25MB to prevent Node OOM
		if (stat.size > 25 * 1024 * 1024) {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

export function extractMimeType(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	switch (ext) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".webp":
			return "image/webp";
		case ".gif":
			return "image/gif";
		case ".png":
		default:
			return "image/png";
	}
}

export function allocateNextChip(currentText: string): string {
	const regex = /\[Image\s+#?(\d+)\]/gi;
	const usedNumbers = new Set<number>();
	let match: RegExpExecArray | null;
	while ((match = regex.exec(currentText)) !== null) {
		const num = parseInt(match[1], 10);
		if (!Number.isNaN(num) && num > 0) {
			usedNumbers.add(num);
		}
	}
	let candidate = 1;
	while (usedNumbers.has(candidate)) {
		candidate++;
	}
	return `[Image #${candidate}]`;
}

export class ImageShortTextManager {
	private activeImages = new Map<string, ImageEntry>();

	public registerImage(chip: string, entry: ImageEntry): void {
		this.activeImages.set(chip, entry);
	}

	public getImage(chip: string): ImageEntry | undefined {
		return this.activeImages.get(chip);
	}

	public getActiveEntries(): ImageEntry[] {
		return Array.from(this.activeImages.values());
	}

	public clear(): void {
		this.activeImages.clear();
	}

	public handlePaste(pastedText: string, currentText: string): { chip: string; entry: ImageEntry } | null {
		if (!isClipboardImageFile(pastedText)) {
			return null;
		}
		const filePath = normalizePastedPath(pastedText);
		const chip = allocateNextChip(currentText);
		const mimeType = extractMimeType(filePath);
		let data: string;
		try {
			const buffer = fs.readFileSync(filePath);
			data = buffer.toString("base64");
		} catch {
			return null;
		}

		const entry: ImageEntry = {
			chip,
			filePath,
			mimeType,
			data,
		};
		this.registerImage(chip, entry);
		return { chip, entry };
	}

	public transformInput(text: string): { action: "transform"; text: string; images: ImageContent[] } | null {
		const regex = /\[Image\s+#?(\d+)\]/gi;
		const foundNumbers = new Set<number>();
		let match: RegExpExecArray | null;
		while ((match = regex.exec(text)) !== null) {
			const num = parseInt(match[1], 10);
			if (!Number.isNaN(num) && num > 0) {
				foundNumbers.add(num);
			}
		}

		const images: ImageContent[] = [];
		for (const num of foundNumbers) {
			const entry = this.activeImages.get(`[Image #${num}]`) ?? this.activeImages.get(`[Image ${num}]`);
			if (entry) {
				images.push({
					type: "image",
					mimeType: entry.mimeType,
					data: entry.data,
				});
			}
		}

		if (images.length > 0) {
			return {
				action: "transform",
				text,
				images,
			};
		}

		return null;
	}
}

export function setActiveManager(manager: ImageShortTextManager | undefined): void {
	(globalThis as any)[ACTIVE_MANAGER_SYMBOL] = manager;
}

export function getActiveManager(): ImageShortTextManager | undefined {
	return (globalThis as any)[ACTIVE_MANAGER_SYMBOL];
}

export function patchEditorPaste(): void {
	const protos: any[] = [];
	if (typeof Editor !== "undefined" && Editor?.prototype) {
		protos.push(Editor.prototype);
	}
	if (typeof CustomEditor !== "undefined" && CustomEditor?.prototype) {
		protos.push(CustomEditor.prototype);
	}

	for (const proto of protos) {
		if (proto[EDITOR_PATCHED_SYMBOL]) {
			continue;
		}
		proto[EDITOR_PATCHED_SYMBOL] = true;

		const originalHandlePaste = proto.handlePaste;
		if (typeof originalHandlePaste === "function") {
			proto[ORIGINAL_PASTE_KEY] = originalHandlePaste;
			proto.handlePaste = function (this: any, pastedText: string): void {
				const manager = getActiveManager();
				if (!manager || typeof pastedText !== "string") {
					return originalHandlePaste.call(this, pastedText);
				}

				const currentText = typeof this.getText === "function" ? this.getText() : "";
				const result = manager.handlePaste(pastedText, currentText);
				if (result) {
					// Check if a space is needed before the chip
					const currentLine = this.state?.lines?.[this.state.cursorLine] ?? "";
					const charBeforeCursor = this.state?.cursorCol > 0 ? currentLine[this.state.cursorCol - 1] : "";
					let chipToInsert = result.chip;
					if (charBeforeCursor && /\w/.test(charBeforeCursor)) {
						chipToInsert = ` ${chipToInsert}`;
					}
					return originalHandlePaste.call(this, chipToInsert);
				}

				return originalHandlePaste.call(this, pastedText);
			};
		}

		const originalInsertTextAtCursor = proto.insertTextAtCursor;
		if (typeof originalInsertTextAtCursor === "function") {
			proto[ORIGINAL_INSERT_KEY] = originalInsertTextAtCursor;
			proto.insertTextAtCursor = function (this: any, text: string): void {
				const manager = getActiveManager();
				if (!manager || typeof text !== "string") {
					return originalInsertTextAtCursor.call(this, text);
				}

				const currentText = typeof this.getText === "function" ? this.getText() : "";
				const result = manager.handlePaste(text, currentText);
				if (result) {
					const currentLine = this.state?.lines?.[this.state.cursorLine] ?? "";
					const charBeforeCursor = this.state?.cursorCol > 0 ? currentLine[this.state.cursorCol - 1] : "";
					let chipToInsert = result.chip;
					if (charBeforeCursor && /\w/.test(charBeforeCursor)) {
						chipToInsert = ` ${chipToInsert}`;
					}
					return originalInsertTextAtCursor.call(this, chipToInsert);
				}

				return originalInsertTextAtCursor.call(this, text);
			};
		}
	}
}

export function unpatchEditorPaste(): void {
	const protos: any[] = [];
	if (typeof Editor !== "undefined" && Editor?.prototype) {
		protos.push(Editor.prototype);
	}
	if (typeof CustomEditor !== "undefined" && CustomEditor?.prototype) {
		protos.push(CustomEditor.prototype);
	}

	for (const proto of protos) {
		const origPaste = proto[ORIGINAL_PASTE_KEY];
		if (origPaste) {
			proto.handlePaste = origPaste;
			delete proto[ORIGINAL_PASTE_KEY];
		}
		const origInsert = proto[ORIGINAL_INSERT_KEY];
		if (origInsert) {
			proto.insertTextAtCursor = origInsert;
			delete proto[ORIGINAL_INSERT_KEY];
		}
		delete proto[EDITOR_PATCHED_SYMBOL];
	}
}

export function patchInteractiveModePaste(): void {
	if (typeof InteractiveMode === "undefined" || !InteractiveMode || !InteractiveMode.prototype) {
		return;
	}
	if ((InteractiveMode.prototype as any)[PATCHED_SYMBOL]) {
		return;
	}

	const originalHandleClipboardPaste = (InteractiveMode.prototype as any).handleClipboardPaste;
	if (typeof originalHandleClipboardPaste !== "function") {
		return;
	}

	(InteractiveMode.prototype as any)[PATCHED_SYMBOL] = true;
	(InteractiveMode.prototype as any)[Symbol.for("rbf.imageShortText.origInteractivePaste")] = originalHandleClipboardPaste;

	(InteractiveMode.prototype as any).handleClipboardPaste = async function (this: any) {
		const manager = getActiveManager();
		if (!manager || !this.editor?.insertTextAtCursor) {
			return originalHandleClipboardPaste.call(this);
		}

		const origInsert = this.editor.insertTextAtCursor;
		let interceptedText: string | undefined;
		this.editor.insertTextAtCursor = (text: string) => {
			interceptedText = text;
		};

		try {
			await originalHandleClipboardPaste.call(this);
		} finally {
			this.editor.insertTextAtCursor = origInsert;
		}

		if (interceptedText !== undefined) {
			const currentEditorText = this.editor.getText?.() ?? "";
			const result = manager.handlePaste(interceptedText, currentEditorText);
			if (result) {
				origInsert.call(this.editor, result.chip);
			} else {
				origInsert.call(this.editor, interceptedText);
			}
			this.ui?.requestRender?.();
		}
	};
}

export function unpatchInteractiveModePaste(): void {
	if (typeof InteractiveMode === "undefined" || !InteractiveMode || !InteractiveMode.prototype) {
		return;
	}
	const orig = (InteractiveMode.prototype as any)[Symbol.for("rbf.imageShortText.origInteractivePaste")];
	if (orig) {
		(InteractiveMode.prototype as any).handleClipboardPaste = orig;
		delete (InteractiveMode.prototype as any)[Symbol.for("rbf.imageShortText.origInteractivePaste")];
	}
	delete (InteractiveMode.prototype as any)[PATCHED_SYMBOL];
}

export default function rbfImageShortText(pi: ExtensionAPI): void {
	const manager = new ImageShortTextManager();
	setActiveManager(manager);
	patchInteractiveModePaste();
	patchEditorPaste();

	pi.on("input", async (event: InputEvent): Promise<InputEventResult> => {
		const result = manager.transformInput(event.text);
		if (result) {
			manager.clear();
			const combinedImages: ImageContent[] = [
				...(event.images ?? []),
				...result.images,
			];
			return {
				action: "transform",
				text: result.text,
				images: combinedImages,
			};
		}
		return { action: "continue" };
	});

	pi.on("turn_start", () => {
		manager.clear();
	});

	pi.on("turn_end", () => {
		manager.clear();
	});

	pi.on("session_start", () => {
		manager.clear();
		setActiveManager(manager);
		patchEditorPaste();
	});

	pi.on("session_shutdown", () => {
		manager.clear();
		if (getActiveManager() === manager) {
			setActiveManager(undefined);
		}
	});
}
