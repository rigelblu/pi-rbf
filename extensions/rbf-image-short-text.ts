import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	ExtensionAPI,
	InputEvent,
	InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { InteractiveMode } from "@earendil-works/pi-coding-agent";

export interface ImageContent {
	type: "image";
	data: string;
	mimeType: string;
}

export const PATCHED_SYMBOL = Symbol.for("rbf.imageShortText.patched");
export const ACTIVE_MANAGER_SYMBOL = Symbol.for("rbf.imageShortText.activeManager");

export interface ImageEntry {
	chip: string;
	filePath: string;
	mimeType: string;
	data: string; // base64
}

export function isClipboardImageFile(filePath: string): boolean {
	if (typeof filePath !== "string" || !filePath) {
		return false;
	}
	const fileName = path.basename(filePath);
	if (!fileName.startsWith("pi-clipboard-")) {
		return false;
	}
	if (!/\.(png|jpe?g|webp|gif)$/i.test(fileName)) {
		return false;
	}
	const tmpDir = os.tmpdir();
	const dir = path.dirname(filePath);
	if (path.resolve(dir) !== path.resolve(tmpDir)) {
		return false;
	}
	try {
		return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
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

	public handlePaste(insertedPath: string, currentEditorText: string): { chip: string; entry: ImageEntry } | null {
		if (!isClipboardImageFile(insertedPath)) {
			return null;
		}

		try {
			const bytes = fs.readFileSync(insertedPath);
			const mimeType = extractMimeType(insertedPath);
			const data = bytes.toString("base64");
			const chip = allocateNextChip(currentEditorText);
			const entry: ImageEntry = { chip, filePath: insertedPath, mimeType, data };
			this.activeImages.set(chip, entry);
			return { chip, entry };
		} catch {
			return null;
		}
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
	if (typeof InteractiveMode !== "undefined") {
		(InteractiveMode as any)[ACTIVE_MANAGER_SYMBOL] = manager;
	}
}

export function getActiveManager(): ImageShortTextManager | undefined {
	if (typeof InteractiveMode !== "undefined") {
		return (InteractiveMode as any)[ACTIVE_MANAGER_SYMBOL];
	}
	return undefined;
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

export default function rbfImageShortText(pi: ExtensionAPI): void {
	const manager = new ImageShortTextManager();
	setActiveManager(manager);
	patchInteractiveModePaste();

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
	});

	pi.on("session_shutdown", () => {
		manager.clear();
		if (getActiveManager() === manager) {
			setActiveManager(undefined);
		}
	});
}
