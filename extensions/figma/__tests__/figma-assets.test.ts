import test from "node:test";
import assert from "node:assert/strict";
import { collectAssetCandidates, formatFromPath, safeFilename, sha256 } from "../src/figma-assets.js";

const assetTree = {
	id: "10:1",
	name: "Hero Card",
	type: "FRAME",
	absoluteBoundingBox: { width: 320, height: 200 },
	fills: [{ type: "IMAGE", imageRef: "abc123", scaleMode: "FILL" }],
	children: [
		{ id: "10:2", name: "Close icon", type: "VECTOR", absoluteBoundingBox: { width: 16, height: 16 } },
		{ id: "10:3", name: "Logo Mark", type: "FRAME", absoluteBoundingBox: { width: 32, height: 32 } },
		{ id: "10:4", name: "Hidden asset", type: "VECTOR", visible: false, absoluteBoundingBox: { width: 16, height: 16 } },
	],
};

test("collectAssetCandidates detects icons, node renders, image fills, and paths", () => {
	const result = collectAssetCandidates(assetTree, { assetTypes: ["svgIcons", "nodeRenders", "imageFills"] });
	assert.ok(result.assets.some((asset) => asset.kind === "svgIcon" && asset.nodePath === "Hero Card > Close icon"));
	assert.ok(result.assets.some((asset) => asset.kind === "nodeRender" && asset.nodePath === "Hero Card"));
	assert.ok(result.assets.some((asset) => asset.kind === "imageFill" && asset.imageRef === "abc123"));
	assert.equal(result.assets.some((asset) => asset.nodeName === "Hidden asset"), false);
});

test("collectAssetCandidates supports hidden nodes and caps results", () => {
	const result = collectAssetCandidates(assetTree, { includeHidden: true, maxAssets: 1 });
	assert.equal(result.assets.length, 1);
	assert.equal(result.metadata.truncated, true);
	assert.ok(result.metadata.truncatedReasons.some((reason) => reason.includes("maxAssets")));
});

test("asset helper utilities normalize names, hashes, and formats", () => {
	assert.equal(safeFilename("Close Icon / Primary"), "close-icon-primary");
	assert.equal(sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	assert.equal(formatFromPath("/tmp/icon.svg"), "svg");
	assert.equal(formatFromPath("/tmp/photo.jpeg"), "jpg");
});
