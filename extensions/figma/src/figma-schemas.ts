import { Type } from "@sinclair/typebox";

export const MaxResponseCharsSchema = Type.Optional(
	Type.Number({ description: "Maximum characters returned to the model before truncation", minimum: 1 }),
);

export const FileKeySchema = Type.String({ description: "Figma file key from a Figma URL" });
export const NodeIdSchema = Type.String({ description: "Figma node ID, either 1:2 API format or 1-2 URL format" });
export const NodeIdsSchema = Type.Array(NodeIdSchema, {
	description: "One or more Figma node IDs. Batch related nodes in one call.",
	minItems: 1,
});

export const FigmaGetFileParams = Type.Object({
	fileKey: FileKeySchema,
	depth: Type.Optional(Type.Number({ description: "Optional Figma file depth query parameter", minimum: 1 })),
	maxResponseChars: MaxResponseCharsSchema,
});

export const FigmaGetDesignContextParams = Type.Object({
	fileKey: FileKeySchema,
	nodeId: Type.Optional(NodeIdSchema),
	maxResponseChars: MaxResponseCharsSchema,
});

export const FigmaGetNodesParams = Type.Object({
	fileKey: FileKeySchema,
	nodeIds: NodeIdsSchema,
	maxResponseChars: MaxResponseCharsSchema,
});

const FigmaNodeProcessingOptions = {
	depth: Type.Optional(Type.Number({ description: "How many levels of node hierarchy to include. Defaults to 2 and is capped at 4.", minimum: 1, maximum: 4 })),
	includeHidden: Type.Optional(Type.Boolean({ description: "Include nodes where visible=false. Defaults to false." })),
	includeVectors: Type.Optional(Type.Boolean({ description: "Include vector/icon internals. Defaults to false." })),
	includeComponentInternals: Type.Optional(Type.Boolean({ description: "Expand component instance internals. Defaults to false." })),
};

const FigmaOptionalRenderOptions = {
	renderImage: Type.Optional(Type.Boolean({ description: "Render the node and include image URL/local path in the response. Defaults to false." })),
	outputDir: Type.Optional(Type.String({ description: "Optional directory for downloaded rendered image files. Omit unless the user requested persistent files; by default downloads go to an OS temp directory." })),
	format: Type.Optional(Type.Unsafe<"png" | "jpg" | "svg" | "pdf">({ type: "string", enum: ["png", "jpg", "svg", "pdf"] })),
	scale: Type.Optional(Type.Number({ description: "Render scale for bitmap formats", minimum: 0.01, maximum: 4 })),
};

export const FigmaProcessedNodeParams = Type.Object({
	fileKey: FileKeySchema,
	nodeId: NodeIdSchema,
	...FigmaNodeProcessingOptions,
	maxResponseChars: MaxResponseCharsSchema,
});

export const FigmaProcessedNodeWithRenderParams = Type.Object({
	fileKey: FileKeySchema,
	nodeId: NodeIdSchema,
	...FigmaNodeProcessingOptions,
	...FigmaOptionalRenderOptions,
	maxResponseChars: MaxResponseCharsSchema,
});

export const FigmaImplementationContextParams = Type.Object({
	fileKey: FileKeySchema,
	nodeId: NodeIdSchema,
	...FigmaNodeProcessingOptions,
	...FigmaOptionalRenderOptions,
	framework: Type.Optional(Type.Unsafe<"react" | "html" | "vue" | "angular" | "react-native">({ type: "string", enum: ["react", "html", "vue", "angular", "react-native"] })),
	styling: Type.Optional(Type.Unsafe<"css" | "css-modules" | "styled-components" | "tailwind" | "inline">({ type: "string", enum: ["css", "css-modules", "styled-components", "tailwind", "inline"] })),
	resolveTokens: Type.Optional(Type.Boolean({ description: "Resolve style and variable IDs into token names when possible. Defaults to true." })),
	includeCodeSnippets: Type.Optional(Type.Boolean({ description: "Include compact starter snippets for the selected framework/styling target. Defaults to false." })),
	maxResponseChars: MaxResponseCharsSchema,
});

export const FigmaSingleFileParams = Type.Object({
	fileKey: FileKeySchema,
	maxResponseChars: MaxResponseCharsSchema,
});

export const FigmaSearchComponentsParams = Type.Object({
	fileKey: FileKeySchema,
	query: Type.String({ description: "Case-insensitive component name/description search term" }),
	maxResponseChars: MaxResponseCharsSchema,
});

