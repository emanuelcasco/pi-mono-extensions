/**
 * Pi Team-Mode — Formatter Tests (pure functions, no I/O)
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
	formatTeamDashboard,
	formatTeammateLine,
	formatTeammateList,
	formatTeammateStatus,
} from "../ui/formatters.ts";
import type { TeamRecord, TeammateRecord } from "../core/types.ts";

function tm(overrides: Partial<TeammateRecord> = {}): TeammateRecord {
	return {
		id: "researcher-abc",
		name: "researcher",
		isolation: "none",
		cwd: "/tmp",
		status: "running",
		background: false,
		createdAt: "2026-04-23T00:00:00Z",
		updatedAt: "2026-04-23T00:00:00Z",
		...overrides,
	};
}

function tm2(): TeamRecord {
	return {
		id: "billing-abc",
		name: "billing",
		createdAt: "2026-04-23T00:00:00Z",
		defaultIsolation: "worktree",
	};
}

describe("formatTeammateLine", () => {
	test("includes name, status icon, role, team, isolation", () => {
		const line = formatTeammateLine(
			tm({ subagentType: "researcher", teamId: "billing-abc", isolation: "worktree" }),
		);
		assert.match(line, /researcher/);
		assert.match(line, /\[researcher\]/);
		assert.match(line, /team=billing-abc/);
		assert.match(line, /wt/);
	});

	test("running shows ▸ icon", () => {
		assert.match(formatTeammateLine(tm({ status: "running" })), /▸/);
	});

	test("completed shows ✓ icon", () => {
		assert.match(formatTeammateLine(tm({ status: "completed" })), /✓/);
	});

	test("failed shows ✗ icon", () => {
		assert.match(formatTeammateLine(tm({ status: "failed" })), /✗/);
	});
});

describe("formatTeammateList", () => {
	test("empty list shows placeholder", () => {
		assert.equal(formatTeammateList([]), "No teammates.");
	});

	test("renders each teammate on its own line", () => {
		const out = formatTeammateList([tm({ name: "a" }), tm({ name: "b" })]);
		assert.equal(out.split("\n").length, 2);
	});
});

describe("formatTeamDashboard", () => {
	test("groups teammates under their team", () => {
		const out = formatTeamDashboard(
			[tm2()],
			[tm({ teamId: "billing-abc", name: "writer" })],
		);
		assert.match(out, /Teams:/);
		assert.match(out, /billing/);
		assert.match(out, /writer/);
	});

	test("shows unassigned teammates separately", () => {
		const out = formatTeamDashboard([], [tm({ name: "orphan" })]);
		assert.match(out, /Unassigned teammates:/);
		assert.match(out, /orphan/);
	});

	test("empty state", () => {
		assert.match(formatTeamDashboard([], []), /No teams and no teammates\./);
	});
});

describe("formatTeammateStatus", () => {
	test("prints multi-line status block", () => {
		const out = formatTeammateStatus(tm({ lastExitCode: 0, lastResult: "done" }));
		assert.match(out, /Teammate: researcher/);
		assert.match(out, /Status: running/);
		assert.match(out, /Last exit: 0/);
		assert.match(out, /Last result:\ndone/);
	});
});
