/**
 * ReviewerComponent — Interactive TUI for reviewing code review comments
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { KeyId } from "@earendil-works/pi-tui";
import {
	getCommentBody,
	getCommentConfidence,
	getCommentPriority,
	getCommentTitle,
	getPriorityInfo,
	type CommentStatus,
	type ReviewAction,
	type ReviewComment,
} from "./common.js";

function priorityLabel(comment: ReviewComment): string {
	const priority = getCommentPriority(comment);
	return `${getPriorityInfo(priority).symbol}  ${priority} ${(getCommentConfidence(comment) * 100).toFixed(0)}% confidence`;
}

function statusIcon(status: CommentStatus): string {
	switch (status) {
		case "approved":
			return "✓";
		case "dismissed":
			return "✗";
		case "edited":
			return "✎";
		case "pending":
			return "○";
	}
}

function statusColor(status: CommentStatus): "success" | "error" | "accent" | "warning" {
	switch (status) {
		case "approved":
			return "success";
		case "dismissed":
			return "error";
		case "edited":
			return "accent";
		case "pending":
			return "warning";
	}
}

function expandTabs(text: string): string {
	return text.replace(/\t/g, "    ");
}

interface HunkWindow {
	header: string | null;
	lines: string[];
	hiddenBefore: number;
	hiddenAfter: number;
}

function sliceHunkAroundLines(hunk: string, targetStart: number, targetEnd: number, maxLines: number): HunkWindow {
	const all = hunk.split("\n");
	const headerMatch = all[0]?.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
	if (!headerMatch) {
		return { header: null, lines: all.slice(0, maxLines), hiddenBefore: 0, hiddenAfter: Math.max(0, all.length - maxLines) };
	}

	const header = all[0]!;
	const body = all.slice(1);
	let newLine = Number(headerMatch[1]);
	const lineNumbers: (number | null)[] = body.map((line) => {
		if (line.startsWith("+") || line.startsWith(" ")) return newLine++;
		return null;
	});

	let firstHit = -1;
	let lastHit = -1;
	for (let i = 0; i < body.length; i++) {
		const n = lineNumbers[i];
		if (n != null && n >= targetStart && n <= targetEnd) {
			if (firstHit === -1) firstHit = i;
			lastHit = i;
		}
	}

	const budget = Math.max(1, maxLines - 1);
	if (firstHit === -1) {
		const slice = body.slice(0, budget);
		return { header, lines: slice, hiddenBefore: 0, hiddenAfter: Math.max(0, body.length - slice.length) };
	}

	const span = lastHit - firstHit + 1;
	let start: number;
	let end: number;
	if (span >= budget) {
		start = firstHit;
		end = firstHit + budget;
	} else {
		const padding = budget - span;
		const before = Math.floor(padding / 2);
		start = Math.max(0, firstHit - before);
		end = Math.min(body.length, start + budget);
		start = Math.max(0, end - budget);
	}

	return {
		header,
		lines: body.slice(start, end),
		hiddenBefore: start,
		hiddenAfter: Math.max(0, body.length - end),
	};
}

export class ReviewerComponent {
	private comments: ReviewComment[];
	private currentIndex: number;
	private theme: Theme;
	private onDone: (action: ReviewAction) => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(comments: ReviewComment[], startIndex: number, theme: Theme, onDone: (action: ReviewAction) => void) {
		this.comments = comments;
		this.currentIndex = Math.max(0, Math.min(startIndex, comments.length - 1));
		this.theme = theme;
		this.onDone = onDone;
	}

	handleInput(data: string): void {
		if (this.comments.length === 0) {
			if (matchesKey(data, Key.escape) || data === "q") this.onDone({ type: "cancel" });
			return;
		}

		const comment = this.comments[this.currentIndex]!;
		if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("k"))) {
			if (this.currentIndex > 0) {
				this.currentIndex--;
				this.invalidate();
			}
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("j"))) {
			if (this.currentIndex < this.comments.length - 1) {
				this.currentIndex++;
				this.invalidate();
			}
			return;
		}
		if (data === "[") {
			for (let i = this.currentIndex - 1; i >= 0; i--) {
				if (this.comments[i]!.file !== comment.file) {
					this.currentIndex = i;
					this.invalidate();
					return;
				}
			}
			return;
		}
		if (data === "]") {
			for (let i = this.currentIndex + 1; i < this.comments.length; i++) {
				if (this.comments[i]!.file !== comment.file) {
					this.currentIndex = i;
					this.invalidate();
					return;
				}
			}
			return;
		}
		if (matchesKey(data, Key.ctrl("a"))) {
			comment.status = comment.status === "approved" ? "pending" : "approved";
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.ctrl("d"))) {
			comment.status = comment.status === "dismissed" ? "pending" : "dismissed";
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.ctrl("e")) || matchesKey(data, Key.enter)) {
			this.onDone({ type: "edit", index: this.currentIndex });
			return;
		}
		if (matchesKey(data, Key.ctrl("p"))) {
			for (const c of this.comments) if (c.status === "pending") c.status = "approved";
			this.invalidate();
			return;
		}
		if (matchesKey(data, Key.ctrl("s"))) {
			this.onDone({ type: "submit" });
			return;
		}
		if (matchesKey(data, Key.escape) || data === "q") {
			this.onDone({ type: "cancel" });
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const lines: string[] = [];
		const maxW = Math.max(40, Math.min(width, 120));
		const innerW = Math.max(20, maxW - 2);

		const row = (content = "") => {
			// The TUI renderer validates terminal-visible width after the terminal expands tabs.
			// Keep every custom-rendered row bounded by normalizing tabs before measuring/padding.
			const normalized = expandTabs(content);
			const fitted = visibleWidth(normalized) > innerW ? truncateToWidth(normalized, innerW) : normalized;
			const padding = Math.max(0, innerW - visibleWidth(fitted));
			lines.push(th.fg("border", "│") + fitted + " ".repeat(padding) + th.fg("border", "│"));
		};

		const addWrapped = (content: string, prefix = "") => {
			const normalizedPrefix = expandTabs(prefix);
			const available = Math.max(8, innerW - visibleWidth(normalizedPrefix));
			for (const part of wrapTextWithAnsi(expandTabs(content), available)) {
				row(normalizedPrefix + part);
			}
		};

		const divider = () => row(th.fg("dim", "─".repeat(innerW)));
		const top = () => lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));
		const bottom = () => lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

		const approved = this.comments.filter((c) => c.status === "approved" || c.status === "edited").length;
		const dismissed = this.comments.filter((c) => c.status === "dismissed").length;
		const pending = this.comments.filter((c) => c.status === "pending").length;

		top();
		row(
			th.fg("accent", th.bold(" Code Review ")) +
				th.fg("muted", ` ${this.currentIndex + 1}/${this.comments.length} `) +
				th.fg("dim", "│ ") +
				[th.fg("success", `✓${approved}`), th.fg("error", `✗${dismissed}`), th.fg("warning", `○${pending}`)].join(
					th.fg("dim", " │ "),
				),
		);
		divider();

		if (this.comments.length === 0) {
			row("");
			addWrapped(th.fg("dim", "No comments to review"), "  ");
			row("");
			addWrapped(th.fg("dim", "Esc/q close"), "  ");
			bottom();
			this.cachedLines = lines;
			this.cachedWidth = width;
			return lines;
		}

		const comment = this.comments[this.currentIndex]!;
		row("");
		const lineInfo = comment.endLine
			? `${th.fg("warning", String(comment.line))}${th.fg("dim", "-")}${th.fg("warning", String(comment.endLine))}`
			: th.fg("warning", String(comment.line));
		addWrapped(`${th.fg("accent", comment.file)}${th.fg("dim", ":")}${lineInfo}`, "  ");
		row("");

		if (comment.codeContext) {
			const targetStart = Math.min(comment.line, comment.endLine ?? comment.line);
			const targetEnd = Math.max(comment.line, comment.endLine ?? comment.line);
			const window = sliceHunkAroundLines(comment.codeContext, targetStart, targetEnd, 12);
			const linePrefix = `  ${th.fg("dim", "┃")} `;
			if (window.header) addWrapped(th.fg("dim", window.header), linePrefix);
			if (window.hiddenBefore > 0) {
				addWrapped(th.fg("dim", `... ${window.hiddenBefore} earlier line${window.hiddenBefore !== 1 ? "s" : ""}`), linePrefix);
			}
			for (const cl of window.lines) {
				const styled = cl.startsWith("+")
					? th.fg("toolDiffAdded", cl)
					: cl.startsWith("-")
						? th.fg("toolDiffRemoved", cl)
						: th.fg("toolDiffContext", cl);
				addWrapped(styled, linePrefix);
			}
			if (window.hiddenAfter > 0) {
				addWrapped(th.fg("dim", `... ${window.hiddenAfter} later line${window.hiddenAfter !== 1 ? "s" : ""}`), linePrefix);
			}
			row("");
		}

		const priority = getCommentPriority(comment);
		addWrapped(th.fg(getPriorityInfo(priority).color, priorityLabel(comment)), "  ");
		divider();
		row("");
		addWrapped(th.fg("text", th.bold(getCommentTitle(comment))), "  ");
		row("");
		const bodyLines = getCommentBody(comment).split("\n");
		for (const bl of bodyLines.slice(0, 20)) addWrapped(th.fg("text", bl), "  ");
		if (bodyLines.length > 20) addWrapped(th.fg("dim", `... ${bodyLines.length - 20} more lines`), "  ");
		if (comment.status === "edited" && comment.originalBody) {
			row("");
			addWrapped(th.fg("dim", "original: " + comment.originalBody), "  ");
		}
		row("");
		addWrapped(th.fg(statusColor(comment.status), `${statusIcon(comment.status)} ${comment.status.charAt(0).toUpperCase() + comment.status.slice(1)}`), "  ");
		divider();
		row("");

		const maxDots = 40;
		let dotsSlice = this.comments;
		let dotsOffset = 0;
		let prefixEllipsis = false;
		let suffixEllipsis = false;
		if (this.comments.length > maxDots) {
			const half = Math.floor(maxDots / 2);
			let start = Math.max(0, this.currentIndex - half);
			let end = start + maxDots;
			if (end > this.comments.length) {
				end = this.comments.length;
				start = Math.max(0, end - maxDots);
			}
			dotsSlice = this.comments.slice(start, end);
			dotsOffset = start;
			prefixEllipsis = start > 0;
			suffixEllipsis = end < this.comments.length;
		}
		const dots = dotsSlice
			.map((c, i) => {
				const idx = dotsOffset + i;
				return th.fg(idx === this.currentIndex ? "accent" : statusColor(c.status), idx === this.currentIndex ? "●" : statusIcon(c.status));
			})
			.join(" ");
		addWrapped(`${prefixEllipsis ? th.fg("dim", "… ") : ""}${dots}${suffixEllipsis ? th.fg("dim", " …") : ""}`, "  ");
		row("");
		addWrapped(th.fg("dim", "↑↓/^j^k navigate  [/] prev/next file  ^a approve  ^d dismiss  ^e/Enter edit"), "  ");
		addWrapped(th.fg("dim", "^p approve pending  ^s submit  Esc/q cancel"), "  ");
		bottom();
		this.cachedLines = lines;
		this.cachedWidth = width;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
