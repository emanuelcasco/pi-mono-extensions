import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { renderTeamMateWidget } from "../ui/widget.ts";

describe("renderTeamMateWidget", () => {
	test("renders running rows + queued", () => {
		const now = Date.now();
		const lines = renderTeamMateWidget(
			[
				{
					record: {
						id: "a",
						name: "worker",
						isolation: "none",
						cwd: "/tmp",
						status: "running",
						background: false,
						createdAt: new Date(now).toISOString(),
						updatedAt: new Date(now).toISOString(),
					},
					metrics: {
						turns: 1,
						toolUses: 2,
						tokens: 1234,
						startedAt: now - 1200,
						activityHint: "editing files…",
					},
					transcriptPath: "/tmp/s.jsonl",
				},
			],
			[],
			2,
			now,
			0,
		);
		assert.equal(lines[0], "● Agents");
		assert.match(lines.join("\n"), /worker/);
		assert.match(lines.join("\n"), /2 queued/);
	});
});
