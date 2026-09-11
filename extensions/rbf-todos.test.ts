import { describe, expect, it, vi, beforeAll, afterEach } from "vitest";
import {
	FooterComponent,
	initTheme,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import rbfTodos, {
	calculateBadgeBounds,
	createTodoListModalComponent,
	createTodoToolDefinition,
	formatStatsLineWithTodos,
	getBadgeBounds,
	getIsBadgeHovered,
	getLastFooterScreenY,
	MAX_VISIBLE_WIDGET_ITEMS,
	patchFooterComponent,
	SESSION_CUSTOM_TYPE,
	setIsBadgeHovered,
	setLastFooterScreenY,
	SHORTCUT_KEY,
	STATUS_KEY,
	TodoManager,
	unpatchFooterComponent,
	updateExtensionUI,
	WIDGET_KEY,
} from "./rbf-todos.ts";

function createMockTheme(): Theme {
	return {
		fg: vi.fn((_color: string, text: string) => `[${text}]`),
		bold: vi.fn((text: string) => `*${text}*`),
		dim: vi.fn((text: string) => `~${text}~`),
		inverse: vi.fn((text: string) => `!${text}!`),
		strikethrough: vi.fn((text: string) => `-${text}-`),
	} as unknown as Theme;
}

function getText(result: any): string {
	const first = result?.content?.[0];
	return first && typeof first === "object" && "text" in first ? first.text : "";
}

afterEach(() => {
	unpatchFooterComponent();
});

function createMockContext(entries: any[] = []) {
	let widgetContent: string[] | undefined;
	let widgetOptions: any;
	let statusText: string | undefined;
	let notifyMessage: string | undefined;
	let customCallback: any;
	let terminalInputListener: ((data: string) => any) | undefined;

	const appendedCustomEntries: Array<{ customType: string; data: any }> = [];

	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			theme: createMockTheme(),
			setWidget: vi.fn((key: string, content: string[] | undefined, options?: any) => {
				if (key === WIDGET_KEY) {
					widgetContent = content;
					widgetOptions = options;
				}
			}),
			setStatus: vi.fn((key: string, text: string | undefined) => {
				if (key === STATUS_KEY) {
					statusText = text;
				}
			}),
			notify: vi.fn((msg: string) => {
				notifyMessage = msg;
			}),
			custom: vi.fn(async (factory: any) => {
				customCallback = factory;
			}),
			onTerminalInput: vi.fn((listener: any) => {
				terminalInputListener = listener;
			}),
		},
		sessionManager: {
			getEntries: vi.fn(() => entries),
			appendCustomEntry: vi.fn((customType: string, data: any) => {
				appendedCustomEntries.push({ customType, data });
				return "entry-id";
			}),
		},
	} as unknown as ExtensionContext;

	return {
		ctx,
		get widgetContent() {
			return widgetContent;
		},
		get widgetOptions() {
			return widgetOptions;
		},
		get statusText() {
			return statusText;
		},
		get notifyMessage() {
			return notifyMessage;
		},
		get customCallback() {
			return customCallback;
		},
		get terminalInputListener() {
			return terminalInputListener;
		},
		appendedCustomEntries,
	};
}

