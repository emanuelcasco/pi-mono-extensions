/**
 * ask-user-question — Interactive form tool for pi
 *
 * A powerful tool that the LLM can call to ask the user one or more questions
 * using rich form controls: radio buttons, checkboxes, and text inputs.
 * Each question type supports an optional "Other..." escape hatch for custom input.
 *
 * Question types:
 *   - radio:    Single-select from options (with optional custom "Other")
 *   - checkbox: Multi-select from options (with optional custom "Other")
 *   - text:     Free-form text input
 *
 * Navigation:
 *   - Tab / Shift+Tab to move between questions
 *   - Up/Down to navigate options within a question
 *   - Space to toggle checkboxes
 *   - Enter to select radio / submit text / advance
 *   - Esc to cancel
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// ─── Types ───────────────────────────────────────────────────────────────────

interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

interface Question {
	id: string;
	type: "radio" | "checkbox" | "text";
	prompt: string;
	label?: string;
	options?: QuestionOption[];
	allowOther?: boolean;
	required?: boolean;
	placeholder?: string;
	default?: string | string[];
}

interface NormalizedQuestion extends Question {
	label: string;
	options: QuestionOption[];
	allowOther: boolean;
	required: boolean;
}

interface Answer {
	id: string;
	type: "radio" | "checkbox" | "text";
	value: string | string[];
	wasCustom: boolean;
}

interface FormResult {
	title?: string;
	questions: NormalizedQuestion[];
	answers: Answer[];
	cancelled: boolean;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const OptionSchema = Type.Object({
	value: Type.String({ description: "Value returned when selected" }),
	label: Type.String({ description: "Display label" }),
	description: Type.Optional(Type.String({ description: "Help text shown below the label" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	type: Type.Unsafe<"radio" | "checkbox" | "text">({
		type: "string",
		enum: ["radio", "checkbox", "text"],
		description: "Question type: radio (single-select), checkbox (multi-select), or text (free input)",
	}),
	prompt: Type.String({ description: "The question text to display" }),
	label: Type.Optional(Type.String({ description: "Short label for tab bar (defaults to Q1, Q2...)" })),
	options: Type.Optional(Type.Array(OptionSchema, { description: "Options for radio/checkbox types" })),
	allowOther: Type.Optional(
		Type.Boolean({ description: "Add an 'Other...' option with text input (default: true for radio/checkbox)" }),
	),
	required: Type.Optional(Type.Boolean({ description: "Whether an answer is required (default: true)" })),
	placeholder: Type.Optional(Type.String({ description: "Placeholder for text inputs" })),
	default: Type.Optional(
		Type.Union([Type.String(), Type.Array(Type.String())], {
			description: "Default value(s). String for radio/text, string[] for checkbox",
		}),
	),
});

const AskUserQuestionParams = Type.Object({
	title: Type.Optional(Type.String({ description: "Form title displayed at the top" })),
	description: Type.Optional(Type.String({ description: "Brief context or instructions shown under the title" })),
	questions: Type.Array(QuestionSchema, {
		description: "One or more questions to ask. Use radio for single-select, checkbox for multi-select, text for free input",
	}),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalize(questions: Question[]): NormalizedQuestion[] {
	return questions.map((q, i) => ({
		...q,
		label: q.label || `Q${i + 1}`,
		options: q.options || [],
		allowOther: q.type === "text" ? false : q.allowOther !== false,
		required: q.required !== false,
	}));
}

function wrapText(text: string, maxWidth: number): string[] {
	const words = text.split(" ");
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		if (!current) {
			current = word;
		} else if (current.length + 1 + word.length <= maxWidth) {
			current += ` ${word}`;
		} else {
			lines.push(current);
			current = word;
		}
	}
	if (current) lines.push(current);
	return lines.length ? lines : [""];
}

function errorResult(msg: string): {
	content: { type: "text"; text: string }[];
	details: FormResult;
} {
	return {
		content: [{ type: "text", text: msg }],
		details: { questions: [], answers: [], cancelled: true },
	};
}

// ─── Symbols ─────────────────────────────────────────────────────────────────

const SYM = {
	radioOn: "◉",
	radioOff: "○",
	checkOn: "☑",
	checkOff: "☐",
	pointer: "❯",
	dot: "·",
	check: "✓",
	pencil: "✎",
	submit: "✓",
};

// ─── Extension ───────────────────────────────────────────────────────────────

export default function askUserQuestion(pi: ExtensionAPI) {
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User",
		description: `Ask the user one or more questions using an interactive form. Supports three question types:
- **radio**: Single-select from predefined options (like multiple choice)
- **checkbox**: Multi-select from options (pick all that apply)
- **text**: Free-form text input

Each radio/checkbox question can include an "Other..." option that lets the user type a custom answer.

Use this tool when you need user input to proceed — for clarifying requirements, getting preferences, confirming decisions, or choosing between alternatives. Prefer this over asking plain-text questions in your response.`,
		promptSnippet: "Ask the user interactive questions with radio, checkbox, or text inputs",
		promptGuidelines: [
			"Use ask_user_question instead of asking questions in plain text when you need structured user input.",
			"Prefer radio for single-choice, checkbox for multi-choice, text for open-ended answers.",
			"Always include an 'Other' escape hatch (allowOther: true) unless the options are exhaustive.",
			"Group related questions in a single call rather than making multiple separate calls.",
		],
		parameters: AskUserQuestionParams as any,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return errorResult("Error: UI not available (running in non-interactive mode)");
			}
			if (!params.questions.length) {
				return errorResult("Error: No questions provided");
			}

			const questions = normalize(params.questions as Question[]);
			const isMulti = questions.length > 1;
			const totalTabs = questions.length + (isMulti ? 1 : 0); // +1 for Submit tab

			const result = await ctx.ui.custom<FormResult>((tui, theme, _kb, done) => {
				// ── State ────────────────────────────────────────────────
				let currentTab = 0;
				let cursorIdx = 0; // cursor within current question's options
				let otherMode = false; // typing into "Other..." editor
				let otherQuestionId: string | null = null;
				let cachedLines: string[] | undefined;

				// Answers store
				const radioAnswers = new Map<string, { value: string; label: string; wasCustom: boolean }>();
				const checkAnswers = new Map<string, Set<string>>(); // id -> set of selected values
				const checkCustom = new Map<string, string>(); // id -> custom "other" text
				const textAnswers = new Map<string, string>();

				// Initialize defaults
				for (const q of questions) {
					if (q.type === "checkbox") {
						const defaults = new Set<string>();
						if (Array.isArray(q.default)) {
							for (const v of q.default) defaults.add(v);
						}
						checkAnswers.set(q.id, defaults);
					} else if (q.type === "text" && typeof q.default === "string") {
						textAnswers.set(q.id, q.default);
					} else if (q.type === "radio" && typeof q.default === "string") {
						const opt = q.options.find((o) => o.value === q.default);
						if (opt) radioAnswers.set(q.id, { value: opt.value, label: opt.label, wasCustom: false });
					}
				}

				// Editor for "Other" and "text" fields
				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);

				function getNextTab(): number {
					if (currentTab < questions.length - 1) {
						return currentTab + 1;
					}
					return questions.length; // Submit tab
				}

				function advanceTab() {
					if (!(questions.length > 1)) {
						finishSubmit(false);
					} else {
						switchTab(getNextTab());
					}
				}

				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function curQ(): NormalizedQuestion | undefined {
					return questions[currentTab];
				}

				/** Save "Other" editor text to the appropriate answer store and exit otherMode. */
				function saveOtherModeText() {
					if (!otherMode || !otherQuestionId) return;
					const t = editor.getText().trim();
					const oq = questions.find((q) => q.id === otherQuestionId);
					if (oq?.type === "radio" && t) {
						radioAnswers.set(oq.id, { value: t, label: t, wasCustom: true });
					} else if (oq?.type === "checkbox" && t) {
						checkCustom.set(oq.id, t);
					}
					otherMode = false;
					otherQuestionId = null;
					editor.setText("");
				}

				/** Total selectable rows for the current question */
				function optionCount(q: NormalizedQuestion): number {
					if (q.type === "text") return 0;
					return q.options.length + (q.allowOther ? 1 : 0);
				}

				function isAnswered(q: NormalizedQuestion): boolean {
					if (q.type === "radio") return radioAnswers.has(q.id);
					if (q.type === "checkbox") {
						const set = checkAnswers.get(q.id);
						const custom = checkCustom.get(q.id);
						return (set != null && set.size > 0) || (custom != null && custom.trim().length > 0);
					}
					if (q.type === "text") {
						return (textAnswers.get(q.id)?.trim() ?? "").length > 0;
					}
					return false;
				}

				function allRequired(): boolean {
					return questions.every((q) => !q.required || isAnswered(q));
				}

				function switchTab(idx: number) {
					// Save text editor state
					saveEditorText();
					currentTab = ((idx % totalTabs) + totalTabs) % totalTabs;
					cursorIdx = 0;
					otherMode = false;
					otherQuestionId = null;

					// If switching to a text question, load its value
					const q = curQ();
					if (q?.type === "text") {
						editor.setText(textAnswers.get(q.id) ?? "");
					}
					refresh();
				}

				function saveEditorText() {
					const q = curQ();
					if (!q) return;
					if (q.type === "text") {
						const t = editor.getText().trim();
						if (t) textAnswers.set(q.id, t);
						else textAnswers.delete(q.id);
					}
				}

				function finishSubmit(cancelled: boolean) {
					saveEditorText();
					const answers: Answer[] = [];
					for (const q of questions) {
						if (q.type === "radio") {
							const a = radioAnswers.get(q.id);
							answers.push({
								id: q.id,
								type: "radio",
								value: a?.value ?? "",
								wasCustom: a?.wasCustom ?? false,
							});
						} else if (q.type === "checkbox") {
							const set = checkAnswers.get(q.id) ?? new Set();
							const custom = checkCustom.get(q.id)?.trim();
							const values = [...set];
							if (custom) values.push(custom);
							answers.push({ id: q.id, type: "checkbox", value: values, wasCustom: !!custom });
						} else {
							const t = textAnswers.get(q.id) ?? "";
							answers.push({ id: q.id, type: "text", value: t, wasCustom: true });
						}
					}
					done({ title: params.title, questions, answers, cancelled });
				}

				// ── Editor submit (for "Other" mode) ────────────────────
				editor.onSubmit = (value) => {
					const trimmed = value.trim();
					if (otherMode && otherQuestionId) {
						const q = questions.find((q) => q.id === otherQuestionId);
						if (q?.type === "radio" && trimmed) {
							radioAnswers.set(q.id, { value: trimmed, label: trimmed, wasCustom: true });
						} else if (q?.type === "checkbox" && trimmed) {
							checkCustom.set(q.id, trimmed);
						}
						otherMode = false;
						otherQuestionId = null;
						editor.setText("");

						// Auto-advance
						advanceTab();
						return;
					}

					// Text question submit (fallback — Enter is normally intercepted in handleInput
					// before reaching the editor, but handle it here defensively using `value`
					// since editor state is already cleared by the time onSubmit fires)
					const q = curQ();
					if (q?.type === "text") {
						const trimmedValue = value.trim();
						if (trimmedValue) {
							textAnswers.set(q.id, trimmedValue);
						} else {
							textAnswers.delete(q.id);
						}
						advanceTab();
					}
				};

				// ── Input handling ───────────────────────────────────────

				function handleInput(data: string) {
					// "Other" editor mode
					if (otherMode) {
						if (matchesKey(data, Key.escape)) {
							otherMode = false;
							otherQuestionId = null;
							editor.setText("");
							refresh();
							return;
						}
						// Enter: capture text directly from editor (before it clears itself) and advance
						if (matchesKey(data, Key.enter)) {
							saveOtherModeText();
							advanceTab();
							return;
						}
						// Tab navigation in multi-question forms: save text and switch tab
						if (isMulti && (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")))) {
							saveOtherModeText();
							switchTab(currentTab + (matchesKey(data, Key.shift("tab")) ? -1 : 1));
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					// Text question — route most input to editor
					const q = curQ();
					if (q?.type === "text") {
						// Enter: save text (editor still has content here) and advance
						if (matchesKey(data, Key.enter)) {
							saveEditorText();
							advanceTab();
							return;
						}
						// Tab navigation still works
						if (isMulti && (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")))) {
							saveEditorText();
							switchTab(currentTab + (matchesKey(data, Key.shift("tab")) ? -1 : 1));
							return;
						}
						if (matchesKey(data, Key.escape)) {
							finishSubmit(true);
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					// Submit tab (multi-question only)
					if (isMulti && currentTab === questions.length) {
						if (matchesKey(data, Key.enter) && allRequired()) {
							finishSubmit(false);
							return;
						}
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							switchTab(0);
							return;
						}
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
							switchTab(currentTab - 1);
							return;
						}
						if (matchesKey(data, Key.escape)) {
							finishSubmit(true);
							return;
						}
						return;
					}

					if (!q) return;

					// Tab navigation (multi)
					if (isMulti) {
						if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
							switchTab(currentTab + 1);
							return;
						}
						if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
							switchTab(currentTab - 1);
							return;
						}
					}

					// Arrow navigation
					const total = optionCount(q);
					if (matchesKey(data, Key.up)) {
						cursorIdx = Math.max(0, cursorIdx - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						cursorIdx = Math.min(total - 1, cursorIdx + 1);
						refresh();
						return;
					}

					// Escape
					if (matchesKey(data, Key.escape)) {
						finishSubmit(true);
						return;
					}

					// Radio select
					if (q.type === "radio" && matchesKey(data, Key.enter)) {
						const isOther = q.allowOther && cursorIdx === q.options.length;
						if (isOther) {
							otherMode = true;
							otherQuestionId = q.id;
							// Pre-fill with existing custom answer
							const existing = radioAnswers.get(q.id);
							editor.setText(existing?.wasCustom ? existing.label : "");
							refresh();
							return;
						}
						const opt = q.options[cursorIdx];
						if (opt) {
							radioAnswers.set(q.id, { value: opt.value, label: opt.label, wasCustom: false });
							advanceTab();
						}
						return;
					}

					// Checkbox toggle (space only)
					if (q.type === "checkbox" && matchesKey(data, Key.space)) {
						const isOther = q.allowOther && cursorIdx === q.options.length;
						if (isOther) {
							otherMode = true;
							otherQuestionId = q.id;
							editor.setText(checkCustom.get(q.id) ?? "");
							refresh();
							return;
						}
						const opt = q.options[cursorIdx];
						if (opt) {
							const set = checkAnswers.get(q.id) ?? new Set();
							if (set.has(opt.value)) set.delete(opt.value);
							else set.add(opt.value);
							checkAnswers.set(q.id, set);
							refresh();
						}
						return;
					}

					// Checkbox: Enter submits (single) or advances (multi)
					if (q.type === "checkbox" && matchesKey(data, Key.enter)) {
						advanceTab();
						return;
					}
				}

				// ── Render ───────────────────────────────────────────────

				function render(width: number): string[] {
					if (cachedLines) return cachedLines;

					const lines: string[] = [];
					const maxW = Math.min(width, 120);
					const add = (s: string) => lines.push(truncateToWidth(s, maxW));
					const hr = () => add(theme.fg("accent", "─".repeat(maxW)));

					hr();

					// Title & description
					if (params.title) {
						add(` ${theme.fg("accent", theme.bold(params.title))}`);
					}
					if (params.description) {
						add(` ${theme.fg("muted", params.description)}`);
					}
					if (params.title || params.description) lines.push("");

					// Tab bar (multi-question)
					if (isMulti) {
						const tabs: string[] = [];
						for (let i = 0; i < questions.length; i++) {
							const isActive = i === currentTab;
							const answered = isAnswered(questions[i]);
							const lbl = questions[i].label;
							const icon = answered ? theme.fg("success", SYM.check) : theme.fg("dim", SYM.dot);
							const text = ` ${icon} ${lbl} `;
							tabs.push(
								isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(answered ? "success" : "muted", text),
							);
						}
						// Submit tab
						const isSubmitTab = currentTab === questions.length;
						const canSubmit = allRequired();
						const submitText = ` ${SYM.submit} Submit `;
						tabs.push(
							isSubmitTab
								? theme.bg("selectedBg", theme.fg("text", submitText))
								: theme.fg(canSubmit ? "success" : "dim", submitText),
						);
						add(` ${tabs.join(theme.fg("dim", "│"))}`);
						lines.push("");
					}

					const q = curQ();

					// ── Submit tab ───────────────────────────────────────
					if (isMulti && currentTab === questions.length) {
						add(` ${theme.fg("accent", theme.bold("Review & Submit"))}`);
						lines.push("");

						for (const question of questions) {
							const label = theme.fg("muted", `${question.label}:`);
							if (question.type === "radio") {
								const a = radioAnswers.get(question.id);
								if (a) {
									const prefix = a.wasCustom ? theme.fg("dim", "(wrote) ") : "";
									add(` ${label} ${prefix}${a.label}`);
								} else {
									add(` ${label} ${theme.fg("warning", "(unanswered)")}`);
								}
							} else if (question.type === "checkbox") {
								const set = checkAnswers.get(question.id) ?? new Set();
								const custom = checkCustom.get(question.id)?.trim();
								const all = [...set];
								if (custom) all.push(`${theme.fg("dim", "(wrote)")} ${custom}`);
								if (all.length) {
									add(` ${label} ${all.join(", ")}`);
								} else {
									add(` ${label} ${theme.fg("warning", "(unanswered)")}`);
								}
							} else {
								const t = textAnswers.get(question.id)?.trim();
								if (t) {
									add(` ${label} ${truncateToWidth(t, maxW - visibleWidth(question.label) - 5)}`);
								} else {
									add(` ${label} ${theme.fg("warning", "(unanswered)")}`);
								}
							}
						}

						lines.push("");
						if (allRequired()) {
							add(` ${theme.fg("success", "Press Enter to submit")}`);
						} else {
							const missing = questions
								.filter((q) => q.required && !isAnswered(q))
								.map((q) => q.label)
								.join(", ");
							add(` ${theme.fg("warning", `Required: ${missing}`)}`);
						}

						lines.push("");
						add(theme.fg("dim", " Tab/←→ navigate questions • Enter submit • Esc cancel"));
						hr();
						cachedLines = lines;
						return lines;
					}

					if (!q) {
						hr();
						cachedLines = lines;
						return lines;
					}

					// ── Question prompt ──────────────────────────────────
					const typeTag =
						q.type === "radio"
							? theme.fg("dim", "[single-select]")
							: q.type === "checkbox"
								? theme.fg("dim", "[multi-select]")
								: theme.fg("dim", "[text]");

					const promptLines = wrapText(q.prompt, maxW - 2);
					for (let i = 0; i < promptLines.length; i++) {
						const isLast = i === promptLines.length - 1;
						add(` ${theme.fg("text", theme.bold(promptLines[i]))}${isLast ? ` ${typeTag}` : ""}`);
					}
					if (q.required) {
						add(` ${theme.fg("warning", "*required")}`);
					}
					lines.push("");

					// ── Radio options ────────────────────────────────────
					if (q.type === "radio") {
						const selected = radioAnswers.get(q.id);
						for (let i = 0; i < q.options.length; i++) {
							const opt = q.options[i];
							const isCursor = i === cursorIdx;
							const isSelected = selected?.value === opt.value && !selected.wasCustom;
							const bullet = isSelected ? theme.fg("accent", SYM.radioOn) : theme.fg("dim", SYM.radioOff);
							const pointer = isCursor ? theme.fg("accent", SYM.pointer) : " ";
							const color = isCursor ? "accent" : isSelected ? "text" : "muted";
							add(` ${pointer} ${bullet} ${theme.fg(color, opt.label)}`);
							if (opt.description) {
								add(`      ${theme.fg("dim", opt.description)}`);
							}
						}
						if (q.allowOther) {
							const isCursor = cursorIdx === q.options.length;
							const isSelected = selected?.wasCustom === true;
							const bullet = isSelected ? theme.fg("accent", SYM.radioOn) : theme.fg("dim", SYM.radioOff);
							const pointer = isCursor ? theme.fg("accent", SYM.pointer) : " ";
							const label = isSelected ? `Other: ${selected.label}` : "Other...";
							add(` ${pointer} ${bullet} ${theme.fg(isCursor ? "accent" : "muted", label)}`);

							if (otherMode) {
								lines.push("");
								add(` ${theme.fg("muted", "  Your answer:")}`);
								for (const line of editor.render(maxW - 6)) {
									add(`   ${line}`);
								}
							}
						}
					}

					// ── Checkbox options ─────────────────────────────────
					if (q.type === "checkbox") {
						const set = checkAnswers.get(q.id) ?? new Set();
						for (let i = 0; i < q.options.length; i++) {
							const opt = q.options[i];
							const isCursor = i === cursorIdx;
							const isChecked = set.has(opt.value);
							const box = isChecked ? theme.fg("accent", SYM.checkOn) : theme.fg("dim", SYM.checkOff);
							const pointer = isCursor ? theme.fg("accent", SYM.pointer) : " ";
							const color = isCursor ? "accent" : isChecked ? "text" : "muted";
							add(` ${pointer} ${box} ${theme.fg(color, opt.label)}`);
							if (opt.description) {
								add(`      ${theme.fg("dim", opt.description)}`);
							}
						}
						if (q.allowOther) {
							const isCursor = cursorIdx === q.options.length;
							const custom = checkCustom.get(q.id)?.trim();
							const box = custom ? theme.fg("accent", SYM.checkOn) : theme.fg("dim", SYM.checkOff);
							const pointer = isCursor ? theme.fg("accent", SYM.pointer) : " ";
							const label = custom ? `Other: ${custom}` : "Other...";
							add(` ${pointer} ${box} ${theme.fg(isCursor ? "accent" : "muted", label)}`);

							if (otherMode) {
								lines.push("");
								add(` ${theme.fg("muted", "  Your answer:")}`);
								for (const line of editor.render(maxW - 6)) {
									add(`   ${line}`);
								}
							}
						}
					}

					// ── Text input ───────────────────────────────────────
					if (q.type === "text") {
						if (q.placeholder && !editor.getText()) {
							add(` ${theme.fg("dim", q.placeholder)}`);
						}
						for (const line of editor.render(maxW - 4)) {
							add(`  ${line}`);
						}
					}

					// ── Footer ───────────────────────────────────────────
					lines.push("");
					if (otherMode) {
						add(theme.fg("dim", " Enter submit • Esc go back"));
					} else if (q.type === "text") {
						const nav = isMulti ? "Tab/←→ navigate • " : "";
						add(theme.fg("dim", ` ${nav}Enter submit • Esc cancel`));
					} else if (q.type === "checkbox") {
						const nav = isMulti ? "Tab/←→ navigate • " : "";
						add(theme.fg("dim", ` ↑↓ navigate • Space toggle • ${nav}Enter ${isMulti ? "next" : "submit"} • Esc cancel`));
					} else {
						const nav = isMulti ? "Tab/←→ navigate • " : "";
						add(theme.fg("dim", ` ↑↓ navigate • ${nav}Enter select • Esc cancel`));
					}
					hr();

					cachedLines = lines;
					return lines;
				}

				// Initialize: if first question is text, load editor
				const firstQ = questions[0];
				if (firstQ?.type === "text") {
					editor.setText(textAnswers.get(firstQ.id) ?? "");
				}

				return {
					render,
					invalidate: () => {
						cachedLines = undefined;
					},
					handleInput,
				};
			});

			// ── Format result ────────────────────────────────────────────

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the form" }],
					details: result,
				};
			}

			const answerLines: string[] = [];
			for (const a of result.answers) {
				const q = questions.find((q) => q.id === a.id);
				const label = q?.label || a.id;
				if (a.type === "radio") {
					const prefix = a.wasCustom ? "(wrote) " : "";
					answerLines.push(`${label}: ${prefix}${a.value}`);
				} else if (a.type === "checkbox") {
					const values = Array.isArray(a.value) ? a.value : [a.value];
					if (values.length === 0) {
						answerLines.push(`${label}: (none selected)`);
					} else {
						answerLines.push(`${label}: ${values.join(", ")}`);
					}
				} else {
					answerLines.push(`${label}: ${a.value || "(empty)"}`);
				}
			}

			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: result,
			};
		},

		// ── Custom rendering ─────────────────────────────────────────────

		renderCall(args, theme, _context) {
			const qs = (args.questions as Question[]) || [];
			const title = args.title as string | undefined;
			let text = theme.fg("toolTitle", theme.bold("ask_user_question "));
			if (title) {
				text += theme.fg("accent", title) + " ";
			}
			text += theme.fg("muted", `${qs.length} question${qs.length !== 1 ? "s" : ""}`);
			const types = [...new Set(qs.map((q) => q.type))].join(", ");
			if (types) {
				text += theme.fg("dim", ` (${types})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as FormResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}

			const lines = details.answers.map((a) => {
				const q = details.questions.find((q) => q.id === a.id);
				const label = q?.label || a.id;

				if (a.type === "radio") {
					const prefix = a.wasCustom ? theme.fg("dim", "(wrote) ") : "";
					return `${theme.fg("success", SYM.check)} ${theme.fg("accent", label)}: ${prefix}${a.value}`;
				}
				if (a.type === "checkbox") {
					const values = Array.isArray(a.value) ? a.value : [a.value];
					const display = values.length ? values.join(", ") : theme.fg("dim", "(none)");
					return `${theme.fg("success", SYM.check)} ${theme.fg("accent", label)}: ${display}`;
				}
				return `${theme.fg("success", SYM.check)} ${theme.fg("accent", label)}: ${a.value || theme.fg("dim", "(empty)")}`;
			});

			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
