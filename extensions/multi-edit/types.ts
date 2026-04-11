export interface EditItem {
	path: string;
	oldText: string;
	newText: string;
}

export interface EditResult {
	path: string;
	success: boolean;
	message: string;
	diff?: string;
	firstChangedLine?: number;
}

/**
 * A single edit window inside an Update File operation.
 *
 * `oldBlock` is the exact literal substring to find in the target file;
 * `newBlock` is what it should be replaced with. Both are raw strings (not
 * arrays of lines) so the applier can work directly via `indexOf` without
 * reconstructing line arrays.
 *
 * `contextPrefix` is an optional anchor from a "@@ foo" hunk header. When set,
 * the applier must find `contextPrefix` before searching for `oldBlock`, so
 * the same oldBlock can appear multiple times in the file and be disambiguated
 * by the anchor.
 */
export interface Hunk {
	contextPrefix?: string;
	oldBlock: string;
	newBlock: string;
}

export type PatchOperation =
	| { kind: "add"; path: string; contents: string }
	| { kind: "delete"; path: string }
	| { kind: "update"; path: string; hunks: Hunk[] };

export interface PatchOpResult {
	path: string;
	message: string;
	diff?: string;
	firstChangedLine?: number;
}

export interface Workspace {
	readText: (absolutePath: string) => Promise<string>;
	writeText: (absolutePath: string, content: string) => Promise<void>;
	deleteFile: (absolutePath: string) => Promise<void>;
	exists: (absolutePath: string) => Promise<boolean>;
	/** Check that the file is writable. Rejects if not. Virtual implementations may still touch the real FS so preflights fail fast on read-only files. */
	checkWriteAccess: (absolutePath: string) => Promise<void>;
}
