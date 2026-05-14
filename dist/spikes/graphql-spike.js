/**
 * G2 Exploration spike for PRD-002 H2:
 * `gh api graphql` batching replaces N × `git fetch` for ahead-detection,
 * with round-trip count = ceil(N / 50).
 *
 * This spike picks 12 dirty/ahead repos from the workspace, derives their
 * <owner>/<name> slugs, builds a single aliased GraphQL query that fetches
 * defaultBranchRef.target.oid + open-PR head refs, and reports timings +
 * round-trip count.
 *
 * Run:  npx tsx src/spikes/graphql-spike.ts <owner>
 */
import { execAsync } from "../spawn.js";
const BATCH = 50;
function buildQuery(slugs) {
    const fields = slugs
        .map((s, i) => {
        const alias = `r${i}`;
        // GraphQL identifiers can't contain dashes; aliases are just rN.
        const ownerArg = JSON.stringify(s.owner);
        const nameArg = JSON.stringify(s.name);
        return `  ${alias}: repository(owner: ${ownerArg}, name: ${nameArg}) {
    nameWithOwner
    defaultBranchRef { name target { oid } }
    pullRequests(first: 1, states: OPEN) {
      nodes { number url isDraft headRefName }
    }
  }`;
    })
        .join("\n");
    return `query {\n${fields}\n}`;
}
async function ghGraphql(query) {
    // gh api graphql -f query='...' returns JSON on stdout
    const r = await execAsync("gh", ["api", "graphql", "-f", `query=${query}`]);
    if (!r.ok) {
        throw new Error(`gh api graphql failed: ${r.stderr}`);
    }
    return JSON.parse(r.stdout);
}
async function main() {
    const owner = process.argv[2] ?? "chevp";
    // Hardcoded sample drawn from the H1 spike's dirty/ahead list.
    const sampleNames = [
        "chi",
        "che-cli",
        "synth-plugin-gltf",
        "synth-cluster-editor",
        "chevp-papers",
        "chevp-setup",
        "chevp-ai-framework",
        "chevix-agents",
        "engineering-graph-framework",
        "cryo-platform-web",
        "cryo-build-lab-tools",
        "arctic-workspace",
    ];
    const slugs = sampleNames.map((name) => ({ owner, name }));
    console.log(`owner:    ${owner}`);
    console.log(`repos:    ${slugs.length}`);
    console.log(`batches:  ${Math.ceil(slugs.length / BATCH)} (BATCH=${BATCH})`);
    const t0 = performance.now();
    let calls = 0;
    let totalNodes = 0;
    let openPrs = 0;
    let resolved = 0;
    for (let i = 0; i < slugs.length; i += BATCH) {
        const chunk = slugs.slice(i, i + BATCH);
        const query = buildQuery(chunk);
        const result = (await ghGraphql(query));
        calls += 1;
        if (result.errors && result.errors.length > 0) {
            // GraphQL returns partial data alongside per-field errors (e.g.
            // NOT_FOUND for a wrong slug). Surface them but continue.
            for (const err of result.errors) {
                console.log(`  err: ${err.type ?? "?"} ${err.message}`);
            }
        }
        const data = result.data ?? {};
        for (const key of Object.keys(data)) {
            totalNodes += 1;
            const repo = data[key];
            if (repo === null || repo === undefined)
                continue;
            resolved += 1;
            const sha = repo.defaultBranchRef?.target?.oid ?? "?";
            const branch = repo.defaultBranchRef?.name ?? "?";
            const prs = repo.pullRequests?.nodes ?? [];
            if (prs.length > 0)
                openPrs += 1;
            console.log(`  ${(repo.nameWithOwner ?? "?").padEnd(40)} ${branch.padEnd(10)} ${sha.slice(0, 7)} ${prs.length > 0 ? `PR#${prs[0]?.number}` : ""}`);
        }
    }
    const t1 = performance.now();
    console.log(`\ntotal:        ${(t1 - t0).toFixed(0)}ms`);
    console.log(`gh calls:     ${calls}`);
    console.log(`nodes asked:  ${totalNodes}`);
    console.log(`resolved:     ${resolved}`);
    console.log(`with open PR: ${openPrs}`);
    console.log("");
    const expectedCalls = Math.ceil(slugs.length / BATCH);
    console.log(`H2 verdict (calls = ceil(N/${BATCH})): ${calls === expectedCalls && resolved === slugs.length ? "PASS" : "FAIL"}`);
    console.log(`   expected: ${expectedCalls} calls · got: ${calls} · resolved: ${resolved}/${slugs.length}`);
}
main().catch((e) => {
    console.error(e);
    process.exit(1);
});
//# sourceMappingURL=graphql-spike.js.map