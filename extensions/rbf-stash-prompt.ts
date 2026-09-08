import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const WIDGET_KEY = "rbf-stash-prompt";
const STATUS_TEXT = "Draft stashed · Ctrl+S restore";

export function nextDraftState(
	activeDraft: string,
	stashedDraft?: string,
): {
	nextActive: string;
	nextStash?: string;
} {
	const isEmpty = activeDraft.trim().length === 0;

	if (stashedDraft === undefined) {
		if (isEmpty) {
			return { nextActive: activeDraft, nextStash: undefined };
		}
		return { nextActive: "", nextStash: activeDraft };
	}

	if (isEmpty) {
		return { nextActive: stashedDraft, nextStash: undefined };
	}

	return { nextActive: stashedDraft, nextStash: activeDraft };
}

export default function rbfStashPrompt(pi: ExtensionAPI): void {
	let stashedDraft: string | undefined;

	pi.registerShortcut("ctrl+s", {
		description: "Stash or restore prompt draft",
		handler(ctx: ExtensionContext) {
			const activeDraft = ctx.ui.getEditorText();

			if (stashedDraft === undefined && activeDraft.trim().length === 0) {
				return;
			}

			const { nextActive, nextStash } = nextDraftState(activeDraft, stashedDraft);

			ctx.ui.setEditorText(nextActive);
			stashedDraft = nextStash;

			const widgetContent = stashedDraft !== undefined ? [ctx.ui.theme.fg("dim", STATUS_TEXT)] : undefined;
			ctx.ui.setWidget(WIDGET_KEY, widgetContent, { placement: "belowEditor" });
		},
	});
}