describe("TodoManager pure logic", () => {
	it("initializes with empty list and defaults", () => {
		const mgr = new TodoManager();
		expect(mgr.getTodos()).toEqual([]);
		expect(mgr.getNextId()).toBe(1);
		expect(mgr.isWidgetVisible()).toBe(true);
		expect(mgr.isCollapsed()).toBe(false);
		expect(mgr.getCounts()).toEqual({ total: 0, completed: 0, inProgress: 0, pending: 0 });
		expect(mgr.allCompleted()).toBe(false);
	});

	it("initializes with custom initial items and calculates nextId", () => {
		const mgr = new TodoManager([
			{ id: 1, text: "Task A", status: "completed" },
			{ id: 4, text: "Task B", status: "pending" },
		]);
		expect(mgr.getTodos()).toHaveLength(2);
		expect(mgr.getNextId()).toBe(5);
		expect(mgr.getCounts()).toEqual({ total: 2, completed: 1, inProgress: 0, pending: 1 });
	});

	it("adds items with trimmed text and pending status", () => {
		const mgr = new TodoManager();
		const item1 = mgr.add(" First item  ");
		expect(item1).toEqual({ id: 1, text: "First item", status: "pending" });
		expect(mgr.getNextId()).toBe(2);

		const item2 = mgr.add("Second item");
		expect(item2).toEqual({ id: 2, text: "Second item", status: "pending" });
		expect(mgr.getTodos()).toHaveLength(2);
	});

	it("throws error when adding empty or whitespace-only text", () => {
		const mgr = new TodoManager();
		expect(() => mgr.add("")).toThrow("Todo text cannot be empty");
		expect(() => mgr.add("   \t\n  ")).toThrow("Todo text cannot be empty");
	});

	it("updates item text and status correctly", () => {
		const mgr = new TodoManager();
		mgr.add("Initial task");

		const updated = mgr.update(1, { text: "Updated title", status: "in_progress" });
		expect(updated).toEqual({ id: 1, text: "Updated title", status: "in_progress" });
		expect(mgr.getCounts()).toEqual({ total: 1, completed: 0, inProgress: 1, pending: 0 });

		mgr.update(1, { status: "completed" });
		expect(mgr.getCounts().completed).toBe(1);
		expect(mgr.allCompleted()).toBe(true);
	});

	it("returns undefined when updating non-existent item", () => {
		const mgr = new TodoManager();
		expect(mgr.update(99, { text: "Missing" })).toBeUndefined();
	});

	it("cycles status through toggle: pending -> in_progress -> completed -> pending", () => {
		const mgr = new TodoManager();
		mgr.add("Cycle test");

		const s1 = mgr.toggle(1);
		expect(s1?.status).toBe("in_progress");

		const s2 = mgr.toggle(1);
		expect(s2?.status).toBe("completed");

		const s3 = mgr.toggle(1);
		expect(s3?.status).toBe("pending");

		expect(mgr.toggle(999)).toBeUndefined();
	});

	it("clears all todos and resets nextId", () => {
		const mgr = new TodoManager();
		mgr.add("A");
		mgr.add("B");
		mgr.clear();
		expect(mgr.getTodos()).toEqual([]);
		expect(mgr.getNextId()).toBe(1);
		expect(mgr.isCollapsed()).toBe(false);
	});

	it("clears only completed items", () => {
		const mgr = new TodoManager();
		mgr.add("Item 1");
		mgr.add("Item 2");
		mgr.add("Item 3");
		mgr.update(1, { status: "completed" });
		mgr.update(2, { status: "in_progress" });

		mgr.clearCompleted();
		const remaining = mgr.getTodos();
		expect(remaining).toHaveLength(2);
		expect(remaining.map((t) => t.id)).toEqual([2, 3]);
	});

	it("toggles widget visibility", () => {
		const mgr = new TodoManager();
		expect(mgr.isWidgetVisible()).toBe(true);
		expect(mgr.toggleWidgetVisible()).toBe(false);
		expect(mgr.isWidgetVisible()).toBe(false);
		expect(mgr.toggleWidgetVisible()).toBe(true);
	});

	describe("auto-collapse behavior", () => {
		it("does not collapse if any item is pending or in_progress", () => {
			const mgr = new TodoManager();
			mgr.add("A");
			mgr.add("B");
			mgr.update(1, { status: "completed" });

			expect(mgr.handleUserPromptSubmit()).toBe(false);
			expect(mgr.isCollapsed()).toBe(false);
		});

		it("collapses when all items are completed on prompt submission", () => {
			const mgr = new TodoManager();
			mgr.add("A");
			mgr.update(1, { status: "completed" });

			expect(mgr.allCompleted()).toBe(true);
			expect(mgr.isCollapsed()).toBe(false);

			const didCollapse = mgr.handleUserPromptSubmit();
			expect(didCollapse).toBe(true);
			expect(mgr.isCollapsed()).toBe(true);

			// Calling again when already collapsed returns false
			expect(mgr.handleUserPromptSubmit()).toBe(false);
		});

		it("un-collapses automatically when adding a new item or reopening an item", () => {
			const mgr = new TodoManager();
			mgr.add("A");
			mgr.update(1, { status: "completed" });
			mgr.handleUserPromptSubmit();
			expect(mgr.isCollapsed()).toBe(true);

			// Adding new item un-collapses
			mgr.add("B");
			expect(mgr.isCollapsed()).toBe(false);

			// Re-complete and collapse
			mgr.update(2, { status: "completed" });
			mgr.handleUserPromptSubmit();
			expect(mgr.isCollapsed()).toBe(true);

			// Updating an item back to in_progress un-collapses
			mgr.update(1, { status: "in_progress" });
			expect(mgr.isCollapsed()).toBe(false);
		});
	});

	describe("reconstructFromSession", () => {
		it("reconstructs state from toolResult message entries", () => {
			const mgr = new TodoManager();
			const entries = [
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "todo",
						details: {
							todos: [
								{ id: 1, text: "Build feature", status: "completed" },
								{ id: 2, text: "Write tests", status: "in_progress" },
							],
							nextId: 3,
						},
					},
				},
			];

			mgr.reconstructFromSession(entries);
			expect(mgr.getTodos()).toHaveLength(2);
			expect(mgr.getTodos()[0].text).toBe("Build feature");
			expect(mgr.getTodos()[0].status).toBe("completed");
			expect(mgr.getNextId()).toBe(3);
		});

		it("reconstructs state from custom session entries", () => {
			const mgr = new TodoManager();
			const entries = [
				{
					type: "custom",
					customType: SESSION_CUSTOM_TYPE,
					data: {
						todos: [{ id: 1, text: "Step from custom entry", status: "pending" }],
						nextId: 2,
					},
				},
			];

			mgr.reconstructFromSession(entries);
			expect(mgr.getTodos()).toHaveLength(1);
			expect(mgr.getTodos()[0].text).toBe("Step from custom entry");
			expect(mgr.getNextId()).toBe(2);
		});

		it("applies the latest state in chronological order", () => {
			const mgr = new TodoManager();
			const entries = [
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "todo",
						details: {
							todos: [{ id: 1, text: "Step 1", status: "pending" }],
							nextId: 2,
						},
					},
				},
				{
					type: "message",
					message: {
						role: "toolResult",
						toolName: "todo",
						details: {
							todos: [
								{ id: 1, text: "Step 1", status: "completed" },
								{ id: 2, text: "Step 2", status: "in_progress" },
							],
							nextId: 3,
						},
					},
				},
			];

			mgr.reconstructFromSession(entries);
			expect(mgr.getTodos()).toHaveLength(2);
			expect(mgr.getTodos()[0].status).toBe("completed");
			expect(mgr.getTodos()[1].status).toBe("in_progress");
			expect(mgr.getNextId()).toBe(3);
		});

		it("resets to empty when no todo entries exist in branch", () => {
			const mgr = new TodoManager([
				{ id: 1, text: "Will be cleared", status: "pending" },
			]);
			mgr.reconstructFromSession([]);
			expect(mgr.getTodos()).toEqual([]);
			expect(mgr.getNextId()).toBe(1);
		});
	});

	describe("widget & footer formatting", () => {
		it("returns undefined for widget lines when empty or collapsed or hidden", () => {
			const mgr = new TodoManager();
			expect(mgr.formatWidgetLines()).toBeUndefined();

			mgr.add("Test");
			expect(mgr.formatWidgetLines()).toBeDefined();

			mgr.setWidgetVisible(false);
			expect(mgr.formatWidgetLines()).toBeUndefined();

			mgr.setWidgetVisible(true);
			mgr.setCollapsed(true);
			expect(mgr.formatWidgetLines()).toBeUndefined();
		});

		it("formats boxed widget lines with proper headers and borders", () => {
			const mgr = new TodoManager();
			mgr.add("First step");
			mgr.add("Second step");
			mgr.update(1, { status: "completed" });
			mgr.update(2, { status: "in_progress" });

			const lines = mgr.formatWidgetLines(undefined, 70);
			expect(lines).toBeDefined();
			expect(lines![0]).toContain("── Todos (1/2 completed) ");
			expect(lines![lines!.length - 1]).toContain("───");
			expect(lines![1]).toContain("✓ #1 First step");
			expect(lines![2]).toContain("⋮ #2 Second step");
		});

		it("formats in_progress item using #7A81FF", () => {
			const mgr = new TodoManager();
			mgr.add("Active task");
			mgr.update(1, { status: "in_progress" });
			const theme = createMockTheme();
			const lines = mgr.formatWidgetLines(theme, 70);
			expect(lines).toBeDefined();
			expect(theme.fg).toHaveBeenCalledWith("accent", "⋮");
			expect(theme.fg).toHaveBeenCalledWith("accent", "#1");
			expect(theme.fg).toHaveBeenCalledWith("accent", "Active task");
		});

		it("formats pending items: top unstarted in dark font, items below in muted light grey", () => {
			const mgr = new TodoManager();
			mgr.add("Task 1");
			mgr.add("Task 2");
			mgr.add("Task 3");
			const theme = createMockTheme();
			const lines = mgr.formatWidgetLines(theme, 70);
			expect(lines).toBeDefined();
			// Top unstarted task description is unstyled (dark font)
			expect(theme.fg).not.toHaveBeenCalledWith("muted", "Task 1");
			// Items below top one use muted light grey
			expect(theme.fg).toHaveBeenCalledWith("muted", "Task 2");
			expect(theme.fg).toHaveBeenCalledWith("muted", "Task 3");
		});

		it("formats completed items with success greenish", () => {
			const mgr = new TodoManager();
			mgr.add("Done task");
			mgr.update(1, { status: "completed" });
			const theme = createMockTheme();
			const lines = mgr.formatWidgetLines(theme, 70);
			expect(lines).toBeDefined();
			expect(theme.fg).toHaveBeenCalledWith("success", "✓");
			expect(theme.fg).toHaveBeenCalledWith("success", "#1");
			expect(theme.fg).toHaveBeenCalledWith("success", "Done task");
		});

		it(`caps visible items at ${MAX_VISIBLE_WIDGET_ITEMS} and displays overflow notice`, () => {
			const mgr = new TodoManager();
			for (let i = 1; i <= 8; i++) {
				mgr.add(`Task number ${i}`);
			}

			const lines = mgr.formatWidgetLines(undefined, 70);
			expect(lines).toBeDefined();
			// Border top (1) + 5 visible items (5) + overflow notice (1) + border bottom (1) = 8 lines
			expect(lines).toHaveLength(8);
			expect(lines![lines!.length - 2]).toContain("… and 3 more (type /todos to view all)");
		});

		it("formats footer status", () => {
			const mgr = new TodoManager();
			expect(mgr.formatFooterStatus()).toBeUndefined();

			mgr.add("A");
			mgr.add("B");
			mgr.update(1, { status: "completed" });
			expect(mgr.formatFooterStatus()).toBe("📋 1/2");
		});
	});
});

