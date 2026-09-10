import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export const RENAME_COMMAND_NAME = "rename";
export const RENAME_COMMAND_DESCRIPTION = "Name or rename current session (alias for /name)";
export const RENAME_USAGE = "Usage: /rename <name>";

export default function rbfRename(pi: ExtensionAPI): void {
	pi.registerCommand(RENAME_COMMAND_NAME, {
		description: RENAME_COMMAND_DESCRIPTION,
		handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			const name = args.trim();

			if (!name) {
				const currentName = pi.getSessionName();
				ctx.ui.notify(
					currentName ? `Session name: ${currentName}` : RENAME_USAGE,
					currentName ? "info" : "warning",
				);
				return;
			}

			pi.setSessionName(name);
			const sessionName = pi.getSessionName() ?? name;

			if (sessionName !== name) {
				ctx.ui.notify(
					`Session name was normalized from ${JSON.stringify(name)} to ${JSON.stringify(sessionName)}`,
					"warning",
				);
			}

			ctx.ui.notify(`Session name set: ${sessionName}`, "info");
		},
	});
}
