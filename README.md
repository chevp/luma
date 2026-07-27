# luma

Node.js / TypeScript port of [che-cli](https://github.com/chevp/che-cli) — a small developer CLI that wraps git workflows and AI provider calls. Hand-rolled command dispatch, ollama runtime dependencies.

The LLM backend is hardwired to the **cura** Cloud Run endpoint (a hosted Ollama).

```sh
$ luma status

luma-cli
  platform           darwin
  provider           cura (model: smollm2:135m)
  reachable          yes

git
  repo               luma
  branch             main
  state              clean
```

## Install

Requires Node 20+.

```sh
npm install -g https://github.com/chevp/luma/releases/latest/download/luma.tgz
```

Installs the prebuilt npm tarball from the latest GitHub Release (CI-built on every `vX.Y.Z` tag) and places three binaries on PATH via npm's global bin: `luma`, `che`, and `jan`. All three resolve to the same launcher; each presents itself with its invoked name in help text and error prefixes.

### From a local clone (development)

```sh
git clone https://github.com/chevp/luma.git
cd luma
./install.sh        # macOS / Linux / WSL
.\install.ps1       # Windows PowerShell
```

Flags: `--help` / `-AssumeYes` for unattended runs; `PREFIX=~/.local ./install.sh` to override the install location. For iterative hacking without rebuilding: `npm run dev -- <cmd>`.

## First-time setup

Run **once** after install to enter your cura credentials and verify the endpoint:

```sh
luma init
```

`luma init` prompts for `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD` (password input is masked), saves them to `~/.luma/config` (chmod 600), pings the cura endpoint, and confirms the model is available. Re-run with `--force` to update saved credentials.

If you'd rather not be prompted, set both env vars before running `luma init` and the saved file will mirror what's in your environment:

```sh
export BASIC_AUTH_USER=<user>
export BASIC_AUTH_PASSWORD=<password>
luma init
```

## Update

Once installed, luma can update itself — works for both global and from-source installs:

```sh
luma update
```

It detects the install layout and either runs `npm install -g https://github.com/chevp/luma/releases/latest/download/luma.tgz` (global) or `git pull --ff-only && npm install` (workspace clone — the pulled commit is expected to ship a fresh `dist/`).

## Usage

All commands use the cura endpoint for LLM calls. Credentials are read from env vars first, then `~/.luma/config`.

### Daily git workflow

```sh
luma status            # repo state + provider reachability
luma commit            # stage all + AI-generated commit message
luma commit --push     # also push
luma flow my-feature   # cut a flow branch from base
luma ship              # add + commit + push (recursive into submodules)
luma done              # squash-merge the active flow PR + return to base
```

### Issue management

```sh
luma issue                           # interactive: AI drafts a new issue
luma issue "title and rough body"    # AI fleshes out title/body, opens it
luma issue list --limit 20
luma issue close 42 --reason "fixed in #45"
```

`luma issue fix <n>` is **not available** — it required an interactive Claude CLI session that no longer exists in cura-only mode.

### Diagnostics

```sh
luma explain                                # diagnose the last failed luma ship/commit
luma explain "why is git push hanging?"     # ad-hoc question, current git state included
luma doctor                                 # all checks (git, cura, workflow)
luma doctor cura                            # only the cura endpoint check
```

### Config

```sh
luma config                                # list saved settings
luma config llm_model smollm2:135m         # change a key
luma config basic_auth_user my-user        # update saved credentials
luma config --unset basic_auth_password    # forget a key
luma config edit                           # open ~/.luma/config in $EDITOR
luma config path                           # print the config file path
```

### Workflows and worktrees

```sh
luma workflow list                       # list .che/workflows/*.yml
luma run <name>                          # alias for `luma workflow run <name>`
luma work <branch-name>                  # parallel git worktree (branch luma/<name>)
luma work list | rm <name> | cd <name>
```

## Configuration

Persistent settings live in `~/.luma/config` (managed by `luma init` and `luma config`). Env vars always win over the file. The file is written with mode 600 on first save by `luma init`.

| Key (`~/.luma/config`)  | Env var               | Default                                             |
|------------------------|-----------------------|------------------------------------------------------|
| `basic_auth_user`      | `BASIC_AUTH_USER`     | **required**                                         |
| `basic_auth_password`  | `BASIC_AUTH_PASSWORD` | **required**                                         |
| `llm_url`              | `LUMA_LLM_URL`         | `https://cura-llm-3j2fyuwcdq-oa.a.run.app`          |
| `llm_model`            | `LUMA_LLM_MODEL`       | `smollm2:135m`                                      |
| `max_diff_chars`       | `LUMA_MAX_DIFF_CHARS`  | `8000`                                              |
| —                      | `LUMA_CONFIG_FILE`     | `~/.luma/config`                                    |
| —                      | `LUMA_INVOKED_AS`      | basename of `argv[1]` (e.g. `luma`, `jan`, `che`)   |

`LUMA_INVOKED_AS` lets a wrapper present luma under a different name — help text, status header, and error prefixes all switch to that name. Auto-detected from `argv[1]`, so the [chevp/jan-cli](https://github.com/chevp/jan-cli) wrapper picks up `jan` automatically without setting it.

## Arlumatecture

Hand-rolled dispatcher in [src/index.ts](src/index.ts) routes argv to per-command files in [src/commands/](src/commands/). The single [cura provider](src/provider/cura.ts) implements the [Provider](src/provider/types.ts) interface and sends `Authorization: Basic <base64>` on every call. See [CLAUDE.md](CLAUDE.md) for conventions and ADR pointers.

## Why "luma"?

`che` minus an `e`. Three letters, pronounceable, distinct binary so `che` and `luma` coexist on the same malumane during migration. There's also a `jan` wrapper at [chevp/jan-cli](https://github.com/chevp/jan-cli) that exposes the same luma binary under a different name.