describe("todo tool definition", () => {
	it("executes 'add' action and returns content and details", async () => {
		const mgr = new TodoManager();
		const tool = createTodoToolDefinition(mgr);
		const mock = createMockContext();

		const result = await tool.execute(
			"call-1",
			{ action: "add", text: "New feature" },
			new AbortController().signal,
			vi.fn(),
			mock.ctx,
		);

		expect(getText(result)).toContain("Added todo #1");
		expect(result.details?.todos).toHaveLength(1);
		expect(result.details?.item?.text).toBe("New feature");
		expect(mock.appendedCustomEntries).toHaveLength(1);
		expect(mock.widgetContent).toBeDefined();
		expect(mock.statusText).toBeUndefined();
		expect(mgr.formatFooterStatus()).toContain("📋 0/1");
	});

	it("returns error on 'add' action without text", async () => {
		const mgr = new TodoManager();
		const tool = createTodoToolDefinition(mgr);
		const mock = createMockContext();

		const result = await tool.execute(
			"call-2",
			{ action: "add", text: "   " },
			new AbortController().signal,
			vi.fn(),
			mock.ctx,
		);

		expect((result as any).isError).toBe(true);
		expect(getText(result)).toContain("Error: 'text' parameter is required");
	});

	it("executes 'update' action modifying status and text", async () => {
		const mgr = new TodoManager();
		mgr.add("Existing item");
		const tool = createTodoToolDefinition(mgr);
		const mock = createMockContext();

		const result = await tool.execute(
			"call-3",
			{ action: "update", id: 1, status: "completed", text: "Renamed & done" },
			new AbortController().signal,
			vi.fn(),
			mock.ctx,
		);

		expect(getText(result)).toContain("Updated todo #1 [completed]");
		expect(result.details?.item?.text).toBe("Renamed & done");
		expect(result.details?.item?.status).toBe("completed");
		expect(mock.statusText).toBeUndefined();
		expect(mgr.formatFooterStatus()).toContain("📋 1/1");
	});

	it("returns error on 'update' action when id is missing or not found", async () => {
		const mgr = new TodoManager();
		const tool = createTodoToolDefinition(mgr);
		const mock = createMockContext();

		// Missing id
		const res1 = await tool.execute(
			"call-4",
			{ action: "update", status: "completed" },
			new AbortController().signal,
			vi.fn(),
			mock.ctx,
		);
		expect((res1 as any).isError).toBe(true);
		expect(getText(res1)).toContain("Error: 'id' parameter is required");

		// Not found
		const res2 = await tool.execute(
			"call-5",
			{ action: "update", id: 99, status: "completed" },
			new AbortController().signal,
			vi.fn(),
			mock.ctx,
		);
		expect((res2 as any).isError).toBe(true);
		expect(getText(res2)).toContain("todo #99 not found");
	});

	it("executes 'toggle' action", async () => {
		const mgr = new TodoManager();
		mgr.add("Toggle target");
		const tool = createTodoToolDefinition(mgr);
		const mock = createMockContext();

		const result = await tool.execute(
			"call-6",
			{ action: "toggle", id: 1 },
			new AbortController().signal,
			vi.fn(),
			mock.ctx,
		);

		expect(getText(result)).toContain("Toggled todo #1 to [in_progress]");
	});

	it("executes 'list' action", async () => {
		const mgr = new TodoManager();
		const tool = createTodoToolDefinition(mgr);
		const mock = createMockContext();

		// Empty list
		const emptyRes = await tool.execute(
			"call-7",
			{ action: "list" },
			new AbortController().signal,
			vi.fn(),
			mock.ctx,
		);
		expect(getText(emptyRes)).toContain("No todos currently exist");

		// Populated list
		mgr.add("One");
		mgr.add("Two");
		mgr.update(1, { status: "completed" });
		const populatedRes = await tool.execute(
			"call-8",
			{ action: "list" },
			new AbortController().signal,
			vi.fn(),
			mock.ctx,
		);
		expect(getText(populatedRes)).toContain("Todos (1/2 completed)");
		expect(getText(populatedRes)).toContain("✓ #1 [completed] One");
		expect(getText(populatedRes)).toContain("○ #2 [pending] Two");
	});

	it("executes 'clear' action", async () => {
		const mgr = new TodoManager();
		mgr.add("A");
		const tool = createTodoToolDefinition(mgr);
		const mock = createMockContext();

		const result = await tool.execute(
			"call-9",
			{ action: "clear" },
			new AbortController().signal,
			vi.fn(),
			mock.ctx,
		);

		expect(getText(result)).toContain("Cleared all todos");
		expect(mgr.getTodos()).toHaveLength(0);
	});

	it("renders tool call and result cleanly", () => {
		const mgr = new TodoManager();
		const tool = createTodoToolDefinition(mgr);
		const theme = createMockTheme();

		const callComp = tool.renderCall!({ action: "add", text: "Sample" }, theme, {} as any);
		expect(callComp).toBeDefined();

		const resultComp = tool.renderResult!(
			{
				content: [{ type: "text", text: "Added" }],
				details: {
					action: "add",
					todos: [],
					nextId: 2,
					item: { id: 1, text: "Sample", status: "pending" },
				},
			},
			{} as any,
			theme,
			{} as any,
		);
		expect(resultComp).toBeDefined();
	});
});

