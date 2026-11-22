// Test-only companion for the shell-count PTY cases. It writes every message on the owners' display channel
// to RBF_SHELL_DISPLAY_LOG, one JSON object per line, so a case can assert on what an owner said and when.
// With RBF_SHELL_DISPLAY_THROW set it then throws, the way a broken subscriber would.
// `/rbf-groups-fault render|mouse` breaks the live view's own bookkeeping so its fail-open path runs in a real Pi.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { InteractiveMode, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { hyperlink } from "@earendil-works/pi-tui";

const CHANNEL = "rbf:shell-display:v1";
const VIEW_KEY = Symbol.for("rbf.shellCommandGroups.view");

export default function rbfShellDisplayProbe(pi: ExtensionAPI): void {
	const log = process.env.RBF_SHELL_DISPLAY_LOG;
	if (log && typeof pi.events?.on === "function") {
		pi.events.on(CHANNEL, (data) => {
			appendFileSync(log, `${JSON.stringify(data, (_key, value) => (typeof value === "function" ? "[function]" : value))}\n`);
			if (process.env.RBF_SHELL_DISPLAY_THROW) throw new Error("probe subscriber failure");
		});
	}

	let active = true;

	let wrappedHandleEvent: any;
	let originalHandleEvent: any;

	interface RendererRecord {
		renderer: any;
		hadOpenUrl: boolean;
		originalOpenUrl: any;
		probeOpenUrl: any;
		hadCopySelection: boolean;
		originalCopySelection: any;
		probeCopySelection: any;
		hadCopyOnSelect: boolean;
		originalCopyOnSelect: any;
	}

	const capturedRenderers = new Map<any, RendererRecord>();

	const linkLog = process.env.RBF_PROBE_LINK_LOG;
	const copyLog = process.env.RBF_PROBE_COPY_LOG;

	if (linkLog || copyLog) {
		originalHandleEvent = (InteractiveMode.prototype as any).handleEvent;
		if (typeof originalHandleEvent === "function") {
			wrappedHandleEvent = function (this: any, ...args: any[]) {
				if (active && this?.renderer) {
					const r = this.renderer;
					if (!capturedRenderers.has(r)) {
						const hadOpenUrl = Object.prototype.hasOwnProperty.call(r, "openUrl");
						const originalOpenUrl = r.openUrl;
						const hadCopySelection = Object.prototype.hasOwnProperty.call(r, "copySelection");
						const originalCopySelection = r.copySelection;
						const hadCopyOnSelect = Object.prototype.hasOwnProperty.call(r, "copyOnSelect");
						const originalCopyOnSelect = r.copyOnSelect;

						const probeOpenUrl = function (this: any, ...args: any[]): any {
							if (active) {
								appendFileSync(linkLog!, `${args[0]}\n`);
							} else if (typeof originalOpenUrl === "function") {
								return originalOpenUrl.apply(this, args);
							}
						};

						const probeCopySelection = async function (this: any, ...args: any[]): Promise<any> {
							if (active) {
								appendFileSync(copyLog!, `${args[0]}\n`);
								return true;
							} else if (typeof originalCopySelection === "function") {
								return originalCopySelection.apply(this, args);
							}
							return true;
						};

						const rec: RendererRecord = {
							renderer: r,
							hadOpenUrl,
							originalOpenUrl,
							probeOpenUrl,
							hadCopySelection,
							originalCopySelection,
							probeCopySelection,
							hadCopyOnSelect,
							originalCopyOnSelect,
						};
						capturedRenderers.set(r, rec);
						if (linkLog) {
							r.openUrl = probeOpenUrl;
						}
						if (copyLog) {
							r.copyOnSelect = true;
							r.copySelection = probeCopySelection;
						}
					}
				}
				return originalHandleEvent.apply(this, args);
			};
			(InteractiveMode.prototype as any).handleEvent = wrappedHandleEvent;
		}
	}

	let wrappedRender: any;
	let originalRender: any;
	const linkCmd = process.env.RBF_PROBE_LINK_COMMAND;
	if (linkCmd) {
		originalRender = ToolExecutionComponent.prototype.render;
		if (typeof originalRender === "function") {
			wrappedRender = function (this: any, width: number) {
				// Copy Pi's lines before pushing: Pi hands back its cached array while nothing changed, so a push grows the row every frame.
				const lines: string[] = [...originalRender.call(this, width)];
				const cmd = this.args?.command;
				if (active && this.expanded && typeof cmd === "string" && cmd.includes(linkCmd)) {
					// Labelled test-only native hyperlink line
					lines.push("    " + hyperlink("Full Output (test link)", process.env.RBF_PROBE_LINK_TARGET || "file:///tmp/rbf-test-full-output.log"));
				}
				return lines;
			};
			ToolExecutionComponent.prototype.render = wrappedRender;
		}
	}

	if (typeof pi.on === "function") {
		pi.on("session_shutdown", () => {
			active = false;
			if (wrappedHandleEvent && (InteractiveMode.prototype as any).handleEvent === wrappedHandleEvent) {
				(InteractiveMode.prototype as any).handleEvent = originalHandleEvent;
			}
			if (wrappedRender && ToolExecutionComponent.prototype.render === wrappedRender) {
				ToolExecutionComponent.prototype.render = originalRender;
			}
			for (const rec of capturedRenderers.values()) {
				const r = rec.renderer;
				if (r.openUrl === rec.probeOpenUrl) {
					if (rec.hadOpenUrl) {
						r.openUrl = rec.originalOpenUrl;
					} else {
						delete r.openUrl;
					}
				}
				const ownsCopy = r.copySelection === rec.probeCopySelection;
				if (ownsCopy) {
					if (rec.hadCopySelection) {
						r.copySelection = rec.originalCopySelection;
					} else {
						delete r.copySelection;
					}
					if (copyLog && r.copyOnSelect === true) {
						if (rec.hadCopyOnSelect) {
							r.copyOnSelect = rec.originalCopyOnSelect;
						} else {
							delete r.copyOnSelect;
						}
					}
				}
			}
			capturedRenderers.clear();
		});
	}

	pi.registerCommand("rbf-groups-fault", {
		description: "Test only: break the shell-count view's own bookkeeping",
		handler: async (args) => {
			const view = (globalThis as any)[VIEW_KEY];
			const state = view?.state;
			const fault = () => {
				throw new Error("injected grouping fault");
			};
			// The view reads a group's members while drawing, and the regroup count only when a header takes a press.
			if (args.trim() === "mouse") Object.defineProperty(state, "reconciliations", { configurable: true, get: fault });
			else if (state?.groups?.[0]) Object.defineProperty(state.groups[0], "memberIds", { configurable: true, get: fault });
		},
	});
}
