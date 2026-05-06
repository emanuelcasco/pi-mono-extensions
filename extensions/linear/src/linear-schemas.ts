import { Type } from "@sinclair/typebox";

export const MaxResponseCharsSchema = Type.Optional(
	Type.Number({ description: "Maximum characters returned to the model before truncation", minimum: 1 }),
);

export const LimitSchema = Type.Optional(Type.Number({ description: "Maximum number of records to fetch", minimum: 1, maximum: 250 }));
export const TeamIdSchema = Type.String({ description: "Linear team UUID or key where accepted by Linear" });
export const IssueIdSchema = Type.String({ description: "Linear issue UUID or identifier such as ENG-123" });
export const UserIdSchema = Type.String({ description: "Linear user UUID" });
export const ProjectIdSchema = Type.String({ description: "Linear project UUID" });

export const EmptyParams = Type.Object({ maxResponseChars: MaxResponseCharsSchema });
export const OptionalTeamParams = Type.Object({ teamId: Type.Optional(TeamIdSchema), maxResponseChars: MaxResponseCharsSchema });
export const IdParams = Type.Object({ id: Type.String({ description: "Linear object ID" }), maxResponseChars: MaxResponseCharsSchema });

export const LinearGetTeamParams = Type.Object({ teamId: TeamIdSchema, maxResponseChars: MaxResponseCharsSchema });
export const LinearGetIssueParams = Type.Object({ issueId: IssueIdSchema, maxResponseChars: MaxResponseCharsSchema });
export const LinearGetProjectParams = Type.Object({ projectId: ProjectIdSchema, maxResponseChars: MaxResponseCharsSchema });
export const LinearGetUserParams = Type.Object({ userId: UserIdSchema, maxResponseChars: MaxResponseCharsSchema });
export const LinearGetDocumentParams = Type.Object({ documentId: Type.String({ description: "Linear document UUID" }), maxResponseChars: MaxResponseCharsSchema });
export const LinearGetStatusParams = Type.Object({ stateId: Type.String({ description: "Linear workflow state UUID" }), maxResponseChars: MaxResponseCharsSchema });

export const LinearListIssuesParams = Type.Object({
	teamId: Type.Optional(TeamIdSchema),
	assigneeId: Type.Optional(UserIdSchema),
	statusName: Type.Optional(Type.String({ description: "Workflow status name, case-insensitive" })),
	limit: LimitSchema,
	maxResponseChars: MaxResponseCharsSchema,
});

export const LinearSearchIssuesParams = Type.Object({
	query: Type.String({ description: "Search term" }),
	limit: LimitSchema,
	maxResponseChars: MaxResponseCharsSchema,
});

export const LinearListMyIssuesParams = Type.Object({ limit: LimitSchema, maxResponseChars: MaxResponseCharsSchema });

export const LinearCreateIssueParams = Type.Object({
	teamId: TeamIdSchema,
	title: Type.String({ description: "Issue title" }),
	description: Type.Optional(Type.String({ description: "Issue description in Markdown" })),
	priority: Type.Optional(Type.Number({ description: "0 No priority, 1 Urgent, 2 High, 3 Medium, 4 Low", minimum: 0, maximum: 4 })),
	assigneeId: Type.Optional(UserIdSchema),
	labelIds: Type.Optional(Type.Array(Type.String({ description: "Linear label UUID" }))),
	projectId: Type.Optional(ProjectIdSchema),
	stateId: Type.Optional(Type.String({ description: "Workflow state UUID" })),
	maxResponseChars: MaxResponseCharsSchema,
});

export const LinearUpdateIssueParams = Type.Object({
	issueId: IssueIdSchema,
	title: Type.Optional(Type.String()),
	description: Type.Optional(Type.String({ description: "Issue description in Markdown" })),
	priority: Type.Optional(Type.Number({ description: "0 No priority, 1 Urgent, 2 High, 3 Medium, 4 Low", minimum: 0, maximum: 4 })),
	stateId: Type.Optional(Type.String({ description: "Workflow state UUID" })),
	assigneeId: Type.Optional(UserIdSchema),
	maxResponseChars: MaxResponseCharsSchema,
});

export const LinearCommentsParams = Type.Object({ issueId: IssueIdSchema, maxResponseChars: MaxResponseCharsSchema });
export const LinearCreateCommentParams = Type.Object({
	issueId: IssueIdSchema,
	body: Type.String({ description: "Comment body in Markdown" }),
	maxResponseChars: MaxResponseCharsSchema,
});

export const LinearDocumentsParams = Type.Object({ projectId: Type.Optional(ProjectIdSchema), maxResponseChars: MaxResponseCharsSchema });
