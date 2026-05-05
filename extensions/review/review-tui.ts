import { BorderedLoader, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import {
	buildReviewSession,
	cloneSession,
	getLatestReviewSession,
	persistReviewSession,
	submitReviewComments,
	type ReviewAction,
	type ReviewComment,
	type ReviewResult,
	type ReviewSession,
} from "./common.js";
import { ReviewerComponent } from "./reviewer.js";

export function registerReviewTuiCommand(pi: ExtensionAPI): void {
	let latestSession: ReviewSession | null = null;

	function reconstructState(ctx: ExtensionContext) {
		latestSession = getLatestReviewSession(ctx);
	}

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

	pi.registerMessageRenderer("review-submit", (message, _options, theme) => {
		return new Text(theme.fg("success", theme.bold("submitted ")) + message.content, 0, 0);
	});

	async function runReviewPane(ctx: ExtensionContext, session: ReviewSession): Promise<ReviewResult> {
		const reviewSession = cloneSession(session);
		let currentIndex = 0;

		// eslint-disable-next-line no-constant-condition
		while (true) {
			const action = await ctx.ui.custom<ReviewAction>(
				(tui, theme, _kb, done) => {
					const reviewer = new ReviewerComponent(reviewSession.comments, currentIndex, theme, done);
					return {
						render: (w: number) => reviewer.render(w),
						invalidate: () => reviewer.invalidate(),
						handleInput: (data: string) => {
							reviewer.handleInput(data);
							tui.requestRender();
						},
					};
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "right-center",
						width: "58%",
						minWidth: 72,
						maxHeight: "92%",
						margin: 1,
					},
				},
			);

			if (action.type === "cancel") {
				return { session: reviewSession, approved: 0, dismissed: 0, edited: 0, cancelled: true };
			}

			if (action.type === "edit") {
				currentIndex = action.index;
				const comment = reviewSession.comments[action.index];
				if (comment) {
					const newBody = await ctx.ui.editor("Edit review comment:", comment.body);
					if (newBody !== undefined && newBody.trim()) {
						if (!comment.originalBody) comment.originalBody = comment.body;
						comment.body = newBody.trim();
						comment.status = "edited";
					}
				}
				continue;
			}

			const selectedComments = reviewSession.comments.filter((c) => c.status === "approved" || c.status === "edited");
			if (selectedComments.length === 0) {
				ctx.ui.notify("No comments selected for submission", "warning");
				continue;
			}

			const submission = await ctx.ui.custom<{ submitted: number; failed: string[] } | null>((tui, theme, _kb, done) => {
				const loader = new BorderedLoader(
					tui,
					theme,
					`Submitting ${selectedComments.length} comment(s) to ${reviewSession.target.platform}...`,
				);
				loader.onAbort = () => done(null);
				void (async () => {
					try {
						done(await submitReviewComments(pi.exec.bind(pi), reviewSession.target, selectedComments, loader.signal));
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
						done(null);
					}
				})();
				return loader;
			});

			if (!submission) continue;

			reviewSession.submittedAt = Date.now();
			latestSession = reviewSession;
			persistReviewSession(pi, reviewSession);
			return {
				session: reviewSession,
				approved: reviewSession.comments.filter((c) => c.status === "approved").length,
				dismissed: reviewSession.comments.filter((c) => c.status === "dismissed").length,
				edited: reviewSession.comments.filter((c) => c.status === "edited").length,
				cancelled: false,
				submitted: submission.submitted,
				failed: submission.failed,
			};
		}
	}

	pi.registerCommand("review-tui", {
		description: "Open the latest saved review in a side pane and submit selected comments",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/review-tui requires interactive mode", "error");
				return;
			}

			latestSession = getLatestReviewSession(ctx);
			const url = args?.trim();

			if (!latestSession && !url) {
				ctx.ui.notify("No saved review found. Run /review <url> first, or use /review-tui <url>.", "info");
				return;
			}

			if (url) {
				if (!ctx.model) {
					ctx.ui.notify("No model selected", "error");
					return;
				}
				const generated = await ctx.ui.custom<ReviewSession | null>((tui, theme, _kb, done) => {
					const loader = new BorderedLoader(tui, theme, `Reviewing ${url}...`);
					loader.onAbort = () => done(null);
					void (async () => {
						try {
							done(await buildReviewSession(pi.exec.bind(pi), ctx.model!, ctx.modelRegistry, url, loader.signal));
						} catch (error) {
							ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
							done(null);
						}
					})();
					return loader;
				});
				if (!generated) return;
				latestSession = generated;
				persistReviewSession(pi, generated);
			}

			const session = latestSession!;
			const cloned = cloneSession(session);
			const prepared: ReviewSession = {
				...cloned,
				comments: cloned.comments.map((comment: ReviewComment) => ({
					...comment,
					status:
						comment.status === "approved" || comment.status === "edited" || comment.status === "dismissed"
							? comment.status
							: "pending",
				})),
			};

			const result = await runReviewPane(ctx, prepared);
			if (result.cancelled) {
				ctx.ui.notify("Review submission cancelled", "info");
				return;
			}

			const failureSuffix = result.failed && result.failed.length > 0 ? ` (${result.failed.length} failed)` : "";
			pi.sendMessage({
				customType: "review-submit",
				content:
					`${result.submitted || 0} comment(s) submitted to ${result.session.target.platform}: ${result.session.target.url}` +
					failureSuffix,
				display: true,
				details: result,
			});

			if (result.failed && result.failed.length > 0) {
				ctx.ui.notify(`Submitted ${result.submitted || 0}, failed ${result.failed.length}`, "warning");
			} else {
				ctx.ui.notify(`Submitted ${result.submitted || 0} comment(s)`, "info");
			}
		},
	});
}
