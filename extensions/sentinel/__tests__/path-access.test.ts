import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { configLoader } from "../config.ts";
import {
	checkPathAccess,
	directoryGrantFor,
	isInsideCwd,
	isPathAllowed,
	pathAccessGrantForChoice,
	toStoragePath,
} from "../path-access.ts";

const CWD = "/tmp/sentinel-project";

describe("path-access helpers", () => {
	test("allows paths inside cwd", () => {
		assert.equal(isInsideCwd("/tmp/sentinel-project/src/index.ts", CWD), true);
		assert.equal(checkPathAccess("/tmp/sentinel-project/src/index.ts", CWD, []).allowed, true);
	});

	test("detects paths outside cwd", () => {
		const result = checkPathAccess("/tmp/other/file.txt", CWD, []);
		assert.equal(result.allowed, false);
	});

	test("allows exact file grants", () => {
		assert.equal(isPathAllowed("/tmp/other/file.txt", ["/tmp/other/file.txt"], CWD), true);
		assert.equal(isPathAllowed("/tmp/other/else.txt", ["/tmp/other/file.txt"], CWD), false);
	});

	test("allows directory grants with trailing slash", () => {
		assert.equal(isPathAllowed("/tmp/other/file.txt", ["/tmp/other/"], CWD), true);
		assert.equal(isPathAllowed("/tmp/other/nested/file.txt", ["/tmp/other/"], CWD), true);
		assert.equal(isPathAllowed("/tmp/otherness/file.txt", ["/tmp/other/"], CWD), false);
	});

	test("formats storage paths", () => {
		assert.equal(toStoragePath("/tmp/other", true), "/tmp/other/");
		assert.equal(directoryGrantFor("/tmp/other/file.txt"), "/tmp/other/");
	});

	test("derives and persists selected path-access grants with the correct scope and target", () => {
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		const agentDir = mkdtempSync(join(tmpdir(), "sentinel-path-access-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "sentinel-path-access-cwd-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			configLoader.load(cwd);
			configLoader.save("memory", { features: { pathAccess: true }, pathAccess: { mode: "ask", allowedPaths: [] } });

			const sessionDirectoryGrant = pathAccessGrantForChoice("allow_directory_session", "/tmp/outside-dir/file.txt", cwd);
			assert.deepEqual(sessionDirectoryGrant, {
				grant: "/tmp/outside-dir/",
				broadCheckPath: "/tmp/outside-dir",
				scope: "memory",
				directory: true,
			});
			configLoader.addAllowedPath(sessionDirectoryGrant.scope, sessionDirectoryGrant.grant);
			assert.ok(configLoader.getConfig().pathAccess.allowedPaths.includes("/tmp/outside-dir/"));

			const localFileGrant = pathAccessGrantForChoice("allow_file_always", "/tmp/outside-file.txt", cwd);
			assert.deepEqual(localFileGrant, {
				grant: "/tmp/outside-file.txt",
				broadCheckPath: "/tmp/outside-file.txt",
				scope: "local",
				directory: false,
			});
			configLoader.addAllowedPath(localFileGrant.scope, localFileGrant.grant);
			assert.ok(configLoader.getRawConfig("local")?.pathAccess?.allowedPaths?.includes("/tmp/outside-file.txt"));
		} finally {
			if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