export const FigmaFindNodesParams = Type.Object({
	fileKey: FileKeySchema,
	query: Type.String({ description: "Layer name or visible text query" }),
	nodeId: Type.Optional(NodeIdSchema),
	...FigmaNodeProcessingOptions,
	exact: Type.Optional(Type.Boolean({ description: "Require an exact match instead of substring matching. Defaults to false." })),
	caseSensitive: Type.Optional(Type.Boolean({ description: "Use case-sensitive matching. Defaults to false." })),
	maxResults: Type.Optional(Type.Number({ description: "Maximum matches to return. Defaults to 50 and is capped at 200.", minimum: 1, maximum: 200 })),
	maxResponseChars: MaxResponseCharsSchema,
});

export const FigmaRenderNodesParams = Type.Object({
	fileKey: FileKeySchema,
	nodeIds: NodeIdsSchema,
	outputDir: Type.Optional(Type.String({ description: "Optional directory for downloaded image files. Omit unless the user requested persistent files; if omitted, an OS temp directory is created." })),
	format: Type.Optional(Type.Unsafe<"png" | "jpg" | "svg" | "pdf">({ type: "string", enum: ["png", "jpg", "svg", "pdf"] })),
	scale: Type.Optional(Type.Number({ description: "Render scale for bitmap formats", minimum: 0.01, maximum: 4 })),
	download: Type.Optional(Type.Boolean({ description: "Download rendered assets locally. Defaults to true." })),
	maxResponseChars: MaxResponseCharsSchema,
});

export const FigmaExtractAssetsParams = Type.Object({
	fileKey: FileKeySchema,
	nodeId: NodeIdSchema,
	depth: Type.Optional(Type.Number({ description: "How many levels of node hierarchy to inspect for assets. Defaults to 3 and is capped at 4.", minimum: 1, maximum: 4 })),
	assetTypes: Type.Optional(Type.Array(Type.Unsafe<"svgIcons" | "nodeRenders" | "imageFills">({ type: "string", enum: ["svgIcons", "nodeRenders", "imageFills"] }), { description: "Asset categories to extract. Defaults to all supported categories." })),
	outputDir: Type.Optional(Type.String({ description: "Optional directory for downloaded asset files. Omit unless the user requested persistent files; by default files go to an OS temp directory." })),
	includeHidden: Type.Optional(Type.Boolean({ description: "Include hidden nodes while discovering assets. Defaults to false." })),
	maxAssets: Type.Optional(Type.Number({ description: "Maximum assets to include in the manifest. Defaults to 80.", minimum: 1, maximum: 500 })),
	maxResponseChars: MaxResponseCharsSchema,
});

export const FigmaFindCodeConnectMappingParams = Type.Object({
	fileKey: FileKeySchema,
	nodeId: Type.Optional(NodeIdSchema),
	componentKey: Type.Optional(Type.String({ description: "Optional Figma component key to search for locally." })),
	rootDir: Type.Optional(Type.String({ description: "Optional directory under the current repo to scan. Defaults to cwd." })),
	maxMatches: Type.Optional(Type.Number({ description: "Maximum local mapping matches to return. Defaults to 40.", minimum: 1, maximum: 200 })),
	maxResponseChars: MaxResponseCharsSchema,
});

export const FigmaComponentImplementationHintsParams = Type.Object({
	fileKey: FileKeySchema,
	nodeId: NodeIdSchema,
	...FigmaNodeProcessingOptions,
	framework: Type.Optional(Type.Unsafe<"react" | "html" | "vue" | "angular" | "react-native">({ type: "string", enum: ["react", "html", "vue", "angular", "react-native"] })),
	styling: Type.Optional(Type.Unsafe<"css" | "css-modules" | "styled-components" | "tailwind" | "inline">({ type: "string", enum: ["css", "css-modules", "styled-components", "tailwind", "inline"] })),
	includeCodeConnect: Type.Optional(Type.Boolean({ description: "Scan the local repo for Figma Code Connect mappings. Defaults to true." })),
	includeSnippet: Type.Optional(Type.Boolean({ description: "Include starter framework snippet. Defaults to false." })),
	rootDir: Type.Optional(Type.String({ description: "Optional local repo subdirectory for Code Connect scanning." })),
	maxResponseChars: MaxResponseCharsSchema,
});

export const FigmaParseUrlParams = Type.Object({
	url: Type.String({ description: "Figma design/file URL" }),
});
