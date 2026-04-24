// Pi Team-Mode — Shared FS helpers

import { readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
	const tmp = `${filePath}.${randomUUID().slice(0, 8)}.tmp`;
	try {
		await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
		await rename(tmp, filePath);
	} catch (err) {
		await unlink(tmp).catch(() => {});
		throw err;
	}
}

export async function readJson<T>(filePath: string): Promise<T | null> {
	try {
		const raw = await readFile(filePath, "utf8");
		return JSON.parse(raw) as T;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

export async function listSubdirs(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries.filter((e) => e.isDirectory()).map((e) => e.name);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw err;
	}
}

export function slugify(value: string, fallback: string, maxLen = 32): string {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, maxLen);
	return slug || fallback;
}
