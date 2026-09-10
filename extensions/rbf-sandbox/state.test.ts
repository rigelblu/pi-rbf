import { describe, expect, test } from "vitest";
import { SandboxController, statusText } from "./state.js";

describe("SandboxController", () => {
	test("flagged launch blocks tools before session_start can activate", () => {
		const controller = new SandboxController(true);
		expect(controller.snapshot.state).toBe("starting");
		expect(controller.blocksHostAffectingTools()).toBe(true);
		expect(statusText(controller.snapshot)).toBe("sandbox: starting · tools blocked");
	});

	test("active re-entry blocks tools until activation succeeds again", () => {
		const controller = new SandboxController(true);
		controller.activate();
		expect(controller.blocksHostAffectingTools()).toBe(false);
		controller.beginReentry();
		expect(controller.blocksHostAffectingTools()).toBe(true);
	});

	test("failure is absorbing for activation", () => {
		const controller = new SandboxController(true);
		controller.fail("integrity lost");
		expect(controller.blocksHostAffectingTools()).toBe(true);
		expect(() => controller.activate()).toThrow();
		expect(statusText(controller.snapshot)).toBe("sandbox: failed · tools blocked");
	});

	test("unflagged launch stays off without blocking native tools", () => {
		const controller = new SandboxController(false);
		expect(controller.snapshot.state).toBe("off");
		expect(controller.blocksHostAffectingTools()).toBe(false);
	});
});
