/**
 * Minimal YNAB API client for Cloudflare Workers.
 *
 * YNAB API reference: https://api.ynab.com
 * - Paths use /plans/{plan_id} (YNAB renamed "budgets" to "plans").
 * - Amounts are integers in "milliunits": $12.34 is 12340. Outflows are negative.
 * - Personal access tokens are rate limited (200 requests per hour per token).
 */

const API_BASE = "https://api.ynab.com/v1";

export class YnabError extends Error {
	constructor(
		public status: number,
		public detail: string,
	) {
		super(detail);
		this.name = "YnabError";
	}
}

export type Milliunits = number;

export interface YnabAccount {
	id: string;
	name: string;
	type: string;
	on_budget: boolean;
	closed: boolean;
	balance: Milliunits;
	cleared_balance: Milliunits;
	uncleared_balance: Milliunits;
	deleted: boolean;
	note?: string | null;
	transfer_payee_id?: string | null;
}

export interface YnabCategory {
	id: string;
	category_group_id: string;
	category_group_name?: string;
	name: string;
	hidden: boolean;
	budgeted: Milliunits;
	activity: Milliunits;
	balance: Milliunits;
	goal_type?: string | null;
	goal_target?: Milliunits | null;
	goal_percentage_complete?: number | null;
	goal_under_funded?: Milliunits | null;
	goal_target_date?: string | null;
	goal_target_month?: string | null;
	goal_needs_whole_amount?: boolean | null;
	goal_cadence?: number | null;
	goal_cadence_frequency?: number | null;
	note?: string | null;
	deleted: boolean;
}

/** Category fields accepted by PATCH /categories/{id} (the subset this server uses). */
export interface CategoryWrite {
	name?: string;
	note?: string | null;
	category_group_id?: string;
	goal_target?: Milliunits | null;
	goal_target_date?: string | null;
	goal_needs_whole_amount?: boolean | null;
	goal_frequency?: "monthly" | "weekly" | "yearly";
}

export interface YnabCategoryGroup {
	id: string;
	name: string;
	hidden: boolean;
	internal?: boolean;
	deleted: boolean;
	categories: YnabCategory[];
}

export interface YnabPayee {
	id: string;
	name: string;
	transfer_account_id?: string | null;
	deleted: boolean;
}

export interface YnabSubTransaction {
	id?: string;
	amount: Milliunits;
	memo?: string | null;
	payee_id?: string | null;
	payee_name?: string | null;
	category_id?: string | null;
	category_name?: string | null;
	transfer_account_id?: string | null;
	deleted?: boolean;
}

export interface YnabTransaction {
	id: string;
	date: string;
	amount: Milliunits;
	memo?: string | null;
	cleared: "cleared" | "uncleared" | "reconciled";
	approved: boolean;
	flag_color?: string | null;
	account_id: string;
	account_name?: string;
	payee_id?: string | null;
	payee_name?: string | null;
	category_id?: string | null;
	category_name?: string | null;
	transfer_account_id?: string | null;
	import_id?: string | null;
	deleted: boolean;
	subtransactions?: YnabSubTransaction[];
}

export interface YnabMonth {
	month: string;
	note?: string | null;
	income: Milliunits;
	budgeted: Milliunits;
	activity: Milliunits;
	to_be_budgeted: Milliunits;
	age_of_money?: number | null;
	categories: YnabCategory[];
}

export interface YnabMoneyMovement {
	id: string;
	month?: string | null;
	moved_at?: string | null;
	note?: string | null;
	from_category_id?: string | null;
	to_category_id?: string | null;
	amount: Milliunits;
}

/** One row from GET /months: plan-level totals only, no categories. */
export interface YnabMonthSummary {
	month: string;
	note?: string | null;
	income: Milliunits;
	budgeted: Milliunits;
	activity: Milliunits;
	to_be_budgeted: Milliunits;
	age_of_money?: number | null;
	deleted: boolean;
}

