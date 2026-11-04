import { env } from "cloudflare:workers";

/**
 * Constructs an authorization URL for an upstream service.
 *
 * @param {Object} options
 * @param {string} options.upstream_url - The base URL of the upstream service.
 * @param {string} options.client_id - The client ID of the application.
 * @param {string} options.redirect_uri - The redirect URI of the application.
 * @param {string} [options.state] - The state parameter.
 *
 * @returns {string} The authorization URL.
 */
export function getUpstreamAuthorizeUrl({
	upstream_url,
	client_id,
	scope,
	redirect_uri,
	state,
}: {
	upstream_url: string;
	client_id: string;
	scope: string;
	redirect_uri: string;
	state?: string;
}) {
	const upstream = new URL(upstream_url);
	upstream.searchParams.set("client_id", client_id);
	upstream.searchParams.set("redirect_uri", redirect_uri);
	upstream.searchParams.set("scope", scope);
	if (state) upstream.searchParams.set("state", state);
	upstream.searchParams.set("response_type", "code");
	return upstream.href;
}

/**
 * Fetches an authorization token from an upstream service.
 *
 * @param {Object} options
 * @param {string} options.client_id - The client ID of the application.
 * @param {string} options.client_secret - The client secret of the application.
 * @param {string} options.code - The authorization code.
 * @param {string} options.redirect_uri - The redirect URI of the application.
 * @param {string} options.upstream_url - The token endpoint URL of the upstream service.
 *
 * @returns {Promise<[string, null] | [null, Response]>} A promise that resolves to an array containing the access token or an error response.
 */
export async function fetchUpstreamAuthToken({
	client_id,
	client_secret,
	code,
	redirect_uri,
	upstream_url,
}: {
	code: string | undefined;
	upstream_url: string;
	client_secret: string;
	redirect_uri: string;
	client_id: string;
}): Promise<[string, null] | [null, Response]> {
	if (!code) {
		return [null, new Response("Missing code", { status: 400 })];
	}

	const resp = await fetch(upstream_url, {
		body: new URLSearchParams({ client_id, client_secret, code, redirect_uri }).toString(),
		headers: {
			Accept: "application/json",
			"Content-Type": "application/x-www-form-urlencoded",
		},
		method: "POST",
	});
	const text = await resp.text();
	let body: Record<string, string> = {};
	try {
		body = JSON.parse(text);
	} catch {
		body = Object.fromEntries(new URLSearchParams(text));
	}
	if (!resp.ok || !body.access_token) {
		// GitHub reports problems like a wrong client secret or a callback URL
		// mismatch here. Show the reason (never any secret) so setup is debuggable.
		const reason = body.error_description || body.error || `HTTP ${resp.status}`;
		console.error("GitHub token exchange failed:", resp.status, body.error, body.error_description);
		return [
			null,
			new Response(
				`Failed to fetch access token from GitHub: ${reason}\n\n` +
					"Check that the GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET secrets in Cloudflare match your GitHub OAuth app, " +
					"and that its callback URL is this server's address plus /callback.",
				{ status: 502, headers: { "Content-Type": "text/plain; charset=utf-8" } },
			),
		];
	}
	return [body.access_token, null];
}

// Context from the auth process, encrypted & stored in the auth token
// and provided to MCP handlers through getMcpAuthContext().
// The GitHub access token is deliberately NOT stored: it is only used once to
// learn who signed in.
export type Props = {
	login: string;
	name: string | null;
};

/**
 * True when the GitHub login is listed in the ALLOWED_GITHUB_USERS variable
 * (comma-separated, case-insensitive). An empty list allows nobody.
 */
export function isAllowedUser(login: string | null | undefined): boolean {
	if (!login) return false;
	const allowed = (env.ALLOWED_GITHUB_USERS ?? "")
		.split(",")
		.map((u) => u.trim().toLowerCase())
		.filter(Boolean);
	return allowed.includes(login.toLowerCase());
}
