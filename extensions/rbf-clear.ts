import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export const CLEAR_COMMAND_NAME = "clear";
export const CLEAR_COMMAND_DESCRIPTION = "Clear conversation and start a new session";
export const CLEAR_SESSION_NOTICE = "✓ New session started";

export default function rbfClear(pi: ExtensionAPI): void {
	pi.registerCommand(CLEAR_COMMAND_NAME, {
		description: CLEAR_COMMAND_DESCRIPTION,
		handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
			await ctx.newSession({
				withSession: async (newCtx): Promise<void> => {
					newCtx.ui?.notify?.(CLEAR_SESSION_NOTICE, "info");
				},
			});
		},
	});
}
