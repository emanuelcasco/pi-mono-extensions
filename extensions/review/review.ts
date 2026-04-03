import { BorderedLoader, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import {
	buildReviewSession,
	persistReviewSession,
	renderSummary,
	type ReviewSession,
} from "./common.js";

export function registerReviewCommand(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("review-summary", (message, _options, theme) => {
		return new Text(theme.fg("accent", theme.bold("review ")) + message.content, 0, 0);
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