export const SCHEDULED_FREQUENCIES = [
	"never",
	"daily",
	"weekly",
	"everyOtherWeek",
	"twiceAMonth",
	"every4Weeks",
	"monthly",
	"everyOtherMonth",
	"every3Months",
	"every4Months",
	"twiceAYear",
	"yearly",
	"everyOtherYear",
] as const;

export type ScheduledFrequency = (typeof SCHEDULED_FREQUENCIES)[number];

export interface YnabScheduledTransaction {
	id: string;
	date_first: string;
	date_next: string;
	frequency: ScheduledFrequency;
	amount: Milliunits;
	memo?: string | null;
	flag_color?: string | null;
	account_id: string;
	account_name?: string;
	payee_id?: string | null;
	payee_name?: string | null;
	category_id?: string | null;
	category_name?: string | null;
	transfer_account_id?: string | null;
	deleted: boolean;
	subtransactions?: YnabSubTransaction[];
}

/** The fields YNAB accepts when creating or replacing a scheduled transaction. Splits aren't supported. */
export interface ScheduledTransactionWrite {
	account_id: string;
	date: string;
	amount: Milliunits;
	frequency: ScheduledFrequency;
	payee_id?: string | null;
	payee_name?: string | null;
	category_id?: string | null;
	memo?: string | null;
	flag_color?: string | null;
}

/** The fields YNAB accepts when creating or updating a transaction. */
export interface TransactionWrite {
	id?: string;
	account_id?: string;
	date?: string;
	amount?: Milliunits;
	payee_id?: string | null;
	payee_name?: string | null;
	category_id?: string | null;
	memo?: string | null;
	cleared?: "cleared" | "uncleared" | "reconciled";
	approved?: boolean;
	flag_color?: string | null;
	subtransactions?: Array<{
		amount: Milliunits;
		payee_name?: string | null;
		category_id?: string | null;
		memo?: string | null;
	}>;
}

export class YnabClient {
	constructor(private token: string) {
		if (!token) {
			throw new YnabError(
				500,
				"YNAB_ACCESS_TOKEN is not set. Run: npx wrangler secret put YNAB_ACCESS_TOKEN",
			);
		}
	}

	private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
		const response = await fetch(`${API_BASE}${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${this.token}`,
				Accept: "application/json",
				...(body ? { "Content-Type": "application/json" } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
		});

		const text = await response.text();
		let parsed: any = undefined;
		try {
			parsed = text ? JSON.parse(text) : undefined;
		} catch {
			// Non-JSON body; handled below.
		}

		if (!response.ok) {
			if (response.status === 429) {
				throw new YnabError(
					429,
					"YNAB rate limit reached (200 requests per hour per token). Wait a bit and try again.",
				);
			}
			if (response.status === 401) {
				throw new YnabError(
					401,
					"YNAB rejected the access token. It may have been revoked; create a new one in YNAB (Account Settings → Developer Settings) and update the YNAB_ACCESS_TOKEN secret.",
				);
			}
			const err = parsed?.error;
			const detail = err
				? `${err.name ?? "error"}: ${err.detail ?? ""}`.trim()
				: text.slice(0, 300) || response.statusText;
			throw new YnabError(response.status, `YNAB API ${response.status} — ${detail}`);
		}

