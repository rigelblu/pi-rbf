import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ExtensionAPI,
	InputEvent,
	InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { CustomEditor, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { Editor } from "@earendil-works/pi-tui";
import rbfImageShortText, {
	ACTIVE_MANAGER_SYMBOL,
	allocateNextChip,
	EDITOR_PATCHED_SYMBOL,
	extractMimeType,
	getActiveManager,
	type ImageContent,
	ImageShortTextManager,
	isClipboardImageFile,
	normalizePastedPath,
	PATCHED_SYMBOL,
	patchEditorPaste,
	patchInteractiveModePaste,
	setActiveManager,
	unpatchEditorPaste,
	unpatchInteractiveModePaste,
} from "./rbf-image-short-text.ts";

function createMockExtensionAPI() {
	const handlers = new Map<string, Array<(...args: any[]) => any>>();

	const api = {
		on: vi.fn((event: string, handler: (...args: any[]) => any) => {
			if (!handlers.has(event)) {
				handlers.set(event, []);
			}
			handlers.get(event)!.push(handler);
		}),
	} as unknown as ExtensionAPI;

	return {
		api,
		async emit(event: string, ...args: any[]) {
			const eventHandlers = handlers.get(event) ?? [];
			let lastResult: any;
			for (const h of eventHandlers) {
				lastResult = await h(...args);
			}
			return lastResult;
		},
		getHandlers(event: string) {
			return handlers.get(event) ?? [];
		},
	};
}

describe("Pure helpers", () => {
	describe("allocateNextChip", () => {
		it("allocates [Image #1] when current text has no image chips", () => {
			expect(allocateNextChip("")).toBe("[Image #1]");
			expect(allocateNextChip("Hello world")).toBe("[Image #1]");
		});

		it("allocates [Image #2] when [Image #1] is already present", () => {
			expect(allocateNextChip("Please check [Image #1]")).toBe("[Image #2]");
			// Also accepts [Image 1] without hash
			expect(allocateNextChip("Please check [Image 1]")).toBe("[Image #2]");
		});

		it("allocates [Image #3] when [Image #1] and [Image #2] are present", () => {
			expect(allocateNextChip("Look at [Image #1] and [Image #2] closely")).toBe("[Image #3]");
		});

		it("fills gaps by allocating the lowest unused integer", () => {
			// User deleted [Image #1], keeping [Image #2]
			expect(allocateNextChip("Look at [Image #2]")).toBe("[Image #1]");
			// Gaps between 1 and 3
			expect(allocateNextChip("Look at [Image #1] and [Image #3]")).toBe("[Image #2]");
		});

		it("handles multiple mentions of the same chip gracefully", () => {
			expect(allocateNextChip("[Image #1] is here and [Image #1] again")).toBe("[Image #2]");
		});
	});

	describe("extractMimeType", () => {
		it("maps file extensions to correct MIME types", () => {
			expect(extractMimeType("/tmp/foo.png")).toBe("image/png");
			expect(extractMimeType("/tmp/foo.PNG")).toBe("image/png");
			expect(extractMimeType("/tmp/foo.jpg")).toBe("image/jpeg");
			expect(extractMimeType("/tmp/foo.jpeg")).toBe("image/jpeg");
			expect(extractMimeType("/tmp/foo.webp")).toBe("image/webp");
			expect(extractMimeType("/tmp/foo.gif")).toBe("image/gif");
			expect(extractMimeType("/tmp/foo.unknown")).toBe("image/png");
		});
	});

	describe("isClipboardImageFile", () => {
		const tmpFiles: string[] = [];

		afterEach(() => {
			for (const f of tmpFiles) {
				try {
					if (fs.existsSync(f)) {
						fs.unlinkSync(f);
					}
				} catch {}
			}
			tmpFiles.length = 0;
		});

		it("returns true for an existing pi-clipboard image in tmpdir", () => {
			const filePath = path.join(os.tmpdir(), `pi-clipboard-${crypto.randomUUID()}.png`);
			fs.writeFileSync(filePath, Buffer.from("fake png data"));
			tmpFiles.push(filePath);

			expect(isClipboardImageFile(filePath)).toBe(true);
		});

		it("returns false for non-existent file", () => {
			const fakePath = path.join(os.tmpdir(), `pi-clipboard-${crypto.randomUUID()}.png`);
			expect(isClipboardImageFile(fakePath)).toBe(false);
		});

		it("returns false for files outside tmpdir", () => {
			const localPath = path.resolve("./pi-clipboard-test.png");
			fs.writeFileSync(localPath, Buffer.from("data"));
			tmpFiles.push(localPath);

			expect(isClipboardImageFile(localPath)).toBe(false);
		});

		it("returns true for terminal-generated clipboard-YYYY-MM-DD image in tmpdir", () => {
			const fileName = `clipboard-2026-09-09-232826-${crypto.randomUUID().slice(0, 8)}.png`;
			const filePath = path.join(os.tmpdir(), fileName);
			fs.writeFileSync(filePath, Buffer.from("fake png data"));
			tmpFiles.push(filePath);

			expect(isClipboardImageFile(filePath)).toBe(true);
			// Also accepts wrapped in quotes
			expect(isClipboardImageFile(`"${filePath}"`)).toBe(true);
			expect(isClipboardImageFile(`'${filePath}'`)).toBe(true);
		});

		it("returns false for non-clipboard filenames in tmpdir", () => {
			const regularFile = path.join(os.tmpdir(), `regular-image-${crypto.randomUUID()}.png`);
			fs.writeFileSync(regularFile, Buffer.from("data"));
			tmpFiles.push(regularFile);

			expect(isClipboardImageFile(regularFile)).toBe(false);
		});

		it("returns false for non-image extension in tmpdir", () => {
			const txtFile = path.join(os.tmpdir(), `pi-clipboard-${crypto.randomUUID()}.txt`);
			fs.writeFileSync(txtFile, Buffer.from("text data"));
			tmpFiles.push(txtFile);

			expect(isClipboardImageFile(txtFile)).toBe(false);
		});

		it("returns true for an existing CleanShot screenshot in CleanShot media directory", () => {
			const cleanShotDir = path.join(os.tmpdir(), "test-cleanshot", "Library", "Application Support", "CleanShot", "media", "media_test123");
			fs.mkdirSync(cleanShotDir, { recursive: true });
			const cleanShotFile = path.join(cleanShotDir, "CleanShot 2026-09-10 at 4.37.35 AM@2x.png");
			fs.writeFileSync(cleanShotFile, Buffer.from("fake cleanshot png data"));
			tmpFiles.push(cleanShotFile);

			expect(isClipboardImageFile(cleanShotFile)).toBe(true);
			// Also accepts terminal-escaped spaces
			const escapedPath = cleanShotFile.replace(/ /g, "\\ ");
			expect(isClipboardImageFile(escapedPath)).toBe(true);
			// Also accepts wrapped in quotes
			expect(isClipboardImageFile(`"${cleanShotFile}"`)).toBe(true);
		});

		it("returns true for CleanShot filename prefix anywhere", () => {
			const csFile = path.join(os.tmpdir(), `CleanShot-${crypto.randomUUID()}.png`);
			fs.writeFileSync(csFile, Buffer.from("data"));
			tmpFiles.push(csFile);

			expect(isClipboardImageFile(csFile)).toBe(true);
		});

		it("returns false for non-clipboard filenames outside tempdir", () => {
			const customDir = path.join(os.tmpdir(), "other-app");
			fs.mkdirSync(customDir, { recursive: true });
			const regularFile = path.join(customDir, `regular-photo-${crypto.randomUUID()}.png`);
			fs.writeFileSync(regularFile, Buffer.from("data"));
			tmpFiles.push(regularFile);

			expect(isClipboardImageFile(regularFile)).toBe(false);
		});

		it("returns false for multi-line inputs", () => {
			const filePath = path.join(os.tmpdir(), `pi-clipboard-${crypto.randomUUID()}.png`);
			fs.writeFileSync(filePath, Buffer.from("fake png data"));
			tmpFiles.push(filePath);

			expect(isClipboardImageFile(`Here is some text\n${filePath}`)).toBe(false);
		});

		it("returns false for invalid inputs", () => {
			expect(isClipboardImageFile("")).toBe(false);
			expect(isClipboardImageFile(null as any)).toBe(false);
			expect(isClipboardImageFile(undefined as any)).toBe(false);
		});
	});

	describe("normalizePastedPath", () => {
		it("strips double and single quotes", () => {
			expect(normalizePastedPath('"/tmp/image.png"')).toBe("/tmp/image.png");
			expect(normalizePastedPath("'/tmp/image.png'")).toBe("/tmp/image.png");
		});

		it("strips file:// schema and decodes URI", () => {
			expect(normalizePastedPath("file:///tmp/image.png")).toBe("/tmp/image.png");
			expect(normalizePastedPath("file:///tmp/my%20image.png")).toBe("/tmp/my image.png");
		});

		it("unescapes terminal-escaped spaces", () => {
			expect(normalizePastedPath("/tmp/my\\ image.png")).toBe("/tmp/my image.png");
		});

		it("trims surrounding whitespace", () => {
			expect(normalizePastedPath("  /tmp/image.png  ")).toBe("/tmp/image.png");
		});
	});
});

describe("ImageShortTextManager", () => {
	const tmpFiles: string[] = [];
	let manager: ImageShortTextManager;

	beforeEach(() => {
		manager = new ImageShortTextManager();
	});

	afterEach(() => {
		for (const f of tmpFiles) {
			try {
				if (fs.existsSync(f)) {
					fs.unlinkSync(f);
				}
			} catch {}
		}
		tmpFiles.length = 0;
	});

	it("handles pasting an image file and allocates sequential chips", () => {
		const rawBytes = Buffer.from("fake png content");
		const file1 = path.join(os.tmpdir(), `pi-clipboard-${crypto.randomUUID()}.png`);
		fs.writeFileSync(file1, rawBytes);
		tmpFiles.push(file1);

		const result1 = manager.handlePaste(file1, "");
		expect(result1).not.toBeNull();
		expect(result1?.chip).toBe("[Image #1]");
		expect(result1?.entry.mimeType).toBe("image/png");
		expect(result1?.entry.data).toBe(rawBytes.toString("base64"));
		expect(result1?.entry.filePath).toBe(file1);

		// Second paste with [Image #1] in editor
		const file2 = path.join(os.tmpdir(), `pi-clipboard-${crypto.randomUUID()}.jpg`);
		fs.writeFileSync(file2, Buffer.from("fake jpg content"));
		tmpFiles.push(file2);

		const result2 = manager.handlePaste(file2, "Here is [Image #1]");
		expect(result2).not.toBeNull();
		expect(result2?.chip).toBe("[Image #2]");
		expect(result2?.entry.mimeType).toBe("image/jpeg");
	});

	it("returns null when pasting non-clipboard image or invalid path", () => {
		expect(manager.handlePaste("regular text", "")).toBeNull();
		expect(manager.handlePaste("/etc/hosts", "")).toBeNull();
	});

	it("transforms input with matched chips into multimodal ImageContent", () => {
		const rawBytes = Buffer.from("image 1 data");
		const file1 = path.join(os.tmpdir(), `pi-clipboard-${crypto.randomUUID()}.png`);
		fs.writeFileSync(file1, rawBytes);
		tmpFiles.push(file1);

		manager.handlePaste(file1, "");

		const transformResult = manager.transformInput("What is in [Image #1]?");
		expect(transformResult).not.toBeNull();
		expect(transformResult?.action).toBe("transform");
		expect(transformResult?.text).toBe("What is in [Image #1]?");
		expect(transformResult?.images).toHaveLength(1);
		expect(transformResult?.images[0]).toEqual({
			type: "image",
			mimeType: "image/png",
			data: rawBytes.toString("base64"),
		});
	});

	it("only attaches chips that are present in the submitted text", () => {
		const file1 = path.join(os.tmpdir(), `pi-clipboard-${crypto.randomUUID()}.png`);
		const file2 = path.join(os.tmpdir(), `pi-clipboard-${crypto.randomUUID()}.png`);
		fs.writeFileSync(file1, Buffer.from("img1"));
		fs.writeFileSync(file2, Buffer.from("img2"));
		tmpFiles.push(file1, file2);

		manager.handlePaste(file1, "");
		manager.handlePaste(file2, "[Image #1]");

		// User deleted [Image #1], submitting only with [Image #2]
		const transformResult = manager.transformInput("Only look at [Image #2]");
		expect(transformResult).not.toBeNull();
		expect(transformResult?.images).toHaveLength(1);
		expect(transformResult?.images[0].data).toBe(Buffer.from("img2").toString("base64"));
	});

	it("returns null if no registered chips exist in the submitted text", () => {
		// User types literal [Image #1] without pasting
		const result = manager.transformInput("Look at [Image #1]");
		expect(result).toBeNull();
	});

	it("recognizes chips with or without hash symbol for tolerance", () => {
		const rawBytes = Buffer.from("tolerance image");
		const file = path.join(os.tmpdir(), `pi-clipboard-${crypto.randomUUID()}.png`);
		fs.writeFileSync(file, rawBytes);
		tmpFiles.push(file);

		manager.handlePaste(file, "");

		// Should match both "[Image #1]" and "[Image 1]"
		const resWithHash = manager.transformInput("Check [Image #1]");
		expect(resWithHash?.images).toHaveLength(1);

		const resWithoutHash = manager.transformInput("Check [Image 1]");
		expect(resWithoutHash?.images).toHaveLength(1);
	});

	it("clear() empties active images", () => {
		const file1 = path.join(os.tmpdir(), `pi-clipboard-${crypto.randomUUID()}.png`);
		fs.writeFileSync(file1, Buffer.from("data"));
		tmpFiles.push(file1);

		manager.handlePaste(file1, "");
		expect(manager.getActiveEntries()).toHaveLength(1);

		manager.clear();
		expect(manager.getActiveEntries()).toHaveLength(0);
		expect(manager.transformInput("[Image 1]")).toBeNull();
	});
});

describe("Extension lifecycle & integration", () => {
	const tmpFiles: string[] = [];

	afterEach(() => {
		for (const f of tmpFiles) {
			try {
				if (fs.existsSync(f)) {
					fs.unlinkSync(f);
				}
			} catch {}
		}
		tmpFiles.length = 0;
	});

	it("registers input and lifecycle events on initialization", () => {
		const mock = createMockExtensionAPI();
		rbfImageShortText(mock.api);

		expect(mock.api.on).toHaveBeenCalledWith("input", expect.any(Function));
		expect(mock.api.on).toHaveBeenCalledWith("turn_start", expect.any(Function));
		expect(mock.api.on).toHaveBeenCalledWith("turn_end", expect.any(Function));
		expect(mock.api.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(mock.api.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
	});

	it("transforms input and clears turn state on prompt submission", async () => {
		const mock = createMockExtensionAPI();
		rbfImageShortText(mock.api);

		const manager = getActiveManager();
		expect(manager).toBeDefined();

		const rawBytes = Buffer.from("test image payload");
		const file = path.join(os.tmpdir(), `pi-clipboard-${crypto.randomUUID()}.png`);
		fs.writeFileSync(file, rawBytes);
		tmpFiles.push(file);

		manager?.handlePaste(file, "");

		const event: InputEvent = {
			type: "input",
			text: "Explain [Image #1]",
			source: "interactive",
		};

		const result = (await mock.emit("input", event)) as InputEventResult;
		expect(result).toEqual({
			action: "transform",
			text: "Explain [Image #1]",
			images: [
				{
					type: "image",
					mimeType: "image/png",
					data: rawBytes.toString("base64"),
				},
			],
		});

		// Ensure manager was cleared after transform
		expect(manager?.getActiveEntries()).toHaveLength(0);
	});

	it("combines with existing images in InputEvent if present", async () => {
		const mock = createMockExtensionAPI();
		rbfImageShortText(mock.api);
		const manager = getActiveManager();

		const file = path.join(os.tmpdir(), `pi-clipboard-${crypto.randomUUID()}.png`);
		fs.writeFileSync(file, Buffer.from("img2"));
		tmpFiles.push(file);

		manager?.handlePaste(file, "");

		const existingImage: ImageContent = {
			type: "image",
			mimeType: "image/jpeg",
			data: "existing_image_data",
		};

		const event: InputEvent = {
			type: "input",
			text: "Compare images [Image #1]",
			images: [existingImage],
			source: "interactive",
		};

		const result = (await mock.emit("input", event)) as any;
		expect(result.action).toBe("transform");
		expect(result.images).toHaveLength(2);
		expect(result.images[0]).toEqual(existingImage);
		expect(result.images[1].data).toBe(Buffer.from("img2").toString("base64"));
	});

	it("returns continue if no registered chips are in the prompt", async () => {
		const mock = createMockExtensionAPI();
		rbfImageShortText(mock.api);

		const event: InputEvent = {
			type: "input",
			text: "Hello world without images",
			source: "interactive",
		};

		const result = await mock.emit("input", event);
		expect(result).toEqual({ action: "continue" });
	});

	it("clears active images on turn_start and session_shutdown", async () => {
		const mock = createMockExtensionAPI();
		rbfImageShortText(mock.api);
		const manager = getActiveManager();

		const file = path.join(os.tmpdir(), `pi-clipboard-${crypto.randomUUID()}.png`);
		fs.writeFileSync(file, Buffer.from("data"));
		tmpFiles.push(file);

		manager?.handlePaste(file, "");
		expect(manager?.getActiveEntries()).toHaveLength(1);

		await mock.emit("turn_start");
		expect(manager?.getActiveEntries()).toHaveLength(0);

		manager?.handlePaste(file, "");
		expect(manager?.getActiveEntries()).toHaveLength(1);

		await mock.emit("session_shutdown");
		expect(manager?.getActiveEntries()).toHaveLength(0);
		expect(getActiveManager()).toBeUndefined();
	});
});

describe("InteractiveMode monkey-patching", () => {
	const tmpFiles: string[] = [];

	afterEach(() => {
		for (const f of tmpFiles) {
			try {
				if (fs.existsSync(f)) {
					fs.unlinkSync(f);
				}
			} catch {}
		}
		tmpFiles.length = 0;
	});

	it("patches handleClipboardPaste idempotently and replaces clipboard image path with [Image 1]", async () => {
		patchInteractiveModePaste();
		expect((InteractiveMode.prototype as any)[PATCHED_SYMBOL]).toBe(true);

		const manager = new ImageShortTextManager();
		setActiveManager(manager);

		const file = path.join(os.tmpdir(), `pi-clipboard-${crypto.randomUUID()}.png`);
		fs.writeFileSync(file, Buffer.from("test png"));
		tmpFiles.push(file);

		let insertedValue: string | undefined;
		const mockEditor = {
			getText: vi.fn(() => ""),
			insertTextAtCursor: vi.fn((text: string) => {
				insertedValue = text;
			}),
		};

		const mockInteractiveInstance = {
			editor: mockEditor,
			ui: {
				requestRender: vi.fn(),
			},
		};

		// Simulate an instance calling handleClipboardPaste where native behavior inserts the temp image path
		const simulateCall = async () => {
			const origInsert = mockEditor.insertTextAtCursor;
			let intercepted: string | undefined;
			(mockEditor as any).insertTextAtCursor = (t: string) => {
				intercepted = t;
			};
			// Simulating what originalHandleClipboardPaste would do:
			mockEditor.insertTextAtCursor(file);
			(mockEditor as any).insertTextAtCursor = origInsert;

			if (intercepted !== undefined) {
				const currentText = mockEditor.getText();
				const res = manager.handlePaste(intercepted, currentText);
				if (res) {
					origInsert(res.chip);
				} else {
					origInsert(intercepted);
				}
				mockInteractiveInstance.ui.requestRender();
			}
		};

		await simulateCall();

		expect(insertedValue).toBe("[Image #1]");
		expect(mockInteractiveInstance.ui.requestRender).toHaveBeenCalled();
		expect(manager.getActiveEntries()).toHaveLength(1);
	});

	it("passes through plain text pastes untouched", async () => {
		const manager = new ImageShortTextManager();
		setActiveManager(manager);

		let insertedValue: string | undefined;
		const mockEditor = {
			getText: vi.fn(() => ""),
			insertTextAtCursor: vi.fn((text: string) => {
				insertedValue = text;
			}),
		};

		const simulateTextPaste = async (text: string) => {
			const origInsert = mockEditor.insertTextAtCursor;
			let intercepted: string | undefined;
			(mockEditor as any).insertTextAtCursor = (t: string) => {
				intercepted = t;
			};
			// Native paste would insert plain text
			mockEditor.insertTextAtCursor(text);
			(mockEditor as any).insertTextAtCursor = origInsert;

			if (intercepted !== undefined) {
				const currentText = mockEditor.getText();
				const res = manager.handlePaste(intercepted, currentText);
				if (res) {
					origInsert(res.chip);
				} else {
					origInsert(intercepted);
				}
			}
		};

		await simulateTextPaste("Plain text from clipboard");
		expect(insertedValue).toBe("Plain text from clipboard");
	});
});

describe("Editor & CustomEditor monkey-patching", () => {
	const tmpFiles: string[] = [];

	beforeEach(() => {
		unpatchEditorPaste();
	});

	afterEach(() => {
		unpatchEditorPaste();
		setActiveManager(undefined);
		for (const f of tmpFiles) {
			try {
				if (fs.existsSync(f)) {
					fs.unlinkSync(f);
				}
			} catch {}
		}
		tmpFiles.length = 0;
	});

	it("patches Editor and CustomEditor prototype handlePaste and insertTextAtCursor", () => {
		patchEditorPaste();
		expect((Editor.prototype as any)[EDITOR_PATCHED_SYMBOL]).toBe(true);
		expect((CustomEditor.prototype as any)[EDITOR_PATCHED_SYMBOL]).toBe(true);

		unpatchEditorPaste();
		expect((Editor.prototype as any)[EDITOR_PATCHED_SYMBOL]).toBeUndefined();
	});

	it("intercepts terminal paste of clipboard image and inserts [Image #1] chip", () => {
		const manager = new ImageShortTextManager();
		setActiveManager(manager);
		patchEditorPaste();

		const clipboardFile = path.join(os.tmpdir(), `clipboard-2026-09-09-232826-${crypto.randomUUID().slice(0, 8)}.png`);
		fs.writeFileSync(clipboardFile, Buffer.from("image bytes"));
		tmpFiles.push(clipboardFile);

		let inserted: string | undefined;
		const fakeEditor = {
			getText: vi.fn(() => ""),
			state: { lines: [""], cursorLine: 0, cursorCol: 0 },
			cancelAutocomplete: vi.fn(),
			exitHistoryBrowsing: vi.fn(),
			pushUndoSnapshot: vi.fn(),
			lastAction: null,
			normalizeText: vi.fn((t: string) => t),
			insertTextAtCursorInternal: vi.fn((t: string) => {
				inserted = t;
			}),
			handlePaste: (Editor.prototype as any).handlePaste,
		};

		fakeEditor.handlePaste(clipboardFile);

		expect(inserted).toBe("[Image #1]");
		expect(manager.getActiveEntries()).toHaveLength(1);
		expect(manager.getActiveEntries()[0].chip).toBe("[Image #1]");
	});

	it("intercepts terminal paste of CleanShot screenshot with escaped spaces and inserts [Image #1] chip", () => {
		const manager = new ImageShortTextManager();
		setActiveManager(manager);
		patchEditorPaste();

		const cleanShotDir = path.join(os.tmpdir(), "Application Support", "CleanShot", "media", "media_test");
		fs.mkdirSync(cleanShotDir, { recursive: true });
		const cleanShotFile = path.join(cleanShotDir, "CleanShot 2026-09-10 at 4.37.35 AM@2x.png");
		fs.writeFileSync(cleanShotFile, Buffer.from("cleanshot png content"));
		tmpFiles.push(cleanShotFile);

		let inserted: string | undefined;
		const fakeEditor = {
			getText: vi.fn(() => ""),
			state: { lines: [""], cursorLine: 0, cursorCol: 0 },
			cancelAutocomplete: vi.fn(),
			exitHistoryBrowsing: vi.fn(),
			pushUndoSnapshot: vi.fn(),
			lastAction: null,
			normalizeText: vi.fn((t: string) => t),
			insertTextAtCursorInternal: vi.fn((t: string) => {
				inserted = t;
			}),
			handlePaste: (Editor.prototype as any).handlePaste,
		};

		// Terminal pastes path with escaped spaces
		const escapedPath = cleanShotFile.replace(/ /g, "\\ ");
		fakeEditor.handlePaste(escapedPath);

		expect(inserted).toBe("[Image #1]");
		expect(manager.getActiveEntries()).toHaveLength(1);
		expect(manager.getActiveEntries()[0].chip).toBe("[Image #1]");
		expect(manager.getActiveEntries()[0].filePath).toBe(cleanShotFile);
	});

	it("prepends a space when character before cursor is a word character", () => {
		const manager = new ImageShortTextManager();
		setActiveManager(manager);
		patchEditorPaste();

		const clipboardFile = path.join(os.tmpdir(), `clipboard-2026-09-09-232826-${crypto.randomUUID().slice(0, 8)}.png`);
		fs.writeFileSync(clipboardFile, Buffer.from("image bytes"));
		tmpFiles.push(clipboardFile);

		let inserted: string | undefined;
		const fakeEditor = {
			getText: vi.fn(() => "Look at"),
			state: { lines: ["Look at"], cursorLine: 0, cursorCol: 7 },
			cancelAutocomplete: vi.fn(),
			exitHistoryBrowsing: vi.fn(),
			pushUndoSnapshot: vi.fn(),
			lastAction: null,
			normalizeText: vi.fn((t: string) => t),
			insertTextAtCursorInternal: vi.fn((t: string) => {
				inserted = t;
			}),
			handlePaste: (Editor.prototype as any).handlePaste,
		};

		fakeEditor.handlePaste(clipboardFile);

		expect(inserted).toBe(" [Image #1]");
	});

	it("passes plain text through handlePaste untouched", () => {
		const manager = new ImageShortTextManager();
		setActiveManager(manager);
		patchEditorPaste();

		let inserted: string | undefined;
		const fakeEditor = {
			getText: vi.fn(() => ""),
			state: { lines: [""], cursorLine: 0, cursorCol: 0 },
			cancelAutocomplete: vi.fn(),
			exitHistoryBrowsing: vi.fn(),
			pushUndoSnapshot: vi.fn(),
			lastAction: null,
			normalizeText: vi.fn((t: string) => t),
			insertTextAtCursorInternal: vi.fn((t: string) => {
				inserted = t;
			}),
			handlePaste: (Editor.prototype as any).handlePaste,
		};

		fakeEditor.handlePaste("console.log('hello world');");

		expect(inserted).toBe("console.log('hello world');");
		expect(manager.getActiveEntries()).toHaveLength(0);
	});

	it("intercepts insertTextAtCursor when clipboard image is passed", () => {
		const manager = new ImageShortTextManager();
		setActiveManager(manager);
		patchEditorPaste();

		const clipboardFile = path.join(os.tmpdir(), `pi-clipboard-${crypto.randomUUID()}.png`);
		fs.writeFileSync(clipboardFile, Buffer.from("png data"));
		tmpFiles.push(clipboardFile);

		let inserted: string | undefined;
		const fakeEditor = {
			getText: vi.fn(() => ""),
			state: { lines: [""], cursorLine: 0, cursorCol: 0 },
			cancelAutocomplete: vi.fn(),
			exitHistoryBrowsing: vi.fn(),
			pushUndoSnapshot: vi.fn(),
			lastAction: null,
			insertTextAtCursorInternal: vi.fn((t: string) => {
				inserted = t;
			}),
			insertTextAtCursor: (Editor.prototype as any).insertTextAtCursor,
		};

		fakeEditor.insertTextAtCursor(clipboardFile);

		expect(inserted).toBe("[Image #1]");
		expect(manager.getActiveEntries()).toHaveLength(1);
	});
});
