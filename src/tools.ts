import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { addDays, occurrences } from "./forecast";
import { type BudgetStore, MAX_NOTE_CHARS } from "./store";
import {
	type CategoryWrite,
	fromMilliunits,
	SCHEDULED_FREQUENCIES,
	type ScheduledTransactionWrite,
	toMilliunits,
	type TransactionWrite,
	type YnabAccount,
	type YnabCategory,
	type YnabClient,
	YnabError,
	type YnabScheduledTransaction,
	type YnabTransaction,
} from "./ynab";

// ---------- shared schema pieces ----------

const planId = z
	.string()
	.optional()
	.describe(
		'YNAB plan ID. Omit to use the plan you last opened in YNAB ("last-used"). Use list_plans to see IDs.',
	);

const isoDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
	.describe("Date as YYYY-MM-DD");

const monthParam = z
	.string()
	.regex(/^(current|\d{4}-\d{2}(-01)?)$/, 'Use "current" or YYYY-MM')
	.default("current")
	.describe('Month as YYYY-MM, or "current"');

const direction = z
	.enum(["outflow", "inflow"])
	.describe('"outflow" for money spent (most transactions), "inflow" for money received');

const cleared = z.enum(["cleared", "uncleared", "reconciled"]);

const flagColor = z
	.enum(["red", "orange", "yellow", "green", "blue", "purple"])
	.nullable()
	.describe("Flag color, or null to remove the flag");

// ---------- helpers ----------

type ToolResult = {
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
};

function ok(data: unknown): ToolResult {
	return { content: [{ type: "text", text: JSON.stringify(data, null, 1) }] };
}

function fail(error: unknown): ToolResult {
	const message =
		error instanceof YnabError || error instanceof ToolInputError
			? error.message
			: `Unexpected error: ${error instanceof Error ? error.message : String(error)}`;
	return { content: [{ type: "text", text: message }], isError: true };
}

class ToolInputError extends Error {}

function wrap<A>(fn: (args: A) => Promise<unknown>) {
	return async (args: A): Promise<ToolResult> => {
		try {
			return ok(await fn(args));
		} catch (error) {
			return fail(error);
		}
	};
}

function resolvePlan(id?: string) {
	return id && id.trim() ? id.trim() : "last-used";
}

function normalizeMonth(month: string) {
	if (month === "current") return "current";
	return month.length === 7 ? `${month}-01` : month;
}

