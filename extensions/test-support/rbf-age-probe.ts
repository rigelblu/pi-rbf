// Test-only conditions for the last-message age PTY checks (pi-43). Load it before the status line.
//   RBF_AGE_PROBE=legacy         a footer wrapper as installed before the age feature: patched, no version
//   RBF_AGE_PROBE=bad-timestamp  delivered user messages reach later extensions with an unusable timestamp
import { FooterComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function rbfAgeProbe(pi: ExtensionAPI): void {
	const proto = FooterComponent.prototype as any;
	const patched = Symbol.for("rbf.statusLine.footerPatched");
	if (process.env.RBF_AGE_PROBE === "legacy" && !proto[patched]) {
		const inner = proto.render;
		proto[Symbol.for("rbf.statusLine.originalFooterRender")] = inner;
		proto[patched] = true;
		proto.render = function (this: unknown, width: number): string[] {
			return inner.call(this, width);
		};
	}
	if (process.env.RBF_AGE_PROBE === "bad-timestamp") {
		pi.on("message_start", (event) => {
			if (event.message.role === "user") (event.message as any).timestamp = Number.NaN;
		});
	}
}
