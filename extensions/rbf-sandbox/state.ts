export type SandboxState = "off" | "starting" | "active" | "failed";

export interface SandboxSnapshot {
	readonly reason?: string;
	readonly state: SandboxState;
}

export class SandboxController {
	#snapshot: SandboxSnapshot;

	constructor(readonly sandboxRequested: boolean) {
		this.#snapshot = { state: sandboxRequested ? "starting" : "off" };
	}

	get snapshot(): SandboxSnapshot {
		return this.#snapshot;
	}

	activate(): void {
		if (!this.sandboxRequested || this.#snapshot.state !== "starting") {
			throw new Error("Sandbox can activate only from requested starting state");
		}
		this.#snapshot = { state: "active" };
	}

	beginReentry(): void {
		if (!this.sandboxRequested || this.#snapshot.state !== "active") {
			throw new Error("Sandbox can re-enter only from active state");
		}
		this.#snapshot = { state: "starting" };
	}

	fail(reason: string): void {
		if (this.#snapshot.state === "off") throw new Error("Off sandbox cannot fail");
		this.#snapshot = { state: "failed", reason };
	}

	blocksHostAffectingTools(): boolean {
		return this.sandboxRequested && this.#snapshot.state !== "active";
	}
}

export function statusText(snapshot: SandboxSnapshot): string {
	switch (snapshot.state) {
		case "off":
			return "sandbox: off";
		case "starting":
			return "sandbox: starting · tools blocked";
		case "active":
			return "sandbox: active";
		case "failed":
			return "sandbox: failed · tools blocked";
	}
}
