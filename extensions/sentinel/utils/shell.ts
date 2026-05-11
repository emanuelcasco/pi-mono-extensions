export type ShellCommand = {
	type: "SimpleCommand";
	words: string[];
	redirects: Array<{ target: string }>;
};

type Token =
	| { type: "word"; value: string }
	| { type: "operator"; value: "|" | ";" }
	| { type: "redirect"; value: string };

type SimpleCommandNode = ShellCommand;

type StatementNode = {
	type: "Statement";
	command: SimpleCommandNode | PipelineNode;
};

type PipelineNode = {
	type: "Pipeline";
	commands: StatementNode[];
};

type ProgramNode = {
	type: "Program";
	body: StatementNode[];
};

function tokenize(command: string): Token[] | undefined {
	const tokens: Token[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaped = false;

	const flushWord = () => {
		if (current.length > 0) {
			tokens.push({ type: "word", value: current });
			current = "";
		}
	};

	for (let i = 0; i < command.length; i++) {
		const char = command[i];

		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}

		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}

		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}

		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}

		if (/\s/.test(char)) {
			flushWord();
			continue;
		}

		if (char === "|" || char === ";") {
			flushWord();
			tokens.push({ type: "operator", value: char });
			continue;
		}

		if (char === "<" || char === ">" || (/\d/.test(char) && ["<", ">"].includes(command[i + 1] ?? ""))) {
			flushWord();
			let redirect = char;
			if (/\d/.test(char)) {
				i++;
				redirect += command[i];
			}
			if (command[i + 1] === ">" || command[i + 1] === "<") {
				i++;
				redirect += command[i];
			}
			tokens.push({ type: "redirect", value: redirect });
			continue;
		}

		current += char;
	}

	if (quote || escaped) return undefined;
	flushWord();
	return tokens;
}

function buildSimpleCommand(tokens: Token[]): SimpleCommandNode | undefined {
	const words: string[] = [];
	const redirects: Array<{ target: string }> = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.type === "word") {
			words.push(token.value);
			continue;
		}
		if (token.type === "redirect") {
			const target = tokens[i + 1];
			if (target?.type !== "word") return undefined;
			redirects.push({ target: target.value });
			i++;
		}
	}
	if (words.length === 0 && redirects.length === 0) return undefined;
	return { type: "SimpleCommand", words, redirects };
}

function buildStatement(commandTokens: Token[]): StatementNode | undefined {
	const segments: Token[][] = [[]];
	for (const token of commandTokens) {
		if (token.type === "operator" && token.value === "|") {
			segments.push([]);
		} else {
			segments[segments.length - 1].push(token);
		}
	}

	const commands = segments
		.map(buildSimpleCommand)
		.filter((command): command is SimpleCommandNode => Boolean(command))
		.map((command) => ({ type: "Statement" as const, command }));

	if (commands.length === 0) return undefined;
	if (commands.length === 1) return commands[0];
	return { type: "Statement", command: { type: "Pipeline", commands } };
}

export function parseShell(command: string): ProgramNode | undefined {
	const tokens = tokenize(command);
	if (!tokens) return undefined;

	const body: StatementNode[] = [];
	let statementTokens: Token[] = [];
	for (const token of tokens) {
		if (token.type === "operator" && token.value === ";") {
			const statement = buildStatement(statementTokens);
			if (statement) body.push(statement);
			statementTokens = [];
		} else {
			statementTokens.push(token);
		}
	}
	const statement = buildStatement(statementTokens);
	if (statement) body.push(statement);
	return { type: "Program", body };
}

export function wordToString(word: unknown): string {
	return typeof word === "string" ? word : "";
}

export function walkCommands(ast: ProgramNode, visitor: (command: ShellCommand) => boolean | void): boolean {
	const visitStatement = (statement: StatementNode): boolean => {
		const command = statement.command;
		if (command.type === "SimpleCommand") return visitor(command) === true;
		return command.commands.some(visitStatement);
	};
	return ast.body.some(visitStatement);
}