function daysAgo(days: number) {
	const d = new Date(Date.now() - days * 86_400_000);
	return d.toISOString().slice(0, 10);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function norm(s: string) {
	return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Find one item by ID or (case-insensitive) name; error with suggestions if not unique. */
function pickOne<T extends { id: string }>(
	items: T[],
	query: string,
	label: string,
	nameOf: (item: T) => string[],
): T {
	if (UUID.test(query.trim())) {
		const byId = items.find((i) => i.id === query.trim());
		if (byId) return byId;
		throw new ToolInputError(`No ${label} with ID ${query}.`);
	}
	const q = norm(query);
	const exact = items.filter((i) => nameOf(i).some((n) => norm(n) === q));
	if (exact.length === 1) return exact[0];
	const partial = exact.length ? exact : items.filter((i) => nameOf(i).some((n) => norm(n).includes(q)));
	if (partial.length === 1) return partial[0];
	if (partial.length === 0) {
		throw new ToolInputError(
			`No ${label} matches "${query}". Use the list tool to see the exact names.`,
		);
	}
	const options = partial
		.slice(0, 10)
		.map((i) => `${nameOf(i)[nameOf(i).length - 1]} (${i.id})`)
		.join("; ");
	throw new ToolInputError(
		`"${query}" matches more than one ${label}: ${options}. Use the full name or the ID.`,
	);
}

/** Lazily loads accounts and categories once per tool call. */
class Lookup {
	private accounts?: YnabAccount[];
	private categories?: Array<YnabCategory & { group: string }>;

	constructor(
		private ynab: YnabClient,
		private plan: string,
	) {}

	async account(query: string) {
		this.accounts ??= (await this.ynab.listAccounts(this.plan)).filter(
			(a) => !a.deleted && !a.closed,
		);
		return pickOne(this.accounts, query, "open account", (a) => [a.name]);
	}

	async category(query: string) {
		if (!this.categories) {
			const groups = await this.ynab.listCategoryGroups(this.plan);
			this.categories = groups
				.filter((g) => !g.deleted)
				.flatMap((g) =>
					g.categories.filter((c) => !c.deleted).map((c) => ({ ...c, group: g.name })),
				);
		}
		return pickOne(this.categories, query, "category", (c) => [
			`${c.group}: ${c.name}`,
			c.name,
		]);
	}
}

function signedMilliunits(amount: number, dir: "outflow" | "inflow") {
	const magnitude = Math.abs(toMilliunits(amount));
	return dir === "outflow" ? -magnitude : magnitude;
}

function money(m: number | null | undefined) {
	return fromMilliunits(m);
}

function simplifyTransaction(t: YnabTransaction) {
	return {
		id: t.id,
		date: t.date,
		amount: money(t.amount),
		payee: t.payee_name ?? null,
		category: t.category_name ?? null,
		account: t.account_name ?? t.account_id,
		memo: t.memo ?? null,
		cleared: t.cleared,
		approved: t.approved,
		flag: t.flag_color ?? null,
		...(t.transfer_account_id ? { transfer_account_id: t.transfer_account_id } : {}),
		...(t.subtransactions && t.subtransactions.length
			? {
					splits: t.subtransactions
						.filter((s) => !s.deleted)
						.map((s) => ({
							amount: money(s.amount),
							category: s.category_name ?? null,
							payee: s.payee_name ?? null,
							memo: s.memo ?? null,
						})),
				}
			: {}),
	};
}

/**
 * Human-readable repeat interval for a target, from YNAB's goal_cadence fields.
 * Cadence 0, 1, 2 and 13 (none, monthly, weekly, yearly) are multiplied by goal_cadence_frequency;
 * 3-12 mean every 2-11 months and 14 means every 2 years, with frequency ignored.
 */
function repeatLabel(cadence: number, frequency: number): string {
	const every = (n: number, unit: string) => (n === 1 ? `every ${unit}` : `every ${n} ${unit}s`);
	if (cadence === 0) return "never";
	if (cadence === 1) return every(frequency, "month");
	if (cadence === 2) return every(frequency, "week");
	if (cadence === 13) return every(frequency, "year");
	if (cadence >= 3 && cadence <= 12) return every(cadence - 1, "month");
	if (cadence === 14) return every(2, "year");
	return `unknown (cadence ${cadence})`;
}

function simplifyCategory(c: YnabCategory & { group?: string }) {
	return {
		id: c.id,
		group: c.group ?? c.category_group_name ?? null,
		name: c.name,
		assigned: money(c.budgeted),
		activity: money(c.activity),
		available: money(c.balance),
		...(c.goal_type
			? {
					goal: {
						type: c.goal_type,
						target: money(c.goal_target),
						percent_complete: c.goal_percentage_complete ?? null,
						underfunded: money(c.goal_under_funded),
						...(c.goal_target_date || c.goal_target_month
							? { target_date: c.goal_target_date ?? c.goal_target_month }
							: {}),
						...(typeof c.goal_needs_whole_amount === "boolean"
							? { mode: c.goal_needs_whole_amount ? "set_aside" : "refill" }
							: {}),
						...(typeof c.goal_cadence === "number"
							? { repeats: repeatLabel(c.goal_cadence, c.goal_cadence_frequency ?? 1) }
							: {}),
					},
				}
			: {}),
		...(c.hidden ? { hidden: true } : {}),
		...(c.note ? { note: c.note } : {}),
	};
}

// ---------- tool registration ----------

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

export function registerYnabTools(rawServer: McpServer, ynab: YnabClient, store?: BudgetStore) {
	// Every tool not marked read-only is recorded in the change log (fork addition).
	const server = withChangeLog(rawServer, store);

	// ----- Read tools -----

	server.registerTool(
		"list_plans",
		{
			title: "List plans",
			description:
				"List the YNAB plans (formerly called budgets) on this account, with their IDs and currency.",
			inputSchema: z.object({}),
			annotations: READ,
		},
		wrap(async () => {
			const { plans, default_plan } = await ynab.listPlans();
			return {
				default_plan: default_plan ? { id: default_plan.id, name: default_plan.name } : null,
				plans: plans.map((p) => ({
					id: p.id,
					name: p.name,
					last_modified_on: p.last_modified_on,
					currency: p.currency_format?.iso_code,
				})),
			};
		}),
	);

	server.registerTool(
		"get_plan_overview",
		{
			title: "Plan overview",
			description:
				"Snapshot of a month: Ready to Assign, income, assigned, activity, age of money, overspent categories, and account balances. Start here for questions like 'how am I doing this month?'.",
			inputSchema: z.object({ plan_id: planId, month: monthParam }),
			annotations: READ,
		},
		wrap(async ({ plan_id, month }) => {
			const plan = resolvePlan(plan_id);
			const [m, accounts] = await Promise.all([
				ynab.getMonth(plan, normalizeMonth(month)),
				ynab.listAccounts(plan),
			]);
			const open = accounts.filter((a) => !a.deleted && !a.closed);
			return {
				month: m.month,
				ready_to_assign: money(m.to_be_budgeted),
				income: money(m.income),
				assigned: money(m.budgeted),
				activity: money(m.activity),
				age_of_money_days: m.age_of_money ?? null,
				overspent_categories: m.categories
					.filter((c) => !c.deleted && c.balance < 0)
					.map((c) => ({ name: c.name, available: money(c.balance) })),
				accounts: open.map((a) => ({
					name: a.name,
					type: a.type,
					on_budget: a.on_budget,
					balance: money(a.balance),
				})),
				net_worth: money(open.reduce((sum, a) => sum + a.balance, 0)),
			};
		}),
	);

	server.registerTool(
		"list_accounts",
		{
			title: "List accounts",
			description: "List accounts with IDs, types and balances (cleared and uncleared).",
			inputSchema: z.object({
				plan_id: planId,
				include_closed: z.boolean().default(false).describe("Include closed accounts"),
			}),
			annotations: READ,
		},
		wrap(async ({ plan_id, include_closed }) => {
			const accounts = await ynab.listAccounts(resolvePlan(plan_id));
			return accounts
				.filter((a) => !a.deleted && (include_closed || !a.closed))
				.map((a) => ({
					id: a.id,
					name: a.name,
					type: a.type,
					on_budget: a.on_budget,
					closed: a.closed,
					balance: money(a.balance),
					cleared_balance: money(a.cleared_balance),
					uncleared_balance: money(a.uncleared_balance),
				}));
		}),
	);

	server.registerTool(
		"list_categories",
		{
			title: "List categories",
			description:
				"List category groups and categories for a month, with assigned, activity, available and goal progress. Use this to find category names or IDs.",
			inputSchema: z.object({
				plan_id: planId,
				month: monthParam,
				include_hidden: z.boolean().default(false).describe("Include hidden categories"),
			}),
			annotations: READ,
		},
		wrap(async ({ plan_id, month, include_hidden }) => {
			const plan = resolvePlan(plan_id);
			const [groups, m] = await Promise.all([
				ynab.listCategoryGroups(plan),
				ynab.getMonth(plan, normalizeMonth(month)),
			]);
			const monthById = new Map(m.categories.map((c) => [c.id, c]));
			return {
				month: m.month,
				groups: groups
					.filter((g) => !g.deleted && (include_hidden || !g.hidden))
					.filter((g) => g.name !== "Internal Master Category")
					.map((g) => ({
						group: g.name,
						categories: g.categories
							.filter((c) => !c.deleted && (include_hidden || !c.hidden))
							.map((c) => simplifyCategory({ ...(monthById.get(c.id) ?? c), group: g.name })),
					})),
			};
		}),
	);

	server.registerTool(
		"list_payees",
		{
			title: "List payees",
			description: "List payees, optionally filtered by a search term.",
			inputSchema: z.object({
				plan_id: planId,
				search: z.string().optional().describe("Only return payees whose name contains this"),
			}),
			annotations: READ,
		},
		wrap(async ({ plan_id, search }) => {
			const payees = await ynab.listPayees(resolvePlan(plan_id));
			const q = search ? norm(search) : null;
			return payees
				.filter((p) => !p.deleted && (!q || norm(p.name).includes(q)))
				.map((p) => ({
					id: p.id,
					name: p.name,
					...(p.transfer_account_id ? { transfer_account_id: p.transfer_account_id } : {}),
				}));
		}),
	);

	server.registerTool(
		"list_transactions",
		{
			title: "List transactions",
			description:
				"List transactions in a date range (defaults to the last 30 days), optionally for one account, category or payee, or only uncategorized/unapproved ones. Amounts are negative for outflows. Returns newest first.",
			inputSchema: z.object({
				plan_id: planId,
				since_date: isoDate.optional().describe("Start date YYYY-MM-DD (default: 30 days ago)"),
				until_date: isoDate.optional().describe("End date YYYY-MM-DD (default: today)"),
				account: z.string().optional().describe("Account name or ID"),
				category: z
					.string()
					.optional()
					.describe('Category name ("Groceries" or "Everyday: Groceries") or ID'),
				payee_id: z.string().optional().describe("Payee ID (from list_payees)"),
				payee_search: z
					.string()
					.optional()
					.describe("Only keep transactions whose payee name contains this text"),
				only: z
					.enum(["uncategorized", "unapproved"])
					.optional()
					.describe("Only uncategorized or only unapproved transactions"),
				limit: z.number().int().min(1).max(500).default(100).describe("Max rows to return"),
			}),
			annotations: READ,
		},
		wrap(async (args) => {
			const plan = resolvePlan(args.plan_id);
			const lookup = new Lookup(ynab, plan);
			const accountId = args.account ? (await lookup.account(args.account)).id : undefined;
			const categoryId =
				!accountId && args.category ? (await lookup.category(args.category)).id : undefined;
			const categoryFilterId =
				accountId && args.category ? (await lookup.category(args.category)).id : undefined;

			let rows = await ynab.listTransactions(plan, {
				sinceDate: args.since_date ?? daysAgo(30),
				untilDate: args.until_date,
				type: args.only,
				accountId,
				categoryId,
				payeeId: !accountId && !categoryId ? args.payee_id : undefined,
			});

			rows = rows.filter((t) => !t.deleted);
			if (categoryFilterId)
				rows = rows.filter(
					(t) =>
						t.category_id === categoryFilterId ||
						t.subtransactions?.some((s) => s.category_id === categoryFilterId),
				);
			if (args.payee_id && (accountId || categoryId))
				rows = rows.filter((t) => t.payee_id === args.payee_id);
			if (args.payee_search) {
				const q = norm(args.payee_search);
				rows = rows.filter((t) => norm(t.payee_name ?? "").includes(q));
			}

			rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
			const total = rows.reduce((sum, t) => sum + t.amount, 0);
			return {
				count: rows.length,
				returned: Math.min(rows.length, args.limit),
				total_amount: money(total),
				transactions: rows.slice(0, args.limit).map(simplifyTransaction),
			};
		}),
	);

	server.registerTool(
		"get_transaction",
		{
			title: "Get transaction",
			description: "Get one transaction by ID, including any splits.",
			inputSchema: z.object({ plan_id: planId, transaction_id: z.string() }),
			annotations: READ,
		},
		wrap(async ({ plan_id, transaction_id }) =>
			simplifyTransaction(await ynab.getTransaction(resolvePlan(plan_id), transaction_id)),
		),
	);

	// ----- Write tools -----

	const newTransaction = z.object({
		account: z.string().describe("Account name or ID"),
		date: isoDate.describe("Transaction date YYYY-MM-DD"),
		amount: z.number().positive().describe("Amount as a positive number, e.g. 12.34"),
		direction: direction.default("outflow"),
		payee_name: z
			.string()
			.max(200)
			.optional()
			.describe("Payee name. YNAB matches existing payees or creates a new one."),
		category: z
			.string()
			.optional()
			.describe('Category name or ID. Omit to leave uncategorized. Use "Inflow: Ready to Assign" for income.'),
		memo: z.string().max(500).optional(),
		cleared: cleared.default("uncleared"),
		approved: z.boolean().default(true),
		flag_color: flagColor.optional(),
		splits: z
			.array(
				z.object({
					amount: z.number().positive().describe("Positive amount for this split"),
					category: z.string().optional().describe("Category name or ID"),
					payee_name: z.string().max(200).optional(),
					memo: z.string().max(500).optional(),
				}),
			)
			.optional()
			.describe(
				"Optional split across categories. Split amounts must add up to the total amount; they take the same direction.",
			),
	});

	server.registerTool(
		"create_transactions",
		{
			title: "Add transactions",
			description:
				"Add one or more transactions (up to 50 at once). Give amounts as positive numbers and set direction to outflow (spending) or inflow (income/refunds). Accounts and categories can be given by name.",
			inputSchema: z.object({
				plan_id: planId,
				transactions: z.array(newTransaction).min(1).max(50),
			}),
			annotations: WRITE,
		},
		wrap(async ({ plan_id, transactions }) => {
			const plan = resolvePlan(plan_id);
			const lookup = new Lookup(ynab, plan);
			const payload: TransactionWrite[] = [];

			for (const t of transactions) {
				const account = await lookup.account(t.account);
				const amount = signedMilliunits(t.amount, t.direction);
				const write: TransactionWrite = {
					account_id: account.id,
					date: t.date,
					amount,
					payee_name: t.payee_name ?? null,
					memo: t.memo ?? null,
					cleared: t.cleared,
					approved: t.approved,
					...(t.flag_color !== undefined ? { flag_color: t.flag_color } : {}),
				};

				if (t.splits && t.splits.length) {
					const splitTotal = t.splits.reduce((s, x) => s + Math.abs(toMilliunits(x.amount)), 0);
					if (splitTotal !== Math.abs(amount)) {
						throw new ToolInputError(
							`Splits add up to ${fromMilliunits(splitTotal)} but the transaction amount is ${t.amount}.`,
						);
					}
					write.category_id = null;
					write.subtransactions = [];
					for (const s of t.splits) {
						write.subtransactions.push({
							amount: signedMilliunits(s.amount, t.direction),
							category_id: s.category ? (await lookup.category(s.category)).id : null,
							payee_name: s.payee_name ?? null,
							memo: s.memo ?? null,
						});
					}
				} else if (t.category) {
					write.category_id = (await lookup.category(t.category)).id;
				}
				payload.push(write);
			}

			const result = await ynab.createTransactions(plan, payload);
			return {
				created: result.transactions.length,
				transactions: result.transactions.map(simplifyTransaction),
				...(result.duplicate_import_ids.length
					? { skipped_duplicates: result.duplicate_import_ids }
					: {}),
			};
		}),
	);

	server.registerTool(
		"update_transaction",
		{
			title: "Edit a transaction",
			description:
				"Change fields on one existing transaction. Only the fields you pass are changed. To change the amount, pass amount and direction together.",
			inputSchema: z.object({
				plan_id: planId,
				transaction_id: z.string(),
				account: z.string().optional().describe("Move to this account (name or ID)"),
				date: isoDate.optional(),
				amount: z.number().positive().optional().describe("New amount as a positive number"),
				direction: direction
					.optional()
					.describe("Required with amount: outflow (spending) or inflow"),
				payee_name: z.string().max(200).optional(),
				category: z
					.string()
					.nullable()
					.optional()
					.describe("Category name or ID, or null to make it uncategorized"),
				memo: z.string().max(500).nullable().optional(),
				cleared: cleared.optional(),
				approved: z.boolean().optional(),
				flag_color: flagColor.optional(),
			}),
			annotations: WRITE,
		},
		wrap(async (args) => {
			const plan = resolvePlan(args.plan_id);
			const lookup = new Lookup(ynab, plan);
			const existing = await ynab.getTransaction(plan, args.transaction_id);

			if (args.amount !== undefined && !args.direction) {
				throw new ToolInputError(
					`Pass direction ("outflow" or "inflow") with the amount. The current amount is ${fromMilliunits(existing.amount)}.`,
				);
			}

			// YNAB's PUT replaces the transaction, so start from the existing values.
			const write: TransactionWrite = {
				account_id: existing.account_id,
				date: existing.date,
				amount: existing.amount,
				payee_id: existing.payee_id ?? null,
				category_id: existing.category_id ?? null,
				memo: existing.memo ?? null,
				cleared: existing.cleared,
				approved: existing.approved,
				flag_color: existing.flag_color ?? null,
			};

			if (args.account) write.account_id = (await lookup.account(args.account)).id;
			if (args.date) write.date = args.date;
			if (args.amount !== undefined && args.direction)
				write.amount = signedMilliunits(args.amount, args.direction);
			if (args.payee_name !== undefined) {
				write.payee_id = null;
				write.payee_name = args.payee_name;
			}
			if (args.category !== undefined)
				write.category_id = args.category === null ? null : (await lookup.category(args.category)).id;
			if (args.memo !== undefined) write.memo = args.memo;
			if (args.cleared) write.cleared = args.cleared;
			if (args.approved !== undefined) write.approved = args.approved;
			if (args.flag_color !== undefined) write.flag_color = args.flag_color;

			if (
				existing.subtransactions?.some((s) => !s.deleted) &&
				(args.amount !== undefined || args.category !== undefined)
			) {
				throw new ToolInputError(
					"This is a split transaction. YNAB's API can't change the amount or category of an existing split; edit it in YNAB, or delete it and add it again with new splits.",
				);
			}

			const updated = await ynab.updateTransaction(plan, args.transaction_id, write);
			return { previous: simplifyTransaction(existing), updated: simplifyTransaction(updated) };
		}),
	);

	server.registerTool(
		"bulk_update_transactions",
		{
			title: "Edit many transactions",
			description:
				"Apply changes to many transactions in one call (up to 100), e.g. approve a batch, categorize several, set cleared status, or flag them. Each item names a transaction ID and only the fields to change.",
			inputSchema: z.object({
				plan_id: planId,
				updates: z
					.array(
						z.object({
							transaction_id: z.string(),
							category: z.string().nullable().optional().describe("Category name or ID, or null"),
							payee_name: z.string().max(200).optional(),
							memo: z.string().max(500).nullable().optional(),
							cleared: cleared.optional(),
							approved: z.boolean().optional(),
							flag_color: flagColor.optional(),
						}),
					)
					.min(1)
					.max(100),
			}),
			annotations: WRITE,
		},
		wrap(async ({ plan_id, updates }) => {
			const plan = resolvePlan(plan_id);
			const lookup = new Lookup(ynab, plan);
			const payload: TransactionWrite[] = [];
			for (const u of updates) {
				const w: TransactionWrite = { id: u.transaction_id };
				if (u.category !== undefined)
					w.category_id = u.category === null ? null : (await lookup.category(u.category)).id;
				if (u.payee_name !== undefined) w.payee_name = u.payee_name;
				if (u.memo !== undefined) w.memo = u.memo;
				if (u.cleared) w.cleared = u.cleared;
				if (u.approved !== undefined) w.approved = u.approved;
				if (u.flag_color !== undefined) w.flag_color = u.flag_color;
				payload.push(w);
			}
			const updated = await ynab.updateTransactions(plan, payload);
			return { updated: updated.length, transactions: updated.map(simplifyTransaction) };
		}),
	);

	server.registerTool(
		"delete_transaction",
		{
			title: "Delete a transaction",
			description:
				"Delete one transaction. This cannot be undone from here, so confirm with the user first.",
			inputSchema: z.object({ plan_id: planId, transaction_id: z.string() }),
			annotations: DESTRUCTIVE,
		},
		wrap(async ({ plan_id, transaction_id }) => {
			const deleted = await ynab.deleteTransaction(resolvePlan(plan_id), transaction_id);
			return { deleted: simplifyTransaction(deleted) };
		}),
	);

	server.registerTool(
		"assign_to_category",
		{
			title: "Assign money to a category",
			description:
				"Set the amount assigned (budgeted) to a category for a month. This sets the total for the month, not an increment: to add $50 to a category with $100 assigned, pass 150. Negative totals are allowed. To move money between categories, lower the source's total and raise the destination's by the same amount (two calls).",
			inputSchema: z.object({
				plan_id: planId,
				month: monthParam,
				category: z.string().describe("Category name or ID"),
				assigned: z
					.number()
					.describe("New total assigned for the month, e.g. 150. Can be negative, e.g. -50."),
			}),
			annotations: WRITE,
		},
		wrap(async ({ plan_id, month, category, assigned }) => {
			const plan = resolvePlan(plan_id);
			const cat = await new Lookup(ynab, plan).category(category);
			const before = await ynab.getMonthCategory(plan, normalizeMonth(month), cat.id);
			const updated = await ynab.setCategoryBudgeted(
				plan,
				normalizeMonth(month),
				cat.id,
				toMilliunits(assigned),
			);
			return {
				previous_assigned: money(before.budgeted),
				updated: simplifyCategory({ ...updated, group: cat.group }),
			};
		}),
	);

	registerMonthHistoryTools(server, ynab);
	registerScheduledTransactionTools(server, ynab);
	registerCategoryTools(server, ynab);
	registerDailyTools(server, ynab);
	registerPlanningTools(server, ynab, store);
}

// ---------- category edits: rename, organize, targets ----------

/** Find a user-visible category group by name or ID. */
async function findGroup(ynab: YnabClient, plan: string, query: string) {
	const groups = (await ynab.listCategoryGroups(plan)).filter(
		(g) => !g.deleted && !g.internal && g.name !== "Internal Master Category",
	);
	return pickOne(groups, query, "category group", (g) => [g.name]);
}

function registerCategoryTools(server: McpServer, ynab: YnabClient) {
	server.registerTool(
		"update_category",
		{
			title: "Rename or edit a category",
			description:
				"Rename a category, change its note, or move it to another category group. Pass only what should change. The category keeps its transactions, assigned amounts and target. (YNAB's API can't hide or delete categories.)",
			inputSchema: z.object({
				plan_id: planId,
				category: z.string().describe("Current category name or ID"),
				new_name: z.string().trim().min(1).max(200).optional().describe("New name"),
				note: z.string().max(500).nullable().optional().describe("New note, or null to clear it"),
				move_to_group: z.string().optional().describe("Category group name or ID to move it into"),
			}),
			annotations: WRITE,
		},
		wrap(async ({ plan_id, category, new_name, note, move_to_group }) => {
			const plan = resolvePlan(plan_id);
			const cat = await new Lookup(ynab, plan).category(category);
			const write: CategoryWrite = {};
			let group = cat.group;
			if (new_name !== undefined && new_name !== cat.name) write.name = new_name;
			if (note !== undefined) write.note = note;
			if (move_to_group) {
				const g = await findGroup(ynab, plan, move_to_group);
				if (g.id !== cat.category_group_id) {
					write.category_group_id = g.id;
					group = g.name;
				}
			}
			if (!Object.keys(write).length) {
				throw new ToolInputError("Nothing to change: pass new_name, note or move_to_group with a different value.");
			}
			const updated = await ynab.updateCategory(plan, cat.id, write);
			return {
				previous: { name: `${cat.group}: ${cat.name}`, ...(cat.note ? { note: cat.note } : {}) },
				updated: simplifyCategory({ ...updated, group }),
			};
		}),
	);

	server.registerTool(
		"create_category",
		{
			title: "Add a category",
			description:
				"Add a new category to an existing category group, optionally with a monthly target amount (use set_category_target for other target options).",
			inputSchema: z.object({
				plan_id: planId,
				name: z.string().trim().min(1).max(200),
				group: z.string().describe("Category group name or ID"),
				note: z.string().max(500).optional(),
				target_amount: z.number().positive().optional().describe("Optional monthly target, e.g. 50"),
			}),
			annotations: WRITE,
		},
		wrap(async ({ plan_id, name, group, note, target_amount }) => {
			const plan = resolvePlan(plan_id);
			const g = await findGroup(ynab, plan, group);
			const created = await ynab.createCategory(plan, {
				name,
				category_group_id: g.id,
				...(note ? { note } : {}),
				...(target_amount !== undefined ? { goal_target: toMilliunits(target_amount) } : {}),
			});
			return { created: simplifyCategory({ ...created, group: g.name }) };
		}),
	);

	server.registerTool(
		"create_category_group",
		{
			title: "Add a category group",
			description: "Add a new, empty category group. Then use create_category or update_category to fill it.",
			inputSchema: z.object({
				plan_id: planId,
				name: z.string().trim().min(1).max(50).describe("Group name, up to 50 characters"),
			}),
			annotations: WRITE,
		},
		wrap(async ({ plan_id, name }) => {
			const created = await ynab.createCategoryGroup(resolvePlan(plan_id), name);
			return { created: { id: created.id, name: created.name } };
		}),
	);

	server.registerTool(
		"rename_category_group",
		{
			title: "Rename a category group",
			description: "Rename one category group. Its categories stay in it.",
			inputSchema: z.object({
				plan_id: planId,
				group: z.string().describe("Current group name or ID"),
				new_name: z.string().trim().min(1).max(50).describe("New name, up to 50 characters"),
			}),
			annotations: WRITE,
		},
		wrap(async ({ plan_id, group, new_name }) => {
			const plan = resolvePlan(plan_id);
			const g = await findGroup(ynab, plan, group);
			if (g.name === new_name) throw new ToolInputError(`The group is already called "${g.name}".`);
			const updated = await ynab.renameCategoryGroup(plan, g.id, new_name);
			return { previous_name: g.name, updated: { id: updated.id, name: updated.name } };
		}),
	);

	server.registerTool(
		"set_category_target",
		{
			title: "Set a category target",
			description:
				"Create, change or remove a category's target (YNAB's goals). Pass only what should change. Setting an amount on a category with no target creates a monthly target. frequency makes a repeating target and replaces the existing one; by_date sets when the amount is needed; mode picks 'set aside' (full amount every period) or 'refill' (top up to the amount). YNAB's API can't create 'have a balance of' targets, and credit card payment and loan categories don't support frequency, by_date or mode.",
			inputSchema: z.object({
				plan_id: planId,
				category: z.string().describe("Category name or ID"),
				amount: z.number().positive().optional().describe("Target amount, e.g. 400"),
				frequency: z
					.enum(["monthly", "weekly", "yearly"])
					.optional()
					.describe("Repeat the target at this frequency. Requires amount; can't be combined with by_date."),
				by_date: isoDate
					.nullable()
					.optional()
					.describe("Date the amount is needed by, YYYY-MM-DD, or null to clear the date"),
				mode: z
					.enum(["set_aside", "refill"])
					.optional()
					.describe('"set_aside": ask for the full amount every period. "refill": top up to the amount.'),
				remove: z.boolean().default(false).describe("Remove the category's target entirely"),
			}),
			annotations: WRITE,
		},
		wrap(async (args) => {
			const plan = resolvePlan(args.plan_id);
			const cat = await new Lookup(ynab, plan).category(args.category);
			const changes = [args.amount, args.frequency, args.by_date, args.mode].filter((v) => v !== undefined);

			let write: CategoryWrite;
			if (args.remove) {
				if (changes.length) throw new ToolInputError("Pass remove on its own, without other target fields.");
				write = { goal_target: null };
			} else {
				if (!changes.length) {
					throw new ToolInputError("Pass at least one of amount, frequency, by_date, mode, or remove.");
				}
				if (args.frequency && args.amount === undefined) {
					throw new ToolInputError("frequency needs an amount as well.");
				}
				if (args.frequency && args.by_date) {
					throw new ToolInputError("Use frequency or by_date, not both.");
				}
				if (!cat.goal_type && args.amount === undefined) {
					throw new ToolInputError(`"${cat.name}" has no target yet, so pass an amount to create one.`);
				}
				write = {};
				if (args.amount !== undefined) write.goal_target = toMilliunits(args.amount);
				if (args.frequency) write.goal_frequency = args.frequency;
				if (args.by_date !== undefined) write.goal_target_date = args.by_date;
				if (args.mode) write.goal_needs_whole_amount = args.mode === "set_aside";
			}

			const updated = await ynab.updateCategory(plan, cat.id, write);
			return {
				...(args.remove ? { removed_target: true } : {}),
				previous_target: cat.goal_type ? simplifyCategory(cat).goal : null,
				updated: simplifyCategory({ ...updated, group: cat.group }),
			};
		}),
	);
}

// ---------- month history ----------

const yearMonth = z.string().regex(/^\d{4}-\d{2}$/, "Use YYYY-MM");

/** First day of the current month (UTC) as YYYY-MM-01. */
function currentMonthStart() {
	return `${new Date().toISOString().slice(0, 7)}-01`;
}

/** Shift a YYYY-MM-01 date by a number of months. */
function addMonths(monthStart: string, delta: number) {
	const [y, m] = monthStart.split("-").map(Number);
	const d = new Date(Date.UTC(y, m - 1 + delta, 1));
	return d.toISOString().slice(0, 10);
}

function registerMonthHistoryTools(server: McpServer, ynab: YnabClient) {
	server.registerTool(
		"get_month_history",
		{
			title: "Month history",
			description:
				"Plan totals for each month in a range (default: the last 12 months, including this one): income, assigned, activity (spending, negative), Ready to Assign and age of money, plus monthly averages. Use for trends like 'how has my spending changed this year?'. For one month in detail, use get_plan_overview.",
			inputSchema: z.object({
				plan_id: planId,
				since_month: yearMonth.optional().describe("First month, YYYY-MM (default: 11 months before until_month)"),
				until_month: yearMonth.optional().describe("Last month, YYYY-MM (default: the current month)"),
			}),
			annotations: READ,
		},
		wrap(async ({ plan_id, since_month, until_month }) => {
			const current = currentMonthStart();
			const until = until_month ? `${until_month}-01` : current;
			const since = since_month ? `${since_month}-01` : addMonths(until, -11);
			if (since > until) {
				throw new ToolInputError(`since_month (${since_month}) is after until_month (${until.slice(0, 7)}).`);
			}

			const months = (await ynab.listMonths(resolvePlan(plan_id)))
				.filter((m) => !m.deleted && m.month >= since && m.month <= until)
				.sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));

			// The current month is still in progress, so leave it out of the averages.
			const complete = months.filter((m) => m.month < current);
			const average = (pick: (m: (typeof months)[number]) => number) =>
				complete.length
					? money(Math.round(complete.reduce((sum, m) => sum + pick(m), 0) / complete.length))
					: null;

			return {
				since: since.slice(0, 7),
				until: until.slice(0, 7),
				averages: {
					months_counted: complete.length,
					note: "Complete months only; the current month is excluded.",
					income: average((m) => m.income),
					assigned: average((m) => m.budgeted),
					activity: average((m) => m.activity),
				},
				months: months.map((m) => ({
					month: m.month.slice(0, 7),
					...(m.month === current ? { in_progress: true } : {}),
					income: money(m.income),
					assigned: money(m.budgeted),
					activity: money(m.activity),
					ready_to_assign: money(m.to_be_budgeted),
					age_of_money_days: m.age_of_money ?? null,
					...(m.note ? { note: m.note } : {}),
				})),
			};
		}),
	);
}

