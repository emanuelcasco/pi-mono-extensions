import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerReviewCommand } from "./review.js";
import { registerReviewTuiCommand } from "./review-tui.js";

export default function reviewExtension(pi: ExtensionAPI): void {
	registerReviewCommand(pi);
	registerReviewTuiCommand(pi);
}
