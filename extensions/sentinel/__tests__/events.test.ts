import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { emitBlocked, emitDangerous } from "../events.ts";

describe("sentinel events", () => {
	test("emits blocked and dangerous events", () => {
		const emitted: Array<{ name: string; payload: unknown }> = [];
		const pi = {
			events: {
				emit(name: string, payload: unknown) {
					emitted.push({ name, payload });
				},
			},
		};

		emitDangerous(pi as never, {
			feature: "permissionGate",
			toolName: "bash",
			input: { command: "sudo true" },
			description: "danger",
			labels: ["privilege-escalation"],
		});
		emitBlocked(pi as never, {
			feature: "permissionGate",
			toolName: "bash",
			input: { command: "sudo true" },
			reason: "blocked",
		});

		assert.equal(emitted[0].name, "sentinel:dangerous");
		assert.equal(emitted[1].name, "sentinel:blocked");
	});

	test("does not throw when event emitter is unavailable", () => {
		assert.doesNotThrow(() =>
			emitBlocked({} as never, {
				feature: "pathAccess",
				toolName: "read",
				input: {},
				reason: "blocked",
			}),
		);
	});
});
