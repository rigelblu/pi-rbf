import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export const EXIT_COMMAND_NAME = "exit";
export const EXIT_COMMAND_DESCRIPTION = "Exit pi";

export default function rbfExit(pi: ExtensionAPI): void {
	pi.registerCommand(EXIT_COMMAND_NAME, {
		description: EXIT_COMMAND_DESCRIPTION,
		handler: async (_args: string, ctx: ExtensionCommandContext): Promise<void> => {
			ctx.shutdown();
		},
	});
}
