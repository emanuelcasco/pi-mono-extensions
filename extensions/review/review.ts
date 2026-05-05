import { BorderedLoader, type ExtensionAPI, type Theme } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import {
	buildReviewSession,
	getCommentBody,
	getCommentConfidence,
	getCommentPriority,
	getCommentTitle,
	getPriorityInfo,
	persistReviewSession,
	renderSummary,
	type ReviewSession,
} from "./common.js";

function renderReviewSummaryMessage(session: ReviewSession | undefined, content: string, expanded: boolean, theme: Theme) {
	if (!session) return new Text(theme.fg("accent", theme.bold("review ")) + content, 0, 0);

	const container = new Container();
	const comments = session.comments || [];
	const counts = {
		P0: comments.filter((comment) => getCommentPriority(comment) === "P0").length,
		P1: comments.filter((comment) => getCommentPriority(comment) === "P1").length,
		P2: comments.filter((comment) => getCommentPriority(comment) === "P2").length,
		P3: comments.filter((comment) => getCommentPriority(comment) === "P3").length,
	};
	const countText = [`${comments.length} finding${comments.length === 1 ? "" : "s"}`]
		.concat((Object.entries(counts) as Array<[keyof typeof counts, number]>).filter(([, count]) => count > 0).map(([priority, count]) => `${count} ${priority}`))
		.join(", ");

	container.addChild(new Text(`${theme.fg("accent", theme.bold("review "))}${theme.fg("dim", session.target.url)} ${theme.fg("muted", countText)}`, 0, 0));
	if (session.summary) container.addChild(new Text(`  ${theme.fg("dim", session.summary)}`, 0, 0));

	const displayCount = expanded ? comments.length : Math.min(3, comments.length);
	for (let i = 0; i < displayCount; i++) {
		const comment = comments[i]!;
		const priority = getCommentPriority(comment);
		const meta = getPriorityInfo(priority);
		const end = comment.endLine && comment.endLine !== comment.line ? `-${comment.endLine}` : "";
		container.addChild(
			new Text(
				`  ${theme.fg(meta.color, `${meta.symbol} [${priority}]`)} ${getCommentTitle(comment)} ${theme.fg(
					"dim",
					`${comment.file}:${comment.line}${end} ${(getCommentConfidence(comment) * 100).toFixed(0)}%`,
				)}`,
				0,
				0,
			),
		);
		if (expanded) {
			const body = getCommentBody(comment);
			if (body) container.addChild(new Text(`    ${theme.fg("dim", body.split("\n")[0] || "")}`, 0, 0));
		}
	}
	if (comments.length > displayCount) {
		container.addChild(new Text(theme.fg("dim", `  … ${comments.length - displayCount} more findings`), 0, 0));
	}
	if (comments.length > 0) container.addChild(new Text(theme.fg("dim", "  Open /review-tui to inspect, edit, toggle, and submit."), 0, 0));
	return container;
}

export function registerReviewCommand(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<ReviewSession>("review-summary", (message, options, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		return renderReviewSummaryMessage(message.details, content, options.expanded, theme);
	});

	pi.registerCommand("review", {
		description: "Review a GitHub PR or GitLab MR URL and store comments for /review-tui",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/review requires interactive mode", "error");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			const url = args?.trim();
			if (!url) {
				ctx.ui.notify("Usage: /review <github-pr-url|gitlab-mr-url>", "warning");
				return;
			}

			const result = await ctx.ui.custom<ReviewSession | null>((tui, theme, _kb, done) => {
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

			if (!result) return;

			persistReviewSession(pi, result);
			pi.sendMessage({
				customType: "review-summary",
				content: renderSummary(result),
				display: true,
				details: result,
			});

			ctx.ui.notify(
				result.comments.length > 0
					? `Review ready: ${result.comments.length} comment(s). Open /review-tui.`
					: "Review complete: no actionable comments.",
				"info",
			);
		},
	});
}
