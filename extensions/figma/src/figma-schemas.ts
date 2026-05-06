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
	outputDir: Type.Optional(Type.String({ description: "Optional directory for downloaded rendered image files, relative to cwd unless absolute." })),
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

export const FigmaSingleFileParams = Type.Object({
	fileKey: FileKeySchema,
	maxResponseChars: MaxResponseCharsSchema,
});

export const FigmaSearchComponentsParams = Type.Object({
	fileKey: FileKeySchema,
	query: Type.String({ description: "Case-insensitive component name/description search term" }),
	maxResponseChars: MaxResponseCharsSchema,
});

export const FigmaRenderNodesParams = Type.Object({
	fileKey: FileKeySchema,
	nodeIds: NodeIdsSchema,
	outputDir: Type.Optional(Type.String({ description: "Optional directory for downloaded image files, relative to cwd unless absolute. If omitted, a temp directory is created." })),
	format: Type.Optional(Type.Unsafe<"png" | "jpg" | "svg" | "pdf">({ type: "string", enum: ["png", "jpg", "svg", "pdf"] })),
	scale: Type.Optional(Type.Number({ description: "Render scale for bitmap formats", minimum: 0.01, maximum: 4 })),
	download: Type.Optional(Type.Boolean({ description: "Download rendered assets locally. Defaults to true." })),
	maxResponseChars: MaxResponseCharsSchema,
});

export const FigmaParseUrlParams = Type.Object({
	url: Type.String({ description: "Figma design/file URL" }),
});
