import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { PiStreamParser } from "../runtime/pi-stream-parser.ts";

describe("PiStreamParser", () => {
	test("handles split JSON chunks", () => {
		const parser = new PiStreamParser();
		const first = parser.push('{"type":"message_update","assistantMessageEvent":{"type":"text_delta","text":"Hel');
		assert.equal(first.length, 0);
		const second = parser.push('lo"}}\n');
		assert.deepEqual(second, [{ type: "assistant_delta", text: "Hello" }]);
	});

	test("ignores non-json lines", () => {
		const parser = new PiStreamParser();
		const events = parser.push("plain text\n{\"type\":\"turn_end\"}\n");
		assert.deepEqual(events, [{ type: "turn_end" }]);
	});

	test("maps assistant message usage + tool events", () => {
		const parser = new PiStreamParser();
		const input = [
			JSON.stringify({ type: "tool_execution_start", toolName: "Read", args: { path: "a.ts" } }),
			JSON.stringify({ type: "tool_execution_end", toolName: "Read", result: "ok" }),
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Done" }],
					usage: { totalTokens: 42 },
				},
			}),
		].join("\n");
		const events = parser.push(`${input}\n`);
		assert.equal(events[0]?.type, "tool_start");
		assert.equal(events[1]?.type, "tool_end");
		assert.equal(events[2]?.type, "assistant_message");
		if (events[2]?.type !== "assistant_message") return;
		assert.equal(events[2].text, "Done");
		assert.equal(events[2].usage?.totalTokens, 42);
	});

	test("maps tool-only assistant messages so tool-use turns count", () => {
		const parser = new PiStreamParser();
		const events = parser.push(
			`${JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } }],
					usage: { input: 10, output: 2, cacheRead: 30, cacheWrite: 0 },
				},
			})}\n`,
		);
		assert.equal(events.length, 1);
		assert.equal(events[0]?.type, "assistant_message");
		if (events[0]?.type !== "assistant_message") return;
		assert.equal(events[0].text, "");
		assert.equal(events[0].usage?.inputTokens, 10);
		assert.equal(events[0].usage?.cacheReadTokens, 30);
		assert.equal(events[0].usage?.totalTokens, 42);
	});
});
