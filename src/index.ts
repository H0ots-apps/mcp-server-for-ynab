import { env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { GitHubHandler } from "./github-handler";
import { registerYnabTools } from "./tools";
import { isAllowedUser, type Props } from "./utils";
import { YnabClient } from "./ynab";

const INSTRUCTIONS = `Tools for the user's YNAB (You Need A Budget) account.
- Amounts are in the plan's currency. In results, negative amounts are outflows (spending).
- When adding transactions, give positive amounts with direction "outflow" or "inflow".
- Before any change (creating, editing or deleting transactions or scheduled transactions; assigning or moving money; changing targets; renaming or reorganizing categories, groups or payees; reconciling), tell the user exactly what you will change and get their go-ahead, unless they already gave those exact details.
- Use list_accounts and list_categories to find exact names when a name is ambiguous.
- Daily routine: import_transactions, then list_transactions with only "unapproved", then categorize and approve with bulk_update_transactions. Check get_plan_overview for overspending and Ready to Assign.
- To move money between categories, use assign_to_category twice: lower the source's total and raise the destination's by the same amount.`;

function createServer() {
	const server = new McpServer(
		{ name: "MCP Server for YNAB", version: "1.0.0" },
		{ instructions: INSTRUCTIONS },
	);

	const props = getMcpAuthContext()?.props as Props | undefined;
	// Tools are only registered for signed-in, allowlisted users.
	if (props && isAllowedUser(props.login)) {
		registerYnabTools(server, new YnabClient(env.YNAB_ACCESS_TOKEN));
	}
	return server;
}

const mcpHandler = createMcpHandler(createServer);

const apiHandler = {
	fetch(request: Request, bindings: Env, ctx: ExecutionContext) {
		// Defense in depth: the OAuth provider has already verified the token;
		// also refuse anyone who has since been removed from ALLOWED_GITHUB_USERS.
		const login = (ctx as unknown as { props?: Props }).props?.login;
		if (!isAllowedUser(login)) {
			return new Response("Forbidden: this GitHub account is not allowed.", { status: 403 });
		}
		return mcpHandler(request, bindings, ctx);
	},
} satisfies ExportedHandler<Env>;

export default new OAuthProvider<Env>({
	apiHandler,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
	// The URL MCP clients connect to. Every token is bound to it.
	resourceMetadata: { resource: env.MCP_RESOURCE },
});
