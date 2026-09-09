import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initTheme, SkillInvocationMessageComponent } from "@earendil-works/pi-coding-agent";
import type { ParsedSkillBlock } from "@earendil-works/pi-coding-agent";
import rbfSkillLoadedBlended, {
	applySkillLoadedBlended,
	formatSkillLoadedCollapsed,
	formatSkillLoadedLine1,
	formatSkillLoadedLine2,
	getActiveTheme,
	restoreSkillLoadedBlended,
	SKILL_LOADED_BLENDED_KEY,
} from "./rbf-skill-loaded-blended.ts";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

describe("rbf-skill-loaded-blended extension", () => {
	const sampleSkillBlock: ParsedSkillBlock = {
		name: "find-skills",
		content: "Use this skill to discover agent skills when asked.",
		location: "/path/to/skill/SKILL.md",
		userMessage: "find skills for testing",
	};

	beforeEach(() => {
		initTheme();
		restoreSkillLoadedBlended();
	});

	afterEach(() => {
		restoreSkillLoadedBlended();
	});

	it("default unpatched SkillInvocationMessageComponent has paddingY = 1, bgFn defined, and [skill] label", () => {
		const comp = new SkillInvocationMessageComponent(sampleSkillBlock);

		expect((comp as any).paddingY).toBe(1);
		expect((comp as any).bgFn).toBeDefined();

		const lines = comp.render(80);
		// 1 top padding + 1 content line + 1 bottom padding = 3 lines
		expect(lines.length).toBe(3);
		// Content line contains [skill] and expand hint
		const contentText = stripAnsi(lines[1]);
		expect(contentText).toContain("[skill]");
		expect(contentText).toMatch(/to expand/i);
		// Native component applies background ANSI code
		expect(lines[1]).toMatch(/\x1b\[4\d/);
	});

	it("applySkillLoadedBlended() sets paddingY = 0, bgFn = undefined, and renders Claude Code style collapsed indicator", () => {
		const applied = applySkillLoadedBlended();
		expect(applied).toBe(true);

		const comp = new SkillInvocationMessageComponent(sampleSkillBlock);

		expect((comp as any).paddingY).toBe(0);
		expect((comp as any).bgFn).toBeUndefined();

		const lines = comp.render(80);
		// Zero vertical padding: exactly 2 lines (Line 1 + Line 2)
		expect(lines.length).toBe(2);

		const line1Clean = stripAnsi(lines[0]).trimEnd();
		const line2Clean = stripAnsi(lines[1]).trimEnd();

		// Line 1: 1 leading space from Box paddingX = 1
		expect(line1Clean).toBe(" ● Skill(find-skills)");

		// Line 2: 3 leading spaces (1 from Box paddingX + 2 relative indent), aligning └ under Skill
		expect(line2Clean).toBe("   └  Successfully loaded skill");

		// Clutter removed
		expect(line1Clean).not.toContain("[skill]");
		expect(line2Clean).not.toContain("[skill]");
		expect(line1Clean).not.toMatch(/to expand/i);
		expect(line2Clean).not.toMatch(/to expand/i);

		// Unboxed transparent text contains no background ANSI color codes
		expect(lines[0]).not.toMatch(/\x1b\[4\d/);
		expect(lines[1]).not.toMatch(/\x1b\[4\d/);
	});

	it("formatSkillLoadedLine1 formats green bullet, bold Skill, and unbolded (name)", () => {
		const mockTheme = {
			fg: (color: string, text: string) => `[${color}:${text}]`,
			bold: (text: string) => `<b>${text}</b>`,
		};

		const line1 = formatSkillLoadedLine1("my-skill", mockTheme);
		expect(line1).toBe("[success:●] <b>[text:Skill]</b>[text:(my-skill)]");
		expect(stripAnsi(line1)).toBe("[success:●] <b>[text:Skill]</b>[text:(my-skill)]");
	});

	it("formatSkillLoadedLine2 formats tree symbol and status as muted with proper spacing", () => {
		const mockTheme = {
			fg: (color: string, text: string) => `[${color}:${text}]`,
		};

		const line2 = formatSkillLoadedLine2(mockTheme);
		expect(line2).toBe("  [muted:└]  [muted:Successfully loaded skill]");
	});

	it("formatSkillLoadedCollapsed combines line 1 and line 2 with newline", () => {
		const mockTheme = {
			fg: (color: string, text: string) => text,
			bold: (text: string) => text,
		};

		const collapsed = formatSkillLoadedCollapsed("browser", mockTheme);
		expect(collapsed).toBe("● Skill(browser)\n  └  Successfully loaded skill");
	});

	it("renders expanded state with clean header, spacer, and markdown instructions", () => {
		applySkillLoadedBlended();

		const comp = new SkillInvocationMessageComponent(sampleSkillBlock);
		comp.setExpanded(true);

		expect((comp as any).paddingY).toBe(0);
		expect((comp as any).bgFn).toBeUndefined();

		const lines = comp.render(80);
		// Header line 1 + Header line 2 + spacer + markdown content
		expect(lines.length).toBeGreaterThan(2);

		const line1Clean = stripAnsi(lines[0]).trimEnd();
		const line2Clean = stripAnsi(lines[1]).trimEnd();
		const fullTextClean = stripAnsi(lines.join("\n"));

		expect(line1Clean).toBe(" ● Skill(find-skills)");
		expect(line2Clean).toBe("   └  Successfully loaded skill");

		// Still no [skill] badge
		expect(fullTextClean).not.toContain("[skill]");
		// Full markdown content rendered
		expect(fullTextClean).toContain("Use this skill to discover");

		// Transparent background preserved in expanded mode
		expect(lines[0]).not.toMatch(/\x1b\[4\d/);
		expect(lines[1]).not.toMatch(/\x1b\[4\d/);
	});

	it("toggles cleanly between collapsed and expanded states", () => {
		applySkillLoadedBlended();

		const comp = new SkillInvocationMessageComponent(sampleSkillBlock);

		// Initial: collapsed (2 lines)
		expect((comp as any).expanded).toBe(false);
		expect(comp.render(80).length).toBe(2);

		// Expand
		comp.setExpanded(true);
		expect((comp as any).expanded).toBe(true);
		expect(comp.render(80).length).toBeGreaterThan(2);

		// Collapse back (2 lines)
		comp.setExpanded(false);
		expect((comp as any).expanded).toBe(false);
		expect(comp.render(80).length).toBe(2);
	});

	it("applySkillLoadedBlended is idempotent and does not double-wrap", () => {
		const first = applySkillLoadedBlended();
		expect(first).toBe(true);

		const second = applySkillLoadedBlended();
		expect(second).toBe(false);

		const comp = new SkillInvocationMessageComponent(sampleSkillBlock);
		expect((comp as any).paddingY).toBe(0);
		expect((comp as any).bgFn).toBeUndefined();
	});

	it("restoreSkillLoadedBlended restores unpatched behavior", () => {
		applySkillLoadedBlended();
		expect((SkillInvocationMessageComponent.prototype as any)[SKILL_LOADED_BLENDED_KEY]).toBe(true);

		const restored = restoreSkillLoadedBlended();
		expect(restored).toBe(true);
		expect((SkillInvocationMessageComponent.prototype as any)[SKILL_LOADED_BLENDED_KEY]).toBeUndefined();

		const comp = new SkillInvocationMessageComponent(sampleSkillBlock);
		expect((comp as any).paddingY).toBe(1);
		expect((comp as any).bgFn).toBeDefined();
		expect(stripAnsi(comp.render(80)[1])).toContain("[skill]");
	});

	it("extension entrypoint rbfSkillLoadedBlended applies the patch", () => {
		rbfSkillLoadedBlended();

		const comp = new SkillInvocationMessageComponent(sampleSkillBlock);
		expect((comp as any).paddingY).toBe(0);
		expect((comp as any).bgFn).toBeUndefined();
		expect(stripAnsi(comp.render(80)[0]).trimEnd()).toBe(" ● Skill(find-skills)");
	});

	it("getActiveTheme returns valid theme or fallback with fg, bg, and bold", () => {
		const activeTheme = getActiveTheme();
		expect(activeTheme).toBeDefined();
		expect(typeof activeTheme.fg).toBe("function");
		expect(typeof activeTheme.bold).toBe("function");
	});

	it("handles missing or empty skillBlock properties gracefully without throwing", () => {
		applySkillLoadedBlended();

		const emptySkillBlock = { name: "", content: "", location: "", userMessage: "" } as ParsedSkillBlock;
		const compEmpty = new SkillInvocationMessageComponent(emptySkillBlock);
		expect(() => compEmpty.render(80)).not.toThrow();
		expect(stripAnsi(compEmpty.render(80)[0]).trimEnd()).toBe(" ● Skill()");

		const compExpandedEmpty = new SkillInvocationMessageComponent(emptySkillBlock);
		compExpandedEmpty.setExpanded(true);
		expect(() => compExpandedEmpty.render(80)).not.toThrow();
	});

	it("source code contains no unauthorized sinks or network/child_process imports", () => {
		const sourcePath = resolve(__dirname, "rbf-skill-loaded-blended.ts");
		const content = readFileSync(sourcePath, "utf-8");

		expect(content).not.toMatch(/node:child_process|child_process/);
		expect(content).not.toMatch(/node:fs|fs/);
		expect(content).not.toMatch(/node:net|node:http|fetch/);
		expect(content).not.toMatch(/process\.exit/);
	});
});
