import { SkillInvocationMessageComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, Spacer, Text } from "@earendil-works/pi-tui";

export const SKILL_LOADED_BLENDED_KEY = Symbol.for("rbf.skillLoadedBlended.patched");
export const ORIGINAL_SKILL_UPDATE_DISPLAY_KEY = Symbol.for("rbf.skillLoadedBlended.originalUpdateDisplay");

const FALLBACK_THEME = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};

/**
 * Retrieve active theme from Pi's global symbol registration.
 */
export function getActiveTheme(): any {
	return (
		(typeof globalThis !== "undefined"
			? (globalThis as any)[Symbol.for("@earendil-works/pi-coding-agent:theme")] ??
				(globalThis as any)[Symbol.for("@mariozechner/pi-coding-agent:theme")]
			: undefined) ?? FALLBACK_THEME
	);
}

/**
 * Format Line 1 of the skill loaded indicator:
 * `● Skill(<name>)` where bullet is green, "Skill" is bold text, and "(<name>)" is regular text.
 */
export function formatSkillLoadedLine1(name: string, theme?: any): string {
	const t = theme ?? getActiveTheme();
	const bullet = typeof t?.fg === "function" ? t.fg("success", "●") : "●";
	const skillWord = typeof t?.fg === "function" ? t.fg("text", "Skill") : "Skill";
	const boldSkill = typeof t?.bold === "function" ? t.bold(skillWord) : `\x1b[1m${skillWord}\x1b[22m`;
	const nameText = typeof t?.fg === "function" ? t.fg("text", `(${name})`) : `(${name})`;
	return `${bullet} ${boldSkill}${nameText}`;
}

/**
 * Format Line 2 of the skill loaded indicator:
 * `  └  Successfully loaded skill` where tree symbol and status text are muted.
 */
export function formatSkillLoadedLine2(theme?: any): string {
	const t = theme ?? getActiveTheme();
	const symbol = typeof t?.fg === "function" ? t.fg("muted", "└") : "└";
	const label = typeof t?.fg === "function" ? t.fg("muted", "Successfully loaded skill") : "Successfully loaded skill";
	return `  ${symbol}  ${label}`;
}

/**
 * Format the combined collapsed skill loaded indicator.
 */
export function formatSkillLoadedCollapsed(name: string, theme?: any): string {
	return `${formatSkillLoadedLine1(name, theme)}\n${formatSkillLoadedLine2(theme)}`;
}

/**
 * Patch SkillInvocationMessageComponent so loaded skills blend cleanly into the background:
 * - Transparent background (bgFn = undefined)
 * - Zero vertical padding (paddingY = 0)
 * - Clean Claude Code format:
 *     ● Skill(<name>)
 *       └  Successfully loaded skill
 * - Clutter removed: no `[skill]` tag, no `(Ctrl+O to expand)` hint
 * - Expanded state preserves clean header and unboxed markdown instructions
 */
export function applySkillLoadedBlended(): boolean {
	const proto = SkillInvocationMessageComponent.prototype as any;
	if (proto[SKILL_LOADED_BLENDED_KEY]) {
		return false;
	}

	const originalUpdateDisplay = proto.updateDisplay;
	proto[ORIGINAL_SKILL_UPDATE_DISPLAY_KEY] = originalUpdateDisplay;

	proto.updateDisplay = function (this: any): void {
		this.setBgFn(undefined);
		this.paddingY = 0;
		this.invalidateCache?.();
		this.clear();

		const activeTheme = getActiveTheme();
		const skillName = this.skillBlock?.name ?? "";
		const skillContent = this.skillBlock?.content ?? "";

		if (this.expanded) {
			const headerText = formatSkillLoadedCollapsed(skillName, activeTheme);
			this.addChild(new Text(headerText, 0, 0));
			this.addChild(new Spacer(1));
			this.addChild(
				new Markdown(skillContent, 0, 0, this.markdownTheme, {
					color: (text: string) => (typeof activeTheme?.fg === "function" ? activeTheme.fg("text", text) : text),
				})
			);
		} else {
			const headerText = formatSkillLoadedCollapsed(skillName, activeTheme);
			this.addChild(new Text(headerText, 0, 0));
		}
	};

	proto[SKILL_LOADED_BLENDED_KEY] = true;
	return true;
}

/**
 * Restore SkillInvocationMessageComponent.prototype.updateDisplay to its unpatched implementation.
 */
export function restoreSkillLoadedBlended(): boolean {
	const proto = SkillInvocationMessageComponent.prototype as any;
	if (!proto[SKILL_LOADED_BLENDED_KEY]) {
		return false;
	}

	if (proto[ORIGINAL_SKILL_UPDATE_DISPLAY_KEY]) {
		proto.updateDisplay = proto[ORIGINAL_SKILL_UPDATE_DISPLAY_KEY];
		delete proto[ORIGINAL_SKILL_UPDATE_DISPLAY_KEY];
	}
	delete proto[SKILL_LOADED_BLENDED_KEY];
	return true;
}

export default function rbfSkillLoadedBlended(_pi?: ExtensionAPI): void {
	applySkillLoadedBlended();
}
