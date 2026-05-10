import { Type } from "@sinclair/typebox";

export const MaxResponseCharsSchema = Type.Optional(
	Type.Number({
		description: "Maximum characters returned to the model before truncation",
		minimum: 1,
	}),
);

export const WebSearchParams = Type.Object({
	query: Type.String({ description: "Search query string" }),
	maxResults: Type.Optional(
		Type.Number({
			description: "Maximum number of results to return (default 5, max 10)",
			minimum: 1,
			maximum: 10,
			default: 5,
		}),
	),
	maxResponseChars: MaxResponseCharsSchema,
});

export const WebReadParams = Type.Object({
	url: Type.String({ description: "URL of the web page to fetch and read" }),
	maxChars: Type.Optional(
		Type.Number({
			description: "Maximum characters to return (default 8000)",
			minimum: 100,
			maximum: 50_000,
			default: 8000,
		}),
	),
	maxResponseChars: MaxResponseCharsSchema,
});