		return (parsed?.data ?? {}) as T;
	}

	plan(planId: string) {
		return `/plans/${encodeURIComponent(planId)}`;
	}

	async listPlans() {
		const data = await this.request<any>("GET", "/plans");
		return {
			plans: (data.plans ?? data.budgets ?? []) as Array<{
				id: string;
				name: string;
				last_modified_on?: string;
				first_month?: string;
				last_month?: string;
				currency_format?: { iso_code?: string; currency_symbol?: string };
			}>,
			default_plan: data.default_plan ?? data.default_budget ?? null,
		};
	}

	async getSettings(planId: string) {
		const data = await this.request<any>("GET", `${this.plan(planId)}/settings`);
		return data.settings as {
			currency_format?: { iso_code?: string; currency_symbol?: string; decimal_digits?: number };
		};
	}

	async listAccounts(planId: string) {
		const data = await this.request<any>("GET", `${this.plan(planId)}/accounts`);
		return (data.accounts ?? []) as YnabAccount[];
	}

	async listCategoryGroups(planId: string) {
		const data = await this.request<any>("GET", `${this.plan(planId)}/categories`);
		return (data.category_groups ?? []) as YnabCategoryGroup[];
	}

	async listPayees(planId: string) {
		const data = await this.request<any>("GET", `${this.plan(planId)}/payees`);
		return (data.payees ?? []) as YnabPayee[];
	}

	async getMonth(planId: string, month: string) {
		const data = await this.request<any>(
			"GET",
			`${this.plan(planId)}/months/${encodeURIComponent(month)}`,
		);
		return data.month as YnabMonth;
	}

	async listTransactions(
		planId: string,
		opts: {
			/** Omit to fetch the full history (used by reconcile). */
			sinceDate?: string;
			untilDate?: string;
			type?: "uncategorized" | "unapproved";
			accountId?: string;
			categoryId?: string;
			payeeId?: string;
		},
	) {
		let path = `${this.plan(planId)}/transactions`;
		if (opts.accountId) path = `${this.plan(planId)}/accounts/${opts.accountId}/transactions`;
		else if (opts.categoryId)
			path = `${this.plan(planId)}/categories/${opts.categoryId}/transactions`;
		else if (opts.payeeId) path = `${this.plan(planId)}/payees/${opts.payeeId}/transactions`;

		const params = new URLSearchParams();
		if (opts.sinceDate) params.set("since_date", opts.sinceDate);
		if (opts.untilDate) params.set("until_date", opts.untilDate);
		if (opts.type) params.set("type", opts.type);

		const data = await this.request<any>("GET", `${path}?${params}`);
		return (data.transactions ?? []) as YnabTransaction[];
	}

	async getTransaction(planId: string, transactionId: string) {
		const data = await this.request<any>(
			"GET",
			`${this.plan(planId)}/transactions/${encodeURIComponent(transactionId)}`,
		);
		return data.transaction as YnabTransaction;
	}

	async createTransactions(planId: string, transactions: TransactionWrite[]) {
		const data = await this.request<any>("POST", `${this.plan(planId)}/transactions`, {
			transactions,
		});
		return {
			transactions: (data.transactions ?? []) as YnabTransaction[],
			duplicate_import_ids: (data.duplicate_import_ids ?? []) as string[],
		};
	}

	async updateTransaction(planId: string, transactionId: string, transaction: TransactionWrite) {
		const data = await this.request<any>(
			"PUT",
			`${this.plan(planId)}/transactions/${encodeURIComponent(transactionId)}`,
			{ transaction },
		);
		return data.transaction as YnabTransaction;
	}

	async updateTransactions(planId: string, transactions: TransactionWrite[]) {
		const data = await this.request<any>("PATCH", `${this.plan(planId)}/transactions`, {
			transactions,
		});
		return (data.transactions ?? []) as YnabTransaction[];
	}

	async deleteTransaction(planId: string, transactionId: string) {
		const data = await this.request<any>(
			"DELETE",
			`${this.plan(planId)}/transactions/${encodeURIComponent(transactionId)}`,
		);
		return data.transaction as YnabTransaction;
	}

	async setCategoryBudgeted(
		planId: string,
		month: string,
		categoryId: string,
		budgeted: Milliunits,
	) {
		const data = await this.request<any>(
			"PATCH",
			`${this.plan(planId)}/months/${encodeURIComponent(month)}/categories/${encodeURIComponent(categoryId)}`,
			{ category: { budgeted } },
		);
		return data.category as YnabCategory;
	}

	// ----- Category targets -----

	async updateCategory(planId: string, categoryId: string, category: CategoryWrite) {
		const data = await this.request<any>(
			"PATCH",
			`${this.plan(planId)}/categories/${encodeURIComponent(categoryId)}`,
			{ category },
		);
		return data.category as YnabCategory;
	}

	async createCategory(planId: string, category: CategoryWrite & { name: string; category_group_id: string }) {
		const data = await this.request<any>("POST", `${this.plan(planId)}/categories`, { category });
		return data.category as YnabCategory;
	}

	async createCategoryGroup(planId: string, name: string) {
		const data = await this.request<any>("POST", `${this.plan(planId)}/category_groups`, {
			category_group: { name },
		});
		return data.category_group as Omit<YnabCategoryGroup, "categories">;
	}

	async renameCategoryGroup(planId: string, groupId: string, name: string) {
		const data = await this.request<any>(
			"PATCH",
			`${this.plan(planId)}/category_groups/${encodeURIComponent(groupId)}`,
			{ category_group: { name } },
		);
		return data.category_group as Omit<YnabCategoryGroup, "categories">;
	}

	// ----- Payees -----

	async renamePayee(planId: string, payeeId: string, name: string) {
		const data = await this.request<any>(
			"PATCH",
			`${this.plan(planId)}/payees/${encodeURIComponent(payeeId)}`,
			{ payee: { name } },
		);
		return data.payee as YnabPayee;
	}

	// ----- Import, money movements -----

	/** Ask YNAB to import from linked (direct import) accounts now. Returns the new transaction IDs. */
	async importTransactions(planId: string) {
		const data = await this.request<any>("POST", `${this.plan(planId)}/transactions/import`);
		return (data.transaction_ids ?? []) as string[];
	}

	async listMoneyMovements(planId: string, month?: string) {
		const path = month
			? `${this.plan(planId)}/months/${encodeURIComponent(month)}/money_movements`
			: `${this.plan(planId)}/money_movements`;
		const data = await this.request<any>("GET", path);
		return (data.money_movements ?? []) as YnabMoneyMovement[];
	}

	// ----- Month history -----

	async listMonths(planId: string) {
		const data = await this.request<any>("GET", `${this.plan(planId)}/months`);
		return (data.months ?? []) as YnabMonthSummary[];
	}

	// ----- Scheduled transactions -----

	private scheduledPath(planId: string, id?: string) {
		const base = `${this.plan(planId)}/scheduled_transactions`;
		return id ? `${base}/${encodeURIComponent(id)}` : base;
	}

	async listScheduledTransactions(planId: string) {
		const data = await this.request<any>("GET", this.scheduledPath(planId));
		return (data.scheduled_transactions ?? []) as YnabScheduledTransaction[];
	}

	async getScheduledTransaction(planId: string, id: string) {
		const data = await this.request<any>("GET", this.scheduledPath(planId, id));
		return data.scheduled_transaction as YnabScheduledTransaction;
	}

	async createScheduledTransaction(planId: string, write: ScheduledTransactionWrite) {
		const data = await this.request<any>("POST", this.scheduledPath(planId), {
			scheduled_transaction: write,
		});
		return data.scheduled_transaction as YnabScheduledTransaction;
	}

	async updateScheduledTransaction(planId: string, id: string, write: ScheduledTransactionWrite) {
		const data = await this.request<any>("PUT", this.scheduledPath(planId, id), {
			scheduled_transaction: write,
		});
		return data.scheduled_transaction as YnabScheduledTransaction;
	}

	async deleteScheduledTransaction(planId: string, id: string) {
		const data = await this.request<any>("DELETE", this.scheduledPath(planId, id));
		return data.scheduled_transaction as YnabScheduledTransaction;
	}
}

/** Convert a currency amount (e.g. 12.34) to YNAB milliunits (12340). */
export function toMilliunits(amount: number): Milliunits {
	return Math.round(amount * 1000);
}

/** Convert YNAB milliunits (12340) to a currency amount (12.34). */
export function fromMilliunits(milliunits: Milliunits | null | undefined): number | null {
	if (milliunits === null || milliunits === undefined) return null;
	return milliunits / 1000;
}
