import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
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

export function registerYnabTools(server: McpServer, ynab: YnabClient) {
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
			return { updated: simplifyTransaction(updated) };
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
				"Set the amount assigned (budgeted) to a category for a month. This sets the total for the month, not an increment: to add $50 to a category with $100 assigned, pass 150.",
			inputSchema: z.object({
				plan_id: planId,
				month: monthParam,
				category: z.string().describe("Category name or ID"),
				assigned: z.number().min(0).describe("New total assigned for the month, e.g. 150"),
			}),
			annotations: WRITE,
		},
		wrap(async ({ plan_id, month, category, assigned }) => {
			const plan = resolvePlan(plan_id);
			const cat = await new Lookup(ynab, plan).category(category);
			const updated = await ynab.setCategoryBudgeted(
				plan,
				normalizeMonth(month),
				cat.id,
				toMilliunits(assigned),
			);
			return { updated: simplifyCategory({ ...updated, group: cat.group }) };
		}),
	);

	registerMonthHistoryTools(server, ynab);
	registerScheduledTransactionTools(server, ynab);
	registerCategoryTargetTools(server, ynab);
}

// ---------- category targets ----------

function registerCategoryTargetTools(server: McpServer, ynab: YnabClient) {
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
			return { updated: simplifyScheduled(updated) };
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