describe("createTodoListModalComponent", () => {
	it("renders empty state and handles escape/q to close", () => {
		const mgr = new TodoManager();
		const tui = { requestRender: vi.fn() } as unknown as any;
		const theme = createMockTheme();
		const done = vi.fn();

		const modal = createTodoListModalComponent(mgr, tui, theme, done);
		const lines = modal.render(80);
		expect(lines.some((l) => l.includes("(no todos in this session)"))).toBe(true);

		modal.handleInput?.("q");
		expect(done).toHaveBeenCalledWith(null);

		done.mockClear();
		modal.handleInput?.(Key.escape);
		expect(done).toHaveBeenCalledWith(null);
	});

	it("navigates and toggles items with Space", () => {
		const mgr = new TodoManager();
		mgr.add("Alpha");
		mgr.add("Beta");

		const tui = { requestRender: vi.fn() } as unknown as any;
		const theme = createMockTheme();
		const done = vi.fn();
		const mock = createMockContext();

		const modal = createTodoListModalComponent(mgr, tui, theme, done, mock.ctx);
		let lines = modal.render(80);
		expect(lines.some((l) => l.includes("Alpha"))).toBe(true);

		// Space toggles selected (item 1) from pending to in_progress
		modal.handleInput?.(Key.space);
		expect(mgr.getTodos()[0].status).toBe("in_progress");

		// Down arrow navigates to item 2
		modal.handleInput?.(Key.down);
		modal.handleInput?.(Key.space);
		expect(mgr.getTodos()[1].status).toBe("in_progress");

		// Clear completed with c
		mgr.update(1, { status: "completed" });
		modal.handleInput?.("c");
		expect(mgr.getTodos()).toHaveLength(1);
		expect(mgr.getTodos()[0].text).toBe("Beta");
	});

	it("renders in_progress items with vertical ellipsis and #7A81FF color", () => {
		const mgr = new TodoManager();
		mgr.add("Active task");
		mgr.update(1, { status: "in_progress" });
		const tui = { requestRender: vi.fn() } as unknown as any;
		const theme = createMockTheme();
		const done = vi.fn();

		const modal = createTodoListModalComponent(mgr, tui, theme, done);
		const lines = modal.render(80);
		expect(lines.some((l) => l.includes("⋮"))).toBe(true);
		expect(theme.fg).toHaveBeenCalledWith("accent", "⋮");
		expect(theme.fg).toHaveBeenCalledWith("accent", "Active task");
	});
});