// ---------- scheduled transactions ----------

const frequency = z
	.enum(SCHEDULED_FREQUENCIES)
	.describe('How often it repeats. "never" means a one-time future transaction.');

function daysFromNow(days: number) {
	return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function simplifyScheduled(s: YnabScheduledTransaction) {
	const splits = (s.subtransactions ?? []).filter((x) => !x.deleted);
	return {
		id: s.id,
		next_date: s.date_next,
		first_date: s.date_first,
		frequency: s.frequency,
		amount: money(s.amount),
		payee: s.payee_name ?? null,
		category: s.category_name ?? null,
		account: s.account_name ?? s.account_id,
		memo: s.memo ?? null,
		flag: s.flag_color ?? null,
		...(s.transfer_account_id ? { transfer_account_id: s.transfer_account_id } : {}),
		...(splits.length
			? {
					splits: splits.map((x) => ({
						amount: money(x.amount),
						category: x.category_name ?? null,
						payee: x.payee_name ?? null,
						memo: x.memo ?? null,
					})),
				}
			: {}),
	};
}

function registerScheduledTransactionTools(server: McpServer, ynab: YnabClient) {
	server.registerTool(
		"list_scheduled_transactions",
		{
			title: "List scheduled transactions",
			description:
				"List scheduled (recurring or future-dated) transactions with their next date and frequency, soonest first. Use days_ahead for questions like 'what bills are due in the next two weeks?'. Each schedule appears once, at its next date, even if it repeats within the window. Amounts are negative for outflows.",
			inputSchema: z.object({
				plan_id: planId,
				days_ahead: z
					.number()
					.int()
					.min(0)
					.max(1830)
					.optional()
					.describe("Only schedules whose next date is within this many days from today"),
				account: z.string().optional().describe("Only this account (name or ID)"),
				payee_search: z.string().optional().describe("Only schedules whose payee name contains this"),
			}),
			annotations: READ,
		},
		wrap(async ({ plan_id, days_ahead, account, payee_search }) => {
			const plan = resolvePlan(plan_id);
			const accountId = account ? (await new Lookup(ynab, plan).account(account)).id : undefined;
			const cutoff = days_ahead !== undefined ? daysFromNow(days_ahead) : undefined;
			const q = payee_search ? norm(payee_search) : null;

			const rows = (await ynab.listScheduledTransactions(plan))
				.filter((s) => !s.deleted)
				.filter((s) => !accountId || s.account_id === accountId)
				.filter((s) => !cutoff || s.date_next <= cutoff)
				.filter((s) => !q || norm(s.payee_name ?? "").includes(q))
				.sort((a, b) => (a.date_next < b.date_next ? -1 : a.date_next > b.date_next ? 1 : 0));

			return {
				count: rows.length,
				...(cutoff ? { through: cutoff } : {}),
				scheduled_transactions: rows.map(simplifyScheduled),
			};
		}),
	);

	server.registerTool(
		"create_scheduled_transaction",
		{
			title: "Add a scheduled transaction",
			description:
				"Add a recurring or one-time future transaction. Give the amount as a positive number with direction. For a scheduled transfer between accounts, use transfer_to_account instead of payee_name. YNAB's API can't create split scheduled transactions.",
			inputSchema: z.object({
				plan_id: planId,
				account: z.string().describe("Account name or ID"),
				first_date: isoDate.describe("First occurrence, YYYY-MM-DD. Must be in the future, at most 5 years ahead."),
				frequency,
				amount: z.number().positive().describe("Amount as a positive number, e.g. 12.34"),
				direction: direction.default("outflow"),
				payee_name: z
					.string()
					.max(200)
					.optional()
					.describe("Payee name. YNAB matches existing payees or creates a new one."),
				transfer_to_account: z
					.string()
					.optional()
					.describe("Make this a transfer to this account (name or ID) instead of using payee_name"),
				category: z.string().optional().describe("Category name or ID. Omit to leave uncategorized."),
				memo: z.string().max(500).optional(),
				flag_color: flagColor.optional(),
			}),
			annotations: WRITE,
		},
		wrap(async (args) => {
			const plan = resolvePlan(args.plan_id);
			const lookup = new Lookup(ynab, plan);
			if (args.transfer_to_account && args.payee_name) {
				throw new ToolInputError("Pass payee_name or transfer_to_account, not both.");
			}

			const from = await lookup.account(args.account);
			const write: ScheduledTransactionWrite = {
				account_id: from.id,
				date: args.first_date,
				frequency: args.frequency,
				amount: signedMilliunits(args.amount, args.direction),
				memo: args.memo ?? null,
				...(args.flag_color !== undefined ? { flag_color: args.flag_color } : {}),
			};

			if (args.transfer_to_account) {
				const to = await lookup.account(args.transfer_to_account);
				if (to.id === from.id) throw new ToolInputError("Can't transfer an account to itself.");
				if (!to.transfer_payee_id) {
					throw new ToolInputError(`YNAB didn't return a transfer payee for "${to.name}".`);
				}
				write.payee_id = to.transfer_payee_id;
			} else {
				write.payee_name = args.payee_name ?? null;
			}
			if (args.category) write.category_id = (await lookup.category(args.category)).id;

			const created = await ynab.createScheduledTransaction(plan, write);
			return { created: simplifyScheduled(created) };
		}),
	);

	server.registerTool(
		"update_scheduled_transaction",
		{
			title: "Edit a scheduled transaction",
			description:
				"Change fields on one scheduled transaction. Only the fields you pass are changed. To change the amount, pass amount and direction together. Split scheduled transactions must be edited in YNAB.",
			inputSchema: z.object({
				plan_id: planId,
				scheduled_transaction_id: z.string(),
				account: z.string().optional().describe("Move to this account (name or ID)"),
				next_date: isoDate
					.optional()
					.describe("New next occurrence, YYYY-MM-DD. Must be in the future, at most 5 years ahead."),
				frequency: frequency.optional(),
				amount: z.number().positive().optional().describe("New amount as a positive number"),
				direction: direction.optional().describe("Required with amount: outflow (spending) or inflow"),
				payee_name: z.string().max(200).optional(),
				category: z
					.string()
					.nullable()
					.optional()
					.describe("Category name or ID, or null to make it uncategorized"),
				memo: z.string().max(500).nullable().optional(),
				flag_color: flagColor.optional(),
			}),
			annotations: WRITE,
		},
		wrap(async (args) => {
			const plan = resolvePlan(args.plan_id);
			const lookup = new Lookup(ynab, plan);
			const existing = await ynab.getScheduledTransaction(plan, args.scheduled_transaction_id);

			if (existing.subtransactions?.some((s) => !s.deleted)) {
				throw new ToolInputError(
					"This scheduled transaction is split. YNAB's API doesn't support split scheduled transactions, so saving it from here could drop the splits. Edit it in YNAB instead.",
				);
			}
			if (args.amount !== undefined && !args.direction) {
				throw new ToolInputError(
					`Pass direction ("outflow" or "inflow") with the amount. The current amount is ${fromMilliunits(existing.amount)}.`,
				);
			}

			// YNAB's PUT replaces the scheduled transaction, so start from the existing values.
			const write: ScheduledTransactionWrite = {
				account_id: existing.account_id,
				date: existing.date_next,
				frequency: existing.frequency,
				amount: existing.amount,
				payee_id: existing.payee_id ?? null,
				category_id: existing.category_id ?? null,
				memo: existing.memo ?? null,
				flag_color: existing.flag_color ?? null,
			};

			if (args.account) write.account_id = (await lookup.account(args.account)).id;
			if (args.next_date) write.date = args.next_date;
			if (args.frequency) write.frequency = args.frequency;
			if (args.amount !== undefined && args.direction)
				write.amount = signedMilliunits(args.amount, args.direction);
			if (args.payee_name !== undefined) {
				write.payee_id = null;
				write.payee_name = args.payee_name;
			}
			if (args.category !== undefined)
				write.category_id = args.category === null ? null : (await lookup.category(args.category)).id;
			if (args.memo !== undefined) write.memo = args.memo;
			if (args.flag_color !== undefined) write.flag_color = args.flag_color;

			const updated = await ynab.updateScheduledTransaction(plan, args.scheduled_transaction_id, write);
			return { previous: simplifyScheduled(existing), updated: simplifyScheduled(updated) };
		}),
	);

	server.registerTool(
		"delete_scheduled_transaction",
		{
			title: "Delete a scheduled transaction",
			description:
				"Delete one scheduled transaction, stopping all future occurrences. This cannot be undone from here, so confirm with the user first.",
			inputSchema: z.object({ plan_id: planId, scheduled_transaction_id: z.string() }),
			annotations: DESTRUCTIVE,
		},
		wrap(async ({ plan_id, scheduled_transaction_id }) => {
			const deleted = await ynab.deleteScheduledTransaction(resolvePlan(plan_id), scheduled_transaction_id);
			return { deleted: simplifyScheduled(deleted) };
		}),
	);
}

// ---------- day-to-day: payees, import, reviews, reconcile ----------

// YNAB reserves "Reconciliation Balance Adjustment" and the API rejects it as a payee name.
const ADJUSTMENT_PAYEE = "Market Value Adjustment";

/** A date that is "today" or earlier in every time zone, so YNAB never sees it as future-dated. */
function safeToday() {
	return new Date(Date.now() - 12 * 3_600_000).toISOString().slice(0, 10);
}

function registerDailyTools(server: McpServer, ynab: YnabClient) {
	server.registerTool(
		"rename_payee",
		{
			title: "Rename a payee",
			description:
				"Rename a payee, e.g. clean up 'AMZN MKTP US*2K4' to 'Amazon'. All its transactions show the new name. (YNAB's API can't merge payees; do that in YNAB.)",
			inputSchema: z.object({
				plan_id: planId,
				payee: z.string().describe("Current payee name or ID"),
				new_name: z.string().trim().min(1).max(500),
			}),
			annotations: WRITE,
		},
		wrap(async ({ plan_id, payee, new_name }) => {
			const plan = resolvePlan(plan_id);
			const payees = (await ynab.listPayees(plan)).filter((p) => !p.deleted);
			const p = pickOne(payees, payee, "payee", (x) => [x.name]);
			if (p.transfer_account_id) {
				throw new ToolInputError(`"${p.name}" is a transfer payee; rename the account instead (in YNAB).`);
			}
			if (p.name === new_name) throw new ToolInputError(`The payee is already called "${p.name}".`);
			const updated = await ynab.renamePayee(plan, p.id, new_name);
			return { previous_name: p.name, updated: { id: updated.id, name: updated.name } };
		}),
	);

	server.registerTool(
		"import_transactions",
		{
			title: "Import from linked accounts",
			description:
				"Ask YNAB to pull new transactions from linked (direct import) bank accounts now. Then review them with list_transactions (only: 'unapproved') and categorize/approve with bulk_update_transactions.",
			inputSchema: z.object({ plan_id: planId }),
			annotations: WRITE,
		},
		wrap(async ({ plan_id }) => {
			const ids = await ynab.importTransactions(resolvePlan(plan_id));
			return {
				imported: ids.length,
				transaction_ids: ids,
				next_step: "list_transactions with only: 'unapproved' to review them.",
			};
		}),
	);

	server.registerTool(
		"get_spending_by_category",
		{
			title: "Spending by category",
			description:
				"Net activity per category over a date range (default: this month so far), from one transaction download. Negative = spending; refunds offset it. Transfers between budget accounts are left out; income to Ready to Assign is reported separately. Set by_month for a month-by-month breakdown, e.g. 'groceries per month this year'.",
			inputSchema: z.object({
				plan_id: planId,
				since_date: isoDate.optional().describe("Start date (default: the 1st of this month)"),
				until_date: isoDate.optional().describe("End date (default: today)"),
				by_month: z.boolean().default(false).describe("Also break each category down by month"),
				category: z.string().optional().describe("Only this category (name or ID)"),
			}),
			annotations: READ,
		},
		wrap(async (args) => {
			const plan = resolvePlan(args.plan_id);
			const since = args.since_date ?? currentMonthStart();
			const [txns, groups] = await Promise.all([
				ynab.listTransactions(plan, { sinceDate: since, untilDate: args.until_date }),
				ynab.listCategoryGroups(plan),
			]);
			const catInfo = new Map<string, { label: string; income: boolean }>();
			for (const g of groups) {
				for (const c of g.categories) {
					const internal = g.internal || g.name === "Internal Master Category";
					catInfo.set(c.id, {
						label: internal ? c.name : `${g.name}: ${c.name}`,
						income: internal && c.name.startsWith("Inflow"),
					});
				}
			}
			const onlyId = args.category ? (await new Lookup(ynab, plan).category(args.category)).id : undefined;

			const totals = new Map<string, { total: number; months: Map<string, number> }>();
			let income = 0;
			for (const t of txns) {
				if (t.deleted) continue;
				const subs = (t.subtransactions ?? []).filter((s) => !s.deleted);
				const parts = subs.length ? subs : [t];
				for (const p of parts) {
					if (p.transfer_account_id && !p.category_id) continue; // transfer between budget accounts
					if (onlyId && p.category_id !== onlyId) continue;
					const info = p.category_id ? catInfo.get(p.category_id) : undefined;
					if (info?.income) {
						income += p.amount;
						continue;
					}
					const label = info?.label ?? "Uncategorized";
					const row = totals.get(label) ?? { total: 0, months: new Map() };
					row.total += p.amount;
					const month = t.date.slice(0, 7);
					row.months.set(month, (row.months.get(month) ?? 0) + p.amount);
					totals.set(label, row);
				}
			}

			const rows = [...totals.entries()].sort((a, b) => a[1].total - b[1].total);
			return {
				since,
				until: args.until_date ?? "today",
				total_activity: money(rows.reduce((s, [, r]) => s + r.total, 0)),
				...(onlyId ? {} : { income_to_ready_to_assign: money(income) }),
				categories: rows.map(([label, r]) => ({
					category: label,
					activity: money(r.total),
					...(args.by_month
						? {
								by_month: Object.fromEntries(
									[...r.months.entries()].sort().map(([m, v]) => [m, money(v)]),
								),
							}
						: {}),
				})),
			};
		}),
	);

	server.registerTool(
		"list_money_movements",
		{
			title: "List money movements",
			description:
				"Money moved between categories (and to/from Ready to Assign) in a month, newest first. Use for 'where did I move money from to cover dining?'.",
			inputSchema: z.object({
				plan_id: planId,
				month: monthParam,
				category: z.string().optional().describe("Only movements into or out of this category (name or ID)"),
			}),
			annotations: READ,
		},
		wrap(async ({ plan_id, month, category }) => {
			const plan = resolvePlan(plan_id);
			const [moves, groups] = await Promise.all([
				ynab.listMoneyMovements(plan, normalizeMonth(month)),
				ynab.listCategoryGroups(plan),
			]);
			const names = new Map<string, string>();
			for (const g of groups) for (const c of g.categories) names.set(c.id, `${g.name}: ${c.name}`);
			const name = (id?: string | null) => (id ? (names.get(id) ?? id) : "Ready to Assign");
			const onlyId = category ? (await new Lookup(ynab, plan).category(category)).id : undefined;

			const rows = moves
				.filter((m) => !onlyId || m.from_category_id === onlyId || m.to_category_id === onlyId)
				.sort((a, b) => ((a.moved_at ?? "") < (b.moved_at ?? "") ? 1 : -1));
			return {
				count: rows.length,
				money_movements: rows.map((m) => ({
					moved_at: m.moved_at ?? null,
					month: m.month?.slice(0, 7) ?? null,
					from: name(m.from_category_id),
					to: name(m.to_category_id),
					amount: money(m.amount),
					...(m.note ? { note: m.note } : {}),
				})),
			};
		}),
	);

	server.registerTool(
		"reconcile_account",
		{
			title: "Reconcile an account",
			description:
				"Reconcile an account against the bank's statement balance. If YNAB's cleared balance matches, marks all cleared transactions as reconciled (locked). If it doesn't match, changes nothing and returns the difference and the uncleared transactions so you can find it, unless adjust_difference is true, which first adds a 'Market Value Adjustment' transaction for the difference. Confirm with the user before reconciling, and especially before adjusting.",
			inputSchema: z.object({
				plan_id: planId,
				account: z.string().describe("Account name or ID"),
				statement_balance: z
					.number()
					.describe("Bank's current cleared balance, signed like YNAB shows it: credit card or loan debt is negative, e.g. -512.30"),
				adjust_difference: z
					.boolean()
					.default(false)
					.describe("Add an adjustment transaction if the balances differ. Only after the user agrees."),
				adjustment_date: isoDate.optional().describe("Date for the adjustment (default: today)"),
			}),
			annotations: DESTRUCTIVE,
		},
		wrap(async (args) => {
			const plan = resolvePlan(args.plan_id);
			const lookup = new Lookup(ynab, plan);
			const acct = await lookup.account(args.account);
			const target = toMilliunits(args.statement_balance);
			const difference = target - acct.cleared_balance;
			const txns = (await ynab.listTransactions(plan, { accountId: acct.id })).filter((t) => !t.deleted);

			if (difference !== 0 && !args.adjust_difference) {
				return {
					reconciled: false,
					account: acct.name,
					ynab_cleared_balance: money(acct.cleared_balance),
					statement_balance: args.statement_balance,
					difference: money(difference),
					hint: "Nothing was changed. Check for missing or uncleared transactions below, or a sign mistake (debt is negative). To accept the difference, call again with adjust_difference: true after the user agrees.",
					uncleared_transactions: txns
						.filter((t) => t.cleared === "uncleared")
						.sort((a, b) => (a.date < b.date ? 1 : -1))
						.slice(0, 50)
						.map(simplifyTransaction),
				};
			}

			let adjustment: ReturnType<typeof simplifyTransaction> | undefined;
			if (difference !== 0) {
				const rta = acct.on_budget ? (await lookup.category("Inflow: Ready to Assign")).id : null;
				const result = await ynab.createTransactions(plan, [
					{
						account_id: acct.id,
						date: args.adjustment_date ?? safeToday(),
						amount: difference,
						payee_name: ADJUSTMENT_PAYEE,
						category_id: rta,
						memo: "Entered by the YNAB connector during reconciliation",
						cleared: "reconciled",
						approved: true,
					},
				]);
				adjustment = result.transactions[0] ? simplifyTransaction(result.transactions[0]) : undefined;
			}

			const toLock = txns.filter((t) => t.cleared === "cleared");
			for (let i = 0; i < toLock.length; i += 100) {
				await ynab.updateTransactions(
					plan,
					toLock.slice(i, i + 100).map((t) => ({ id: t.id, cleared: "reconciled" as const })),
				);
			}
			return {
				reconciled: true,
				account: acct.name,
				reconciled_balance: args.statement_balance,
				transactions_locked: toLock.length,
				...(adjustment ? { adjustment } : {}),
			};
		}),
	);
}

// ---------- planning: change log, plan notes, suggestions, review, forecast ----------

/**
 * Wraps registerTool so every successful call to a tool that isn't read-only is
 * recorded in the change log. Logging problems never fail the tool itself.
 */
function withChangeLog(server: McpServer, store?: BudgetStore): McpServer {
	if (!store) return server;
	const target = server as any;
	const shim = {
		registerTool(name: string, config: any, handler: (args: any, extra: any) => Promise<ToolResult>) {
			if (config?.annotations?.readOnlyHint !== false) return target.registerTool(name, config, handler);
			return target.registerTool(name, config, async (args: any, extra: any) => {
				const result = await handler(args, extra);
				if (!result.isError) {
					try {
						const text = result.content[0]?.text ?? "";
						let parsed: unknown = text;
						try {
							parsed = JSON.parse(text);
						} catch {
							// keep the raw text
						}
						await store.recordChange(name, args, parsed);
					} catch (error) {
						console.error("Change log write failed:", error);
					}
				}
				return result;
			});
		},
	};
	return shim as unknown as McpServer;
}

function todayUtc() {
	return new Date().toISOString().slice(0, 10);
}

function categoryLabel(c: YnabCategory) {
	return c.category_group_name ? `${c.category_group_name}: ${c.name}` : c.name;
}

function registerPlanningTools(server: McpServer, ynab: YnabClient, store?: BudgetStore) {
	if (store) {
		server.registerTool(
			"list_recent_changes",
			{
				title: "Recent changes",
				description:
					"Changes made through this connector (from any chat or scheduled task), newest first. Edits made in the YNAB app aren't included. Pass change_id to get one change's full details, including previous values where the tool returned them, e.g. to undo it.",
				inputSchema: z.object({
					days: z.number().int().min(1).max(400).default(7).describe("How far back to look"),
					tool: z.string().optional().describe("Only changes made by this tool, e.g. assign_to_category"),
					limit: z.number().int().min(1).max(200).default(50),
					change_id: z.string().optional().describe("Return the full record of this one change"),
				}),
				annotations: READ,
			},
			wrap(async ({ days, tool, limit, change_id }) => {
				if (change_id) {
					const entry = await store.getChange(change_id);
					if (!entry) throw new ToolInputError(`No change with ID ${change_id}. It may be older than 400 days.`);
					return entry;
				}
				const since = new Date(Date.now() - days * 86_400_000);
				const changes = await store.listChanges(since, tool, limit);
				return {
					since: since.toISOString().slice(0, 10),
					count: changes.length,
					changes,
					...(changes.length ? { next_step: "Pass change_id for the full before/after record." } : {}),
				};
			}),
		);

		server.registerTool(
			"get_plan_notes",
			{
				title: "Read the budget plan",
				description:
					"Read the shared budget plan: goals, rules, priorities and progress notes saved with save_plan_note. Read this before budgeting work (assigning money, reconciling, reviews) and follow its rules.",
				inputSchema: z.object({}),
				annotations: READ,
			},
			wrap(async () => {
				const notes = await store.listNotes();
				return notes.length
					? { notes }
					: {
							notes: [],
							hint: "No plan notes yet. Suggest topics like Rules, Goals, Priorities and Progress, and save them with save_plan_note once the user agrees.",
						};
			}),
		);

		server.registerTool(
			"save_plan_note",
			{
				title: "Save a plan note",
				description:
					"Save a budget plan note under a topic, e.g. Rules, Goals, Priorities or Progress. mode 'replace' overwrites the topic; 'append' adds to the end, which suits dated progress entries. Agree the wording with the user before changing Rules or Goals.",
				inputSchema: z.object({
					topic: z.string().trim().min(1).max(80),
					text: z.string().min(1).max(MAX_NOTE_CHARS),
					mode: z.enum(["replace", "append"]).default("replace"),
				}),
				annotations: WRITE,
			},
			wrap(async ({ topic, text, mode }) => {
				try {
					const { note, previous } = await store.saveNote(topic, text, mode);
					return { saved: note, ...(previous && mode === "replace" ? { previous_text: previous.text } : {}) };
				} catch (error) {
					throw new ToolInputError(error instanceof Error ? error.message : String(error));
				}
			}),
		);

		server.registerTool(
			"delete_plan_note",
			{
				title: "Delete a plan note",
				description: "Delete one plan note topic. Its text is kept in the change log. Confirm with the user first.",
				inputSchema: z.object({ topic: z.string().trim().min(1).max(80) }),
				annotations: DESTRUCTIVE,
			},
			wrap(async ({ topic }) => {
				const previous = await store.deleteNote(topic);
				if (!previous) throw new ToolInputError(`There's no plan note called "${topic}".`);
				return { deleted: previous };
			}),
		);
	}

	server.registerTool(
		"suggest_categories",
		{
			title: "Suggest categories",
			description:
				"List unapproved transactions with a suggested category for each, based on how the same payee was categorized in approved transactions. Use it for the daily approval routine, then apply with bulk_update_transactions (category = category_id, approved: true). Two YNAB requests in total.",
			inputSchema: z.object({
				plan_id: planId,
				history_days: z.number().int().min(30).max(730).default(180).describe("How much history to learn from"),
				limit: z.number().int().min(1).max(200).default(100),
			}),
			annotations: READ,
		},
		wrap(async ({ plan_id, history_days, limit }) => {
			const plan = resolvePlan(plan_id);
			const [unapproved, history] = await Promise.all([
				ynab.listTransactions(plan, { type: "unapproved" }),
				ynab.listTransactions(plan, { sinceDate: daysAgo(history_days) }),
			]);
			const keyOf = (t: YnabTransaction) =>
				t.payee_id ?? (t.payee_name ? `name:${norm(t.payee_name)}` : null);

			const counts = new Map<string, Map<string, { name: string; n: number }>>();
			for (const t of history) {
				if (t.deleted || !t.approved || !t.category_id || t.transfer_account_id) continue;
				if (t.subtransactions?.some((x) => !x.deleted)) continue;
				const key = keyOf(t);
				if (!key) continue;
				const byCat = counts.get(key) ?? new Map();
				const row = byCat.get(t.category_id) ?? { name: t.category_name ?? t.category_id, n: 0 };
				row.n += 1;
				byCat.set(t.category_id, row);
				counts.set(key, byCat);
			}

			const pending = unapproved
				.filter((t) => !t.deleted)
				.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
			const rows = pending.slice(0, limit).map((t) => {
				const base = { ...simplifyTransaction(t), category_id: t.category_id ?? null };
				if (t.transfer_account_id) return { ...base, suggestion: null, note: "Transfer; no category needed." };
				if (t.subtransactions?.some((x) => !x.deleted)) return { ...base, suggestion: null, note: "Split; check in YNAB." };
				const key = keyOf(t);
				const byCat = key ? counts.get(key) : undefined;
				if (!byCat) return { ...base, suggestion: null, note: "No approved history for this payee." };
				let bestId = "";
				let best = { name: "", n: 0 };
				let total = 0;
				for (const [id, row] of byCat) {
					total += row.n;
					if (row.n > best.n) [bestId, best] = [id, row];
				}
				return {
					...base,
					suggestion: {
						category: best.name,
						category_id: bestId,
						basis: `${best.n} of ${total} past transactions`,
						...(t.category_id && t.category_id !== bestId ? { differs_from_current: true } : {}),
					},
				};
			});

			return {
				unapproved: pending.length,
				returned: rows.length,
				history_since: daysAgo(history_days),
				transactions: rows,
			};
		}),
	);

	server.registerTool(
		"get_budget_review",
		{
			title: "Budget review",
			description:
				"One-call check-in for this month: Ready to Assign, overspent categories, underfunded targets, unapproved and uncategorized transactions, and scheduled transactions due in the next days_ahead days. Use it for weekly reviews and scheduled check-ins.",
			inputSchema: z.object({
				plan_id: planId,
				days_ahead: z.number().int().min(1).max(60).default(7).describe("How far ahead to list scheduled transactions"),
			}),
			annotations: READ,
		},
		wrap(async ({ plan_id, days_ahead }) => {
			const plan = resolvePlan(plan_id);
			const [m, accounts, unapproved, scheduled] = await Promise.all([
				ynab.getMonth(plan, "current"),
				ynab.listAccounts(plan),
				ynab.listTransactions(plan, { type: "unapproved" }),
				ynab.listScheduledTransactions(plan),
			]);
			const cats = m.categories.filter(
				(c) => !c.deleted && !c.hidden && c.category_group_name !== "Internal Master Category",
			);
			const overspent = cats.filter((c) => c.balance < 0);
			const underfunded = cats.filter((c) => (c.goal_under_funded ?? 0) > 0);
			const pending = unapproved.filter((t) => !t.deleted);
			const uncategorized = pending.filter(
				(t) => !t.category_id && !t.transfer_account_id && !t.subtransactions?.some((x) => !x.deleted),
			);

			const today = todayUtc();
			const until = addDays(today, days_ahead);
			const upcoming = scheduled
				.filter((s) => !s.deleted)
				.flatMap((s) =>
					occurrences(s, today, until).dates.map((date) => ({
						date,
						amount: money(s.amount),
						payee: s.payee_name ?? null,
						category: s.category_name ?? null,
						account: s.account_name ?? s.account_id,
						milliunits: s.amount,
					})),
				)
				.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

			return {
				month: m.month,
				ready_to_assign: money(m.to_be_budgeted),
				age_of_money_days: m.age_of_money ?? null,
				overspent: overspent.map((c) => ({ category: categoryLabel(c), available: money(c.balance) })),
				underfunded_targets: {
					total_needed: money(underfunded.reduce((s, c) => s + (c.goal_under_funded ?? 0), 0)),
					categories: underfunded.map((c) => ({
						category: categoryLabel(c),
						needed: money(c.goal_under_funded),
						available: money(c.balance),
					})),
				},
				unapproved: {
					count: pending.length,
					uncategorized: uncategorized.length,
					oldest: pending.reduce<string | null>((o, t) => (!o || t.date < o ? t.date : o), null),
				},
				upcoming: {
					through: until,
					outflows: money(upcoming.filter((u) => u.milliunits < 0).reduce((s, u) => s + u.milliunits, 0)),
					inflows: money(upcoming.filter((u) => u.milliunits > 0).reduce((s, u) => s + u.milliunits, 0)),
					transactions: upcoming.map(({ milliunits: _m, ...u }) => u),
				},
				accounts: accounts
					.filter((a) => !a.deleted && !a.closed && a.on_budget)
					.map((a) => ({ name: a.name, type: a.type, balance: money(a.balance) })),
			};
		}),
	);

	server.registerTool(
		"forecast_cash_flow",
		{
			title: "Forecast cash flow",
			description:
				"Project account balances forward from today using scheduled transactions, e.g. 'will Checking dip below $500 before payday?'. Starts from each account's current balance (including uncleared) and applies every scheduled occurrence, including transfers. Only scheduled transactions are counted, not everyday spending. By default covers checking, savings and cash accounts that have scheduled activity.",
			inputSchema: z.object({
				plan_id: planId,
				days: z.number().int().min(1).max(365).default(30),
				account: z.string().optional().describe("Only this account (name or ID)"),
				low_balance: z.number().optional().describe("Flag the first date a balance drops below this, e.g. 500"),
			}),
			annotations: READ,
		},
		wrap(async ({ plan_id, days, account, low_balance }) => {
			const plan = resolvePlan(plan_id);
			const [accounts, scheduled] = await Promise.all([ynab.listAccounts(plan), ynab.listScheduledTransactions(plan)]);
			const open = accounts.filter((a) => !a.deleted && !a.closed);
			const nameOf = new Map(accounts.map((a) => [a.id, a.name]));
			const today = todayUtc();
			const end = addDays(today, days);

			type Event = { date: string; amount: number; payee: string | null; category: string | null };
			const events = new Map<string, Event[]>();
			const push = (id: string, e: Event) => events.set(id, [...(events.get(id) ?? []), e]);
			const approximate = new Set<string>();

			for (const s of scheduled) {
				if (s.deleted) continue;
				const occ = occurrences(s, today, end);
				if (occ.approximate && occ.dates.length) approximate.add(s.payee_name ?? s.id);
				for (const date of occ.dates) {
					push(s.account_id, { date, amount: s.amount, payee: s.payee_name ?? null, category: s.category_name ?? null });
					if (s.transfer_account_id) {
						push(s.transfer_account_id, {
							date,
							amount: -s.amount,
							payee: `Transfer from ${nameOf.get(s.account_id) ?? "another account"}`,
							category: null,
						});
					}
				}
			}

			let selected: YnabAccount[];
			if (account) {
				selected = [await new Lookup(ynab, plan).account(account)];
			} else {
				selected = open.filter(
					(a) => a.on_budget && ["checking", "savings", "cash"].includes(a.type) && events.has(a.id),
				);
				if (!selected.length) selected = open.filter((a) => events.has(a.id));
			}

			return {
				from: today,
				through: end,
				note: "Only scheduled transactions are projected; everyday spending isn't.",
				...(approximate.size
					? {
							approximate_schedules: [...approximate],
							approximate_note:
								"Twice-a-month schedules whose two days couldn't be read from YNAB; dates assume 15 days apart.",
						}
					: {}),
				accounts: selected.map((a) => {
					let running = a.balance;
					let lowest = { balance: running, date: today };
					const threshold = low_balance !== undefined ? toMilliunits(low_balance) : undefined;
					let firstBelow: string | null = threshold !== undefined && running < threshold ? today : null;
					const rows = (events.get(a.id) ?? [])
						.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0))
						.map((e) => {
							running += e.amount;
							if (running < lowest.balance) lowest = { balance: running, date: e.date };
							if (threshold !== undefined && !firstBelow && running < threshold) firstBelow = e.date;
							return { ...e, amount: money(e.amount), balance_after: money(running) };
						});
					return {
						account: a.name,
						type: a.type,
						starting_balance: money(a.balance),
						ending_balance: money(running),
						lowest: { balance: money(lowest.balance), date: lowest.date },
						...(threshold !== undefined ? { first_below_low_balance: firstBelow } : {}),
						events: rows.slice(0, 150),
						...(rows.length > 150 ? { events_truncated: rows.length } : {}),
					};
				}),
			};
		}),
	);
}
