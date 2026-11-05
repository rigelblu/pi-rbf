import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AGY_API, AGY_PROVIDER, parseAgyCatalogue, toAgyProviderModel } from "../rbf-agy.js";

const modelId = "gemini-3.8-flash";
const thinkingLevel = "high";

function provision(catalogue: ReturnType<typeof parseAgyCatalogue>) {
	const models = catalogue.map(toAgyProviderModel).map(model => ({
		...model, api: AGY_API, provider: AGY_PROVIDER, baseUrl: "stdio://agy",
	}));
	if (!models.some(model => model.id === modelId && model.thinkingLevelMap?.[thinkingLevel] === modelId + "-" + thinkingLevel)) {
		throw new Error("Flash/high is missing from the AGY catalogue");
	}
	const base = process.env.RBF_AGY_TEST_ROOT ?? tmpdir();
	mkdirSync(base, { recursive: true });
	const root = mkdtempSync(join(base, "fake-host-"));
	const agent = join(root, "agent"), sessions = join(root, "sessions");
	for (const dir of [agent, sessions]) mkdirSync(dir);
	writeFileSync(join(root, "offline-profile"), "pi-21.7 fake-only\n");
	writeFileSync(join(agent, "settings.json"), JSON.stringify({
		defaultProvider: AGY_PROVIDER, defaultModel: modelId, defaultThinkingLevel: thinkingLevel, checkForUpdates: false,
	}));
	// Seed only a fresh profile. Pi's offline refresh reads this store, not models.json.
	writeFileSync(join(agent, "models-store.json"), JSON.stringify({
		[AGY_PROVIDER]: { models, checkedAt: Date.now() },
	}), { flag: "wx", mode: 0o600 });
	return { root, agent, sessions };
}

export function createAgyStreamProfile() {
	return provision(parseAgyCatalogue([
		"gemini-3.8-flash-low\tFlash (low)",
		"gemini-3.8-flash-medium\tFlash (medium)",
		"gemini-3.8-flash-high\tFlash (high)",
	].join("\n")));
}
