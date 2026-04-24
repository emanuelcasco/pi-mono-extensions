/**
 * Pi Team-Mode — Store Tests
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
	TeamMateStore,
	generateTeamId,
	generateTeammateId,
} from "../core/store.ts";
import type { TeamRecord, TeammateRecord } from "../core/types.ts";

async function setup(): Promise<{ store: TeamMateStore; dir: string }> {
	const dir = await mkdtemp(join(tmpdir(), "pi-team-mode-"));
	return { store: new TeamMateStore(dir), dir };
}

function makeTeammate(overrides: Partial<TeammateRecord> = {}): TeammateRecord {
	const now = new Date().toISOString();
	return {
		id: "agent-researcher-abc12345",
		name: "researcher",
		isolation: "none",
		cwd: "/tmp/fake",
		status: "running",
		background: false,
		createdAt: now,
		updatedAt: now,
		...overrides,
	};
}

function makeTeam(overrides: Partial<TeamRecord> = {}): TeamRecord {
	return {
		id: "billing-abc12345",
		name: "billing",
		createdAt: new Date().toISOString(),
		defaultIsolation: "none",
		...overrides,
	};
}

describe("generateTeammateId", () => {
	test("slugifies name under agent- prefix (Claude Code parity)", () => {
		const id = generateTeammateId("Some Teammate!");
		assert.match(id, /^agent-some-teammate-[0-9a-f]{8}$/);
	});

	test("falls back to agent-teammate when name is empty", () => {
		const id = generateTeammateId("");
		assert.match(id, /^agent-teammate-[0-9a-f]{8}$/);
	});

	test("falls back to agent-teammate when name is undefined", () => {
		const id = generateTeammateId(undefined);
		assert.match(id, /^agent-teammate-[0-9a-f]{8}$/);
	});
});

describe("generateTeamId", () => {
	test("slugifies and appends random suffix", () => {
		const id = generateTeamId("Billing Team");
		assert.match(id, /^billing-team-[0-9a-f]{8}$/);
	});
});

describe("TeamMateStore.saveTeammate / loadTeammate", () => {
	test("round-trips a teammate record", async () => {
		const { store, dir } = await setup();
		try {
			const record = makeTeammate();
			await store.saveTeammate(record);
			const loaded = await store.loadTeammate(record.id);
			assert.deepEqual(loaded, record);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("loadTeammate returns null for missing id", async () => {
		const { store, dir } = await setup();
		try {
			assert.equal(await store.loadTeammate("does-not-exist"), null);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("TeamMateStore.listTeammates", () => {
	test("lists all saved teammates", async () => {
		const { store, dir } = await setup();
		try {
			await store.saveTeammate(makeTeammate({ id: "agent-a-abc", name: "a" }));
			await store.saveTeammate(makeTeammate({ id: "agent-b-abc", name: "b" }));
			const list = await store.listTeammates();
			const names = list.map((t) => t.name).sort();
			assert.deepEqual(names, ["a", "b"]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("returns empty array when none exist", async () => {
		const { store, dir } = await setup();
		try {
			assert.deepEqual(await store.listTeammates(), []);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("TeamMateStore team records", () => {
	test("round-trips a team record", async () => {
		const { store, dir } = await setup();
		try {
			const team = makeTeam();
			await store.saveTeam(team);
			const loaded = await store.loadTeam(team.id);
			assert.deepEqual(loaded, team);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("TeamMateStore name index", () => {
	test("round-trips the name index", async () => {
		const { store, dir } = await setup();
		try {
			await store.setNameIndex("session-1", { researcher: "researcher-abc" });
			const loaded = await store.getNameIndex("session-1");
			assert.deepEqual(loaded, { researcher: "researcher-abc" });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("returns empty object when index is missing", async () => {
		const { store, dir } = await setup();
		try {
			assert.deepEqual(await store.getNameIndex("never-created"), {});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("clearNameIndex removes the index", async () => {
		const { store, dir } = await setup();
		try {
			await store.setNameIndex("s", { a: "x" });
			await store.clearNameIndex("s");
			assert.deepEqual(await store.getNameIndex("s"), {});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
