import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { findCodeConnectMapping } from "../src/code-connect.js";

test("findCodeConnectMapping discovers figma.connect, URLs, and node IDs", async () => {
	const root = await mkdtemp(join(tmpdir(), "figma-code-connect-"));
	await writeFile(join(root, "Button.figma.tsx"), "figma.connect(Button, 'https://www.figma.com/design/FILE123/Name?node-id=1-2')\n");
	await writeFile(join(root, "README.md"), "component key COMPONENT123\n");
	const result = await findCodeConnectMapping({ cwd: root, fileKey: "FILE123", nodeId: "1:2", componentKey: "COMPONENT123" });
	assert.ok(result.matches.some((match) => match.kind === "figma-connect"));
	assert.ok(result.matches.some((match) => match.kind === "figma-file-reference"));
	assert.ok(result.matches.some((match) => match.kind === "component-key-reference"));
});

test("findCodeConnectMapping ignores node_modules and enforces caps", async () => {
	const root = await mkdtemp(join(tmpdir(), "figma-code-connect-"));
	await mkdir(join(root, "node_modules"));
	await writeFile(join(root, "node_modules", "Ignored.ts"), "figma.connect(Ignored)\n");
	await writeFile(join(root, "One.ts"), "figma.connect(One)\nfigma.connect(Two)\n");
	const result = await findCodeConnectMapping({ cwd: root, fileKey: "FILE123", maxMatches: 1 });
	assert.equal(result.matches.length, 1);
	assert.equal(result.matches[0]?.path, "One.ts");
	assert.equal(result.metadata.truncated, true);
});

test("findCodeConnectMapping rejects rootDir outside cwd", async () => {
	const root = await mkdtemp(join(tmpdir(), "figma-code-connect-"));
	await assert.rejects(() => findCodeConnectMapping({ cwd: root, rootDir: "/", fileKey: "FILE123" }), /rootDir/);
});
