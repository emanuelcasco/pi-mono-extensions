import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { renderTaskNotification } from "../ui/notification-box.ts";

describe("renderTaskNotification", () => {
	const theme = {
		fg: (_c: string, text: string) => text,
		bg: (_c: string, text: string) => text,
		bold: (text: string) => text,
	} as never;

	test("returns undefined when details are missing", () => {
		const out = renderTaskNotification({ content: "x" }, { expanded: false }, theme);
		assert.equal(out, undefined);
	});

	test("returns a component when details exist", () => {
		const out = renderTaskNotification(
			{
				content: "Result text",
				details: {
					taskId: "agent-1",
					status: "completed",
					durationMs: 1500,
					summary: "done",
				},
			},
			{ expanded: false },
			theme,
		);
		assert.ok(out);
	});
});
