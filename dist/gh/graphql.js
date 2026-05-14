import { execAsync } from "../spawn.js";
export const BATCH_SIZE = 50;
export function parseSlug(slug) {
    const ix = slug.indexOf("/");
    if (ix <= 0 || ix === slug.length - 1)
        return null;
    return { owner: slug.slice(0, ix), name: slug.slice(ix + 1) };
}
function buildQuery(slugs, branchOverride) {
    const fields = slugs.map((s, i) => {
        const alias = `r${i}`;
        const ownerArg = JSON.stringify(s.owner);
        const nameArg = JSON.stringify(s.name);
        const prFilter = branchOverride
            ? `(first: 1, states: OPEN, headRefName: ${JSON.stringify(branchOverride)})`
            : `(first: 1, states: OPEN)`;
        return `  ${alias}: repository(owner: ${ownerArg}, name: ${nameArg}) {
    nameWithOwner
    defaultBranchRef { name target { oid } }
    pullRequests${prFilter} {
      nodes { number url isDraft headRefName }
    }
  }`;
    }).join("\n");
    return `query {\n${fields}\n}`;
}
/**
 * Fetch defaultBranchRef.target.oid + open PR head refs for many repos in a
 * single GraphQL round-trip. Splits into chunks of `BATCH_SIZE` when the
 * input exceeds the limit. Per-field errors (NOT_FOUND, etc.) are recorded
 * on the corresponding RepoState rather than failing the call.
 *
 * If `branchOverride` is set, the PR filter narrows to that branch (used by
 * flow-mode lookups).
 */
export async function fetchRepoStates(slugs, branchOverride) {
    const results = [];
    for (let i = 0; i < slugs.length; i += BATCH_SIZE) {
        const chunk = slugs.slice(i, i + BATCH_SIZE);
        const query = buildQuery(chunk, branchOverride);
        const r = await execAsync("gh", ["api", "graphql", "-f", `query=${query}`]);
        if (!r.ok) {
            for (const s of chunk) {
                results.push({
                    slug: `${s.owner}/${s.name}`,
                    defaultBranch: null,
                    defaultBranchOid: null,
                    openPr: null,
                    notFound: false,
                    error: r.stderr.trim() || `gh exit status ${r.status}`,
                });
            }
            continue;
        }
        let parsed;
        try {
            parsed = JSON.parse(r.stdout);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            for (const s of chunk) {
                results.push({
                    slug: `${s.owner}/${s.name}`,
                    defaultBranch: null,
                    defaultBranchOid: null,
                    openPr: null,
                    notFound: false,
                    error: `gh stdout not JSON: ${msg}`,
                });
            }
            continue;
        }
        const errorByAlias = new Map();
        if (parsed.errors) {
            for (const err of parsed.errors) {
                const path = Array.isArray(err.path) && err.path.length > 0 ? String(err.path[0]) : "";
                const alias = path.startsWith("r") ? path : "";
                const note = err.type ? `${err.type}: ${err.message}` : err.message;
                if (alias)
                    errorByAlias.set(alias, note);
            }
        }
        const data = parsed.data ?? {};
        chunk.forEach((s, j) => {
            const alias = `r${j}`;
            const repo = data[alias];
            const slug = `${s.owner}/${s.name}`;
            const errNote = errorByAlias.get(alias) ?? null;
            if (repo == null) {
                results.push({
                    slug,
                    defaultBranch: null,
                    defaultBranchOid: null,
                    openPr: null,
                    notFound: errNote?.startsWith("NOT_FOUND") === true,
                    error: errNote,
                });
                return;
            }
            const branch = repo.defaultBranchRef?.name ?? null;
            const oid = repo.defaultBranchRef?.target?.oid ?? null;
            const prNode = repo.pullRequests?.nodes?.[0];
            results.push({
                slug,
                defaultBranch: branch,
                defaultBranchOid: oid,
                openPr: prNode
                    ? {
                        number: prNode.number,
                        url: prNode.url,
                        isDraft: prNode.isDraft,
                        headRefName: prNode.headRefName,
                    }
                    : null,
                notFound: false,
                error: errNote,
            });
        });
    }
    return results;
}
export async function listRemoteRepos(owner, limit = 1000) {
    const r = await execAsync("gh", [
        "repo",
        "list",
        owner,
        "--limit",
        String(limit),
        "--json",
        "nameWithOwner,sshUrl",
    ]);
    if (!r.ok) {
        throw new Error(`gh repo list failed: ${r.stderr.trim() || r.status}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(r.stdout);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`gh repo list returned non-JSON: ${msg}`);
    }
    const out = [];
    for (const item of parsed) {
        if (!item.nameWithOwner || !item.sshUrl)
            continue;
        out.push({ slug: item.nameWithOwner, sshUrl: item.sshUrl });
    }
    return out;
}
export async function ghLogin() {
    const r = await execAsync("gh", ["api", "user", "--jq", ".login"]);
    if (!r.ok)
        return null;
    const login = r.stdout.trim();
    return login.length > 0 ? login : null;
}
//# sourceMappingURL=graphql.js.map