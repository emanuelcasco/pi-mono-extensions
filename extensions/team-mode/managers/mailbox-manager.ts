/**
 * Pi Teams — MailboxManager
 *
 * High-level API for sending and querying messages in a team's append-only
 * mailbox (`mailbox.ndjson`).
 *
 * All methods delegate storage to `TeamStore`; this class adds ID generation,
 * filtering, and convenience queries on top.
 */

import type { MailboxFilter, MailboxMessage } from "../core/types.js";
import type { TeamStore } from "../core/store.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Derive the next message ID for a team by counting existing messages.
 * IDs are sequential: `msg-001`, `msg-002`, …
 */
async function nextMessageId(store: TeamStore, teamId: string): Promise<string> {
	const existing = await store.loadMessages(teamId);
	const next = existing.length + 1;
	return `msg-${String(next).padStart(3, "0")}`;
}

/**
 * Apply a `MailboxFilter` to an array of messages, returning only those that
 * satisfy every specified criterion.
 */
function applyFilter(messages: MailboxMessage[], filter?: MailboxFilter): MailboxMessage[] {
	if (!filter) return messages;

	return messages.filter((m) => {
		if (filter.to && m.to !== filter.to) return false;
		if (filter.from && m.from !== filter.from) return false;
		if (filter.taskId && m.taskId !== filter.taskId) return false;
		if (filter.type && m.type !== filter.type) return false;
		if (filter.since && m.createdAt <= filter.since) return false;
		return true;
	});
}

// ---------------------------------------------------------------------------
// MailboxManager
// ---------------------------------------------------------------------------

export class MailboxManager {
	constructor(private store: TeamStore) {}

	// -------------------------------------------------------------------------
	// Write
	// -------------------------------------------------------------------------

	/**
	 * Send a message to the team mailbox.
	 *
	 * Assigns a sequential ID (`msg-NNN`) and an ISO 8601 `createdAt` timestamp,
	 * then appends the message to the team's `mailbox.ndjson` file.
	 */
	async send(
		teamId: string,
		msg: Omit<MailboxMessage, "id" | "teamId" | "createdAt">,
	): Promise<MailboxMessage> {
		const id = await nextMessageId(this.store, teamId);
		const full: MailboxMessage = {
			...msg,
			id,
			teamId,
			createdAt: new Date().toISOString(),
		};
		await this.store.appendMessage(teamId, full);
		return full;
	}

	// -------------------------------------------------------------------------
	// Read — general queries
	// -------------------------------------------------------------------------

	/**
	 * Return all mailbox messages for a team, optionally filtered.
	 */
	async getMessages(teamId: string, filter?: MailboxFilter): Promise<MailboxMessage[]> {
		const messages = await this.store.loadMessages(teamId);
		return applyFilter(messages, filter);
	}

	// -------------------------------------------------------------------------
	// Read — convenience queries
	// -------------------------------------------------------------------------

	/**
	 * Return all messages addressed to a specific recipient.
	 *
	 * Includes broadcast messages (`to === 'all'`) as well as messages sent
	 * directly to `recipient`.
	 */
	async getMessagesFor(teamId: string, recipient: string): Promise<MailboxMessage[]> {
		return this.store.loadMessagesFor(teamId, recipient);
	}

	/**
	 * Return all messages sent by a specific sender.
	 */
	async getMessagesFrom(teamId: string, sender: string): Promise<MailboxMessage[]> {
		const messages = await this.store.loadMessages(teamId);
		return messages.filter((m) => m.from === sender);
	}

	/**
	 * Return all messages scoped to a specific task.
	 */
	async getMessagesForTask(teamId: string, taskId: string): Promise<MailboxMessage[]> {
		const messages = await this.store.loadMessages(teamId);
		return messages.filter((m) => m.taskId === taskId);
	}

	/**
	 * Return messages received after `since` (ISO 8601 timestamp) that are
	 * addressed to `recipient` or broadcast to everyone (`to === 'all'`).
	 *
	 * Useful for polling unread messages since the last activity cursor.
	 */
	async getNewMessages(
		teamId: string,
		recipient: string,
		since: string,
	): Promise<MailboxMessage[]> {
		const messages = await this.store.loadMessages(teamId);
		return messages.filter(
			(m) => m.createdAt > since && (m.to === recipient || m.to === "all"),
		);
	}
}
