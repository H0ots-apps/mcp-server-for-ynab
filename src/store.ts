/**
 * Change log and plan notes, kept in the BUDGET_KV namespace.
 *
 * Keys:
 *   log:<inverted ms timestamp>:<random>  one change made through the connector, newest first
 *   plan:<slug>                           one plan note topic
 *
 * Cloudflare KV free plan: 1,000 writes and 1,000 list calls per day, which is far
 * more than this needs. KV is eventually consistent: a write is visible at once
 * in the same location and within about a minute everywhere else.
 */

/** The subset of KVNamespace used here, so tests can pass an in-memory fake. */
export interface KvLike {
	get(key: string): Promise<string | null>;
	put(key: string, value: string, options?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
	delete(key: string): Promise<void>;
	list(options: { prefix: string; limit?: number; cursor?: string }): Promise<{
		keys: Array<{ name: string; metadata?: unknown }>;
		list_complete: boolean;
		cursor?: string;
	}>;
}

export interface ChangeSummary {
	id: string;
	at: string;
	tool: string;
	summary: string;
}

export interface ChangeEntry extends ChangeSummary {
	args: unknown;
	result: unknown;
	truncated?: boolean;
}

export interface PlanNote {
	topic: string;
	text: string;
	updated_at: string;
}

const LOG_PREFIX = "log:";
const PLAN_PREFIX = "plan:";
const LOG_TTL_SECONDS = 400 * 86_400; // keep a bit over a year of changes
const MAX_ENTRY_CHARS = 60_000;
export const MAX_NOTE_CHARS = 20_000;

function slug(topic: string) {
	return topic
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

function withoutPlanId(args: unknown) {
	if (!args || typeof args !== "object") return args;
	const { plan_id: _ignored, ...rest } = args as Record<string, unknown>;
	return rest;
}

export class BudgetStore {
	constructor(private kv: KvLike) {}

	// ----- change log -----

	async recordChange(tool: string, args: unknown, result: unknown, at = new Date()) {
		const inverted = String(9_999_999_999_999 - at.getTime()).padStart(13, "0");
		const id = `${inverted}-${Math.random().toString(36).slice(2, 8)}`;
		const cleanArgs = withoutPlanId(args);
		const summary = `${tool} ${JSON.stringify(cleanArgs)}`.slice(0, 200);
		const entry: ChangeEntry = { id, at: at.toISOString(), tool, summary, args: cleanArgs, result };
		let value = JSON.stringify(entry);
		if (value.length > MAX_ENTRY_CHARS) {
			value = JSON.stringify({ ...entry, result: String(JSON.stringify(result)).slice(0, MAX_ENTRY_CHARS / 2), truncated: true });
		}
		const metadata: ChangeSummary = { id, at: entry.at, tool, summary };
		await this.kv.put(`${LOG_PREFIX}${id.replace("-", ":")}`, value, { expirationTtl: LOG_TTL_SECONDS, metadata });
		return id;
	}

	/** Newest first, back to `since`. Reads only key metadata (one list call per 1,000 changes). */
	async listChanges(since: Date, tool?: string, limit = 50) {
		const out: ChangeSummary[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 5; page++) {
			const res = await this.kv.list({ prefix: LOG_PREFIX, limit: 1000, cursor });
			for (const k of res.keys) {
				const m = k.metadata as ChangeSummary | undefined;
				if (!m) continue;
				if (m.at < since.toISOString()) return out;
				if (tool && m.tool !== tool) continue;
				out.push(m);
				if (out.length >= limit) return out;
			}
			if (res.list_complete || !res.cursor) break;
			cursor = res.cursor;
		}
		return out;
	}

	async getChange(id: string) {
		const raw = await this.kv.get(`${LOG_PREFIX}${id.replace("-", ":")}`);
		return raw ? (JSON.parse(raw) as ChangeEntry) : null;
	}

	// ----- plan notes -----

	async listNotes() {
		const res = await this.kv.list({ prefix: PLAN_PREFIX, limit: 1000 });
		const notes = await Promise.all(res.keys.map((k) => this.kv.get(k.name)));
		return notes
			.filter((n): n is string => !!n)
			.map((n) => JSON.parse(n) as PlanNote)
			.sort((a, b) => a.topic.localeCompare(b.topic));
	}

	async getNote(topic: string) {
		const raw = await this.kv.get(`${PLAN_PREFIX}${slug(topic)}`);
		return raw ? (JSON.parse(raw) as PlanNote) : null;
	}

	/**
	 * mode "upsert" keys a one-line entry by `matchPrefix`: the first line of the note that
	 * starts with it is replaced (later duplicates are removed), or the entry is appended
	 * when no line matches. Repeated saves for the same key leave one line.
	 */
	async saveNote(topic: string, text: string, mode: "replace" | "append" | "upsert", matchPrefix?: string) {
		const key = slug(topic);
		if (!key) throw new Error("The topic needs at least one letter or number.");
		const previous = await this.getNote(topic);
		let newText = mode === "append" && previous ? `${previous.text}\n\n${text}` : text;
		const replaced: string[] = [];
		if (mode === "upsert") {
			if (!matchPrefix) throw new Error('mode "upsert" needs match_prefix.');
			if (text.includes("\n")) throw new Error('mode "upsert" saves a single line; remove the line breaks.');
			if (!text.startsWith(matchPrefix)) {
				throw new Error(`The text must start with match_prefix ("${matchPrefix}") so the next save finds it.`);
			}
			const lines = previous ? previous.text.split("\n") : [];
			const out: string[] = [];
			for (const line of lines) {
				if (!line.startsWith(matchPrefix)) out.push(line);
				else if (replaced.push(line) === 1) out.push(text);
			}
			if (!replaced.length) newText = previous ? `${previous.text}\n\n${text}` : text;
			else newText = replaced.length > 1 ? out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() : out.join("\n");
		}
		if (newText.length > MAX_NOTE_CHARS) {
			throw new Error(
				`That would make "${topic}" ${newText.length} characters; the limit is ${MAX_NOTE_CHARS}. Trim it or split it into another topic.`,
			);
		}
		const note: PlanNote = { topic: previous?.topic ?? topic.trim(), text: newText, updated_at: new Date().toISOString() };
		await this.kv.put(`${PLAN_PREFIX}${key}`, JSON.stringify(note));
		return { note, previous, replaced };
	}

	async deleteNote(topic: string) {
		const previous = await this.getNote(topic);
		if (previous) await this.kv.delete(`${PLAN_PREFIX}${slug(topic)}`);
		return previous;
	}
}
