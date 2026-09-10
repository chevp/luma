/**
 * GitHub OAuth device flow + GitHub Copilot token exchange.
 *
 * This talks to two different things:
 *  1. github.com/login/device — the public, documented GitHub OAuth device
 *     flow (RFC 8628). CLIENT_ID below is GitHub's own OAuth app used by
 *     copilot.vim (github/copilot.vim, public repo) for exactly this
 *     editor-integration login pattern.
 *  2. api.github.com/copilot_internal/... and api.githubcopilot.com — the
 *     *undocumented* internal API the Copilot editor extensions use to turn
 *     that GitHub token into short-lived Copilot API access and run chat
 *     completions. It is not a published Anthropic or GitHub API, requires
 *     an active Copilot subscription, and can change or break without
 *     notice — see the `claude` provider and `luma login claude`.
 */
const CLIENT_ID = "01ab8ac9400c4e429b23";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const USER_AGENT = "GithubCopilot/1.155.0";
async function requestDeviceCode() {
    const r = await fetch(DEVICE_CODE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ client_id: CLIENT_ID, scope: "read:user" }),
    });
    if (!r.ok) {
        throw new Error(`GitHub device code request failed: HTTP ${r.status}`);
    }
    return (await r.json());
}
async function pollForAccessToken(deviceCode, intervalSec, expiresInSec) {
    let interval = intervalSec;
    const deadline = Date.now() + expiresInSec * 1000;
    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, interval * 1000));
        const r = await fetch(ACCESS_TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({
                client_id: CLIENT_ID,
                device_code: deviceCode,
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            }),
        });
        const data = (await r.json().catch(() => ({})));
        if (data.access_token)
            return data.access_token;
        switch (data.error) {
            case undefined:
                continue;
            case "authorization_pending":
                continue;
            case "slow_down":
                interval += 5;
                continue;
            case "expired_token":
                throw new Error("device code expired — run the login command again");
            case "access_denied":
                throw new Error("authorization was denied");
            default:
                throw new Error(`GitHub device flow error: ${data.error_description ?? data.error}`);
        }
    }
    throw new Error("timed out waiting for GitHub authorization");
}
/** Starts the GitHub OAuth device flow. Caller prints userCode/verificationUri, then awaits waitForToken(). */
export async function startDeviceLogin() {
    const dc = await requestDeviceCode();
    return {
        userCode: dc.user_code,
        verificationUri: dc.verification_uri,
        waitForToken: () => pollForAccessToken(dc.device_code, dc.interval, dc.expires_in),
    };
}
let cachedCopilotToken = null;
/**
 * Exchanges the persisted GitHub token (CHI_GITHUB_COPILOT_TOKEN) for a
 * short-lived Copilot API token, caching it until shortly before expiry.
 * Returns null when no GitHub token is configured or the exchange fails.
 */
export async function getCopilotApiToken() {
    const ghToken = process.env.CHI_GITHUB_COPILOT_TOKEN?.trim();
    if (!ghToken)
        return null;
    const nowSec = Date.now() / 1000;
    if (cachedCopilotToken && cachedCopilotToken.expiresAt - 60 > nowSec) {
        return cachedCopilotToken.token;
    }
    try {
        const r = await fetch(COPILOT_TOKEN_URL, {
            headers: {
                Authorization: `token ${ghToken}`,
                Accept: "application/json",
                "User-Agent": USER_AGENT,
            },
        });
        if (!r.ok)
            return null;
        const data = (await r.json());
        if (!data.token || !data.expires_at)
            return null;
        cachedCopilotToken = { token: data.token, expiresAt: data.expires_at };
        return data.token;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=github-copilot-auth.js.map