describe("rbfTodos extension lifecycle", () => {
	function createMockExtensionAPI() {
		const registeredTools: any[] = [];
		const registeredShortcuts = new Map<string, any>();
		const registeredCommands = new Map<string, any>();
		const eventHandlers = new Map<string, Array<(event: any, ctx: any) => Promise<void>>>();

		const api = {
			registerTool: vi.fn((tool: any) => {
				registeredTools.push(tool);
			}),
			registerShortcut: vi.fn((shortcut: string, options: any) => {
				registeredShortcuts.set(shortcut, options);
			}),
			registerCommand: vi.fn((name: string, options: any) => {
				registeredCommands.set(name, options);
			}),
			on: vi.fn((event: string, handler: any) => {
				const list = eventHandlers.get(event) ?? [];
				list.push(handler);
				eventHandlers.set(event, list);
			}),
		} as unknown as ExtensionAPI;

		return {
			api,
			registeredTools,
			registeredShortcuts,
			registeredCommands,
			async emit(event: string, eventData: any, ctx: any) {
				const handlers = eventHandlers.get(event) ?? [];
				for (const h of handlers) {
					await h(eventData, ctx);
				}
			},
		};
	}

	it("registers tool, shortcut, command, and event listeners", () => {
		const mockAPI = createMockExtensionAPI();
		rbfTodos(mockAPI.api);

		expect(mockAPI.api.registerTool).toHaveBeenCalledTimes(1);
		expect(mockAPI.registeredTools[0].name).toBe("todo");

		expect(mockAPI.api.registerShortcut).toHaveBeenCalledTimes(1);
		expect(mockAPI.registeredShortcuts.has(SHORTCUT_KEY)).toBe(true);

		expect(mockAPI.api.registerCommand).toHaveBeenCalledTimes(1);
		expect(mockAPI.registeredCommands.has("todos")).toBe(true);

		expect(mockAPI.api.on).toHaveBeenCalledWith("session_start", expect.any(Function));
		expect(mockAPI.api.on).toHaveBeenCalledWith("session_tree", expect.any(Function));
		expect(mockAPI.api.on).toHaveBeenCalledWith("before_agent_start", expect.any(Function));
	});

	it("handles Alt+T shortcut toggle with debounce protection", () => {
		vi.useFakeTimers();
		try {
			const mockAPI = createMockExtensionAPI();
			rbfTodos(mockAPI.api);
			const mock = createMockContext();

			const shortcut = mockAPI.registeredShortcuts.get(SHORTCUT_KEY);
			expect(shortcut).toBeDefined();

			// Add a todo through the tool first
			const tool = mockAPI.registeredTools[0];
			tool.execute("1", { action: "add", text: "Walk dog" }, new AbortController().signal, vi.fn(), mock.ctx);

			expect(mock.widgetContent).toBeDefined();

			// Trigger shortcut to hide
			shortcut.handler(mock.ctx);
			expect(mock.widgetContent).toBeUndefined();
			expect(mock.notifyMessage).toBeUndefined();

			// Immediate second invocation within debounce window is ignored
			shortcut.handler(mock.ctx);
			expect(mock.widgetContent).toBeUndefined();

			// Advance past cooldown window
			vi.advanceTimersByTime(300);

			// Trigger shortcut to show
			shortcut.handler(mock.ctx);
			expect(mock.widgetContent).toBeDefined();
			expect(mock.notifyMessage).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("collapses widget on before_agent_start when all todos are completed", async () => {
		const mockAPI = createMockExtensionAPI();
		rbfTodos(mockAPI.api);
		const mock = createMockContext();

		const tool = mockAPI.registeredTools[0];
		await tool.execute("1", { action: "add", text: "Step 1" }, new AbortController().signal, vi.fn(), mock.ctx);
		await tool.execute("2", { action: "update", id: 1, status: "completed" }, new AbortController().signal, vi.fn(), mock.ctx);

		// Widget remains visible right after completion
		expect(mock.widgetContent).toBeDefined();

		// User submits prompt -> before_agent_start fires -> widget collapses
		await mockAPI.emit("before_agent_start", { type: "before_agent_start" }, mock.ctx);
		expect(mock.widgetContent).toBeUndefined();
		// Line 3 footer status is cleared (badge lives on line 1 stats)
		expect(mock.statusText).toBeUndefined();
	});

	it("reconstructs branch state on session_tree and session_start", async () => {
		const mockAPI = createMockExtensionAPI();
		rbfTodos(mockAPI.api);

		const branchEntries = [
			{
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: {
						todos: [
							{ id: 1, text: "Branch task", status: "completed" },
							{ id: 2, text: "Next task", status: "pending" },
						],
						nextId: 3,
					},
				},
			},
		];
		const mock = createMockContext(branchEntries);

		await mockAPI.emit("session_start", { type: "session_start", reason: "startup" }, mock.ctx);
		expect(mock.statusText).toBeUndefined();
		expect(mock.widgetContent).toBeDefined();

		await mockAPI.emit("session_tree", { type: "session_tree" }, mock.ctx);
		expect(mock.statusText).toBeUndefined();
	});

	it("executes /todos command opening modal in TUI mode or notify in non-TUI", async () => {
		const mockAPI = createMockExtensionAPI();
		rbfTodos(mockAPI.api);

		const command = mockAPI.registeredCommands.get("todos");
		expect(command).toBeDefined();

		// Non-TUI mode fallback
		const nonTuiMock = {
			mode: "print",
			ui: { notify: vi.fn() },
		} as unknown as ExtensionCommandContext;
		await command.handler("", nonTuiMock);
		expect(nonTuiMock.ui.notify).toHaveBeenCalledWith("No todos in this session.", "info");

		// TUI mode modal
		const tuiMock = createMockContext();
		await command.handler("", tuiMock.ctx as any);
		expect(tuiMock.ctx.ui.custom).toHaveBeenCalled();
	});

	it("handles terminal input for Alt+T, ignoring key release and repeat events", async () => {
		vi.useFakeTimers();
		try {
			const mockAPI = createMockExtensionAPI();
			rbfTodos(mockAPI.api);
			const mock = createMockContext();

			await mockAPI.emit("session_start", { type: "session_start" }, mock.ctx);
			expect(mock.terminalInputListener).toBeDefined();

			// Add a todo
			const tool = mockAPI.registeredTools[0];
			await tool.execute("1", { action: "add", text: "Task 1" }, new AbortController().signal, vi.fn(), mock.ctx);
			expect(mock.widgetContent).toBeDefined();

			// 1. Key press event (\x1b[116;3:1u or \x1bt)
			const res1 = mock.terminalInputListener!("\x1b[116;3:1u");
			expect(res1).toEqual({ consume: true });
			expect(mock.widgetContent).toBeUndefined();
			expect(mock.notifyMessage).toBeUndefined();

			// 2. Key release event (\x1b[116;3:3u) must be consumed and NOT toggle back
			const resRelease = mock.terminalInputListener!("\x1b[116;3:3u");
			expect(resRelease).toEqual({ consume: true });
			expect(mock.widgetContent).toBeUndefined();

			// 3. Repeat event (\x1b[116;3:2u) must be consumed and NOT toggle
			const resRepeat = mock.terminalInputListener!("\x1b[116;3:2u");
			expect(resRepeat).toEqual({ consume: true });
			expect(mock.widgetContent).toBeUndefined();

			// 4. Advance timers past cooldown
			vi.advanceTimersByTime(300);

			// 5. Option+T character on macOS (†) toggles widget back
			const res2 = mock.terminalInputListener!("†");
			expect(res2).toEqual({ consume: true });
			expect(mock.widgetContent).toBeDefined();
			expect(mock.notifyMessage).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("handles SGR mouse move events outside badge bounds to reset hover", async () => {
		const mockAPI = createMockExtensionAPI();
		rbfTodos(mockAPI.api);
		const mock = createMockContext();

		await mockAPI.emit("session_start", { type: "session_start" }, mock.ctx);
		expect(mock.terminalInputListener).toBeDefined();

		setIsBadgeHovered(true);
		expect(getIsBadgeHovered()).toBe(true);

		// SGR move at screen coordinates (x=10, y=10)
		mock.terminalInputListener!("\x1b[<35;10;10M");
		expect(getIsBadgeHovered()).toBe(false);
	});
});

describe("formatStatsLineWithTodos & calculateBadgeBounds", () => {
	const theme = {
		fg: vi.fn((_color: string, text: string) => `[${text}]`),
		bold: vi.fn((text: string) => `*${text}*`),
		inverse: vi.fn((text: string) => `!${text}!`),
	};

	it("returns original statsLine when totalCount is 0", () => {
		const line = "↑109k ↓195 (auto)          (anthropic) claude-3-5-sonnet";
		expect(formatStatsLineWithTodos(line, 0, 0, false, 80, theme)).toBe(line);
		expect(calculateBadgeBounds(line, 0, 0, 80)).toBeNull();
	});

	it("injects resting badge with accent font and dim bullet into stats line", () => {
		const line = "↑109k ↓195 (auto)          (anthropic) claude-3-5-sonnet";
		const formatted = formatStatsLineWithTodos(line, 0, 3, false, 80, theme);
		expect(formatted).toContain("· ");
		expect(formatted).toContain("📋 0/3");
		expect(formatted).toContain("(anthropic) claude-3-5-sonnet");
	});

	it("injects resting badge with success color when all todos are completed", () => {
		const line = "↑109k ↓195 (auto)          (anthropic) claude-3-5-sonnet";
		const formatted = formatStatsLineWithTodos(line, 3, 3, false, 80, theme);
		expect(theme.fg).toHaveBeenCalledWith("success", "📋 3/3");
		expect(formatted).toContain("· ");
		expect(formatted).toContain("📋 3/3");
	});

	it("injects hovered badge with inverse styling when isSelected is true", () => {
		const line = "↑109k ↓195 (auto)          (anthropic) claude-3-5-sonnet";
		const formatted = formatStatsLineWithTodos(line, 1, 3, true, 80, theme);
		expect(formatted).toContain("! 📋 1/3 !");
	});

	it("calculates accurate badge bounds", () => {
		const line = "↑109k ↓195 (auto)          (anthropic) claude-3-5-sonnet";
		const bounds = calculateBadgeBounds(line, 0, 3, 80);
		expect(bounds).not.toBeNull();
		expect(bounds?.y).toBe(1);
		expect(bounds?.startX).toBeGreaterThan(0);
		expect(bounds?.endX).toBeGreaterThan(bounds!.startX);
	});
});

describe("patchFooterComponent & unpatchFooterComponent", () => {
	beforeAll(() => {
		initTheme();
	});

	afterEach(() => {
		unpatchFooterComponent();
	});

	it("patches FooterComponent and renders todo badge on lines[1] without creating line 3", () => {
		const tm = new TodoManager();
		let hovered = false;
		const patched = patchFooterComponent(tm, () => hovered);
		expect(patched).toBe(true);

		const mockSession = {
			sessionManager: { getCwd: () => "/test", getSessionName: () => undefined, getEntries: () => [] },
			state: { model: { id: "claude-3-5-sonnet", provider: "anthropic" } },
			modelRuntime: { isUsingSubscription: () => true },
			getContextUsage: () => ({ percent: 0.1, contextWindow: 272000 }),
		};
		const mockFooterData = {
			getGitBranch: () => "main",
			getAvailableProviderCount: () => 1,
			getExtensionStatuses: () => new Map(),
		};
		const footer = new (FooterComponent as any)(mockSession, mockFooterData);

		// With 0 todos: only 2 lines, no clipboard badge
		const lines0 = footer.render(100);
		expect(lines0.length).toBe(2);
		expect(lines0[1]).not.toContain("📋");

		// Add a todo
		tm.add("Write tests");

		// With 1 todo: lines[1] contains "📋 0/1"
		const lines1 = footer.render(100);
		expect(lines1.length).toBe(2);
		expect(lines1[1]).toContain("📋 0/1");

		// Unpatch restores original
		unpatchFooterComponent();
		const linesUnpatched = footer.render(100);
		expect(linesUnpatched[1]).not.toContain("📋");
	});

	it("handles mouse hover and click interactions on todo badge", () => {
		const tm = new TodoManager();
		tm.add("Write tests");
		let hovered = false;
		const onBadgeClick = vi.fn();

		patchFooterComponent(
			tm,
			() => hovered,
			onBadgeClick,
		);

		const mockSession = {
			sessionManager: { getCwd: () => "/test", getSessionName: () => undefined, getEntries: () => [] },
			state: { model: { id: "claude-3-5-sonnet", provider: "anthropic" } },
			modelRuntime: { isUsingSubscription: () => true },
			getContextUsage: () => ({ percent: 0.1, contextWindow: 272000 }),
		};
		const mockFooterData = {
			getGitBranch: () => "main",
			getAvailableProviderCount: () => 1,
			getExtensionStatuses: () => new Map(),
		};
		const footer = new (FooterComponent as any)(mockSession, mockFooterData);

		// Render to populate currentBadgeBounds
		footer.render(100);
		const bounds = getBadgeBounds();
		expect(bounds).not.toBeNull();

		// Mouse move outside badge
		const moveOut = footer.handleMouse({
			type: "move",
			x: 0,
			y: 0,
			screenX: 0,
			screenY: 0,
		});
		expect(moveOut).toBeUndefined();

		// Mouse move inside badge
		const moveIn = footer.handleMouse({
			type: "move",
			x: bounds!.startX + 2,
			y: bounds!.y,
			screenX: bounds!.startX + 2,
			screenY: 20,
		});
		expect(moveIn?.handled).toBe(true);
		expect(getIsBadgeHovered()).toBe(true);

		// Mouse click inside badge triggers handler
		const clickResult = footer.handleMouse({
			type: "click",
			button: "left",
			x: bounds!.startX + 2,
			y: bounds!.y,
			screenX: bounds!.startX + 2,
			screenY: 20,
		});
		expect(clickResult?.handled).toBe(true);
		expect(onBadgeClick).toHaveBeenCalled();
	});
});
