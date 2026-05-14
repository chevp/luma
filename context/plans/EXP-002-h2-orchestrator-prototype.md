---
id: EXP-002
type: EXP
status: approved
gate: G2
exploration-mode: A
proposed-by: ai
proposed-at: 2026-05-11
decided-by: chevp
approved-by: chevp
approved-at: 2026-05-11
supersedes: —
context-plan: CTX-002-ai-orchestration-providers.md
adrs: ADR-007-claude-agent-sdk-exception.md, ADR-008-xstate-narrow-exception.md
---

# EXP-002 — Problem-Exploration: Does `@anthropic-ai/claude-agent-sdk` (under an XState wrapper) Cover Our Orchestrator Surface?

## Mode

**A (Problem exploration).** We are not yet choosing between solution
candidates; we are validating that CTX-002's central technical
assumption (H2) holds against the real SDK. A low-fidelity, scripted
prototype is the cheapest path to confirm or kill the hypothesis. No
chi command code is touched in this phase.

## Hypotheses under test

This exploration tests **two** CTX-002 hypotheses in a single prototype
run, because they are operationally inseparable (the XState wrapper
needs real SDK events to drive transitions, and the SDK capability test
needs the wrapper's snapshot stream to observe the outcome).

**H2 (from [CTX-002](CTX-002-ai-orchestration-providers.md)):** the
`@anthropic-ai/claude-agent-sdk` covers ≥ 90 % of the desired file-I/O,
bash, and ask-user-question surface out of the box; custom chi-specific
tools (e.g. `chi.ask_user`) are an *additive* layer (MCP server or
in-process tool registration), not a replacement.

**H4 (from [CTX-002](CTX-002-ai-orchestration-providers.md)):** a single
XState v5 machine cleanly wraps the SDK's async iterator (one
`fromCallback` actor of ≤ 40 LoC) and produces all four observable
transitions of the production state machine (`idle → running →
executingTool → awaitingUser → running → done`) without re-implementing
the SDK's internal tool loop.

## Kill criteria (binary, observable)

The prototype script below MUST complete an end-to-end run where the
model:

1. Receives the prompt "Read the file `prototype-target.md` and tell me
   what the user's name is. If the file does not exist or is ambiguous,
   ask the user via the `chi.ask_user` tool."
2. Invokes the SDK's built-in `Read` tool on `prototype-target.md`
   (planted by the script).
3. If the planted file omits the name on purpose, invokes the custom
   in-process tool `chi.ask_user` with a question whose `tool_result`
   the script returns from the local terminal.
4. Produces a final assistant text turn that names the answer (e.g.
   "The user's name is Chevp.") and exits with `stop_reason !==
   "tool_use"`.
5. **AND** all of (1)–(4) are observable through the XState machine's
   snapshot stream — i.e. the externally-collected transition log
   contains, in order, at least: `idle → running.receivingText →
   running.executingTool.builtInTool → running.receivingText →
   running.executingTool.chiAskUser → running.receivingText → done`.

**H2 dies** if any of:

- The Agent SDK refuses to mix a built-in tool with a custom
  in-process tool in the same `query()` invocation.
- The custom tool cannot return a structured `tool_result` block the
  model treats as first-class (i.e. the model ignores it or stalls).
- `permissionMode: "plan"` permits the `Write` tool, or any tool other
  than `Read`/`Glob`/`Grep`, to mutate the filesystem during the test.
  (This is R3 from CTX-002; H2 and R3 share this acceptance bar.)
- The async-iterator surface (`for await` over `query(...)`) does not
  surface enough event types to distinguish *assistant text*,
  *tool_use*, and *result* — without that, our `Orchestrator` event
  interface in CTX-002's System spec is unimplementable as planned.

If H2 dies, CTX-002's SDK choice is re-opened (fallback: low-level
`@anthropic-ai/sdk`, hand-rolled tool loop — different SDK, different
ADR, ~1500–2500 LoC).

**H4 dies** if any of:

- A `fromCallback` actor cannot subscribe to the SDK's async iterator
  without leaking the iterator past the actor's `stop()` cleanup
  (memory leak / unhandled rejection on cancel).
- The machine cannot distinguish a built-in tool call from a chi.* tool
  call using only the `tool_use` event payload (guard on `event.name`
  must be sufficient).
- Snapshot subscription does not produce the expected ordered
  transition log — i.e. events arrive out of order, or substates
  collapse into a single `running` flag with no executingTool /
  receivingText distinction.

If H4 dies, the fallback is **not** to abandon the state-machine idea
but to (a) try a different actor pattern in the same machine, or
(b) escalate to ADR-008 Alternative A (in-tree typed FSM).

## What this prototype does NOT test

Per Mode A: low-fidelity, problem-validation only. Out of scope for
EXP-002:

- Streaming output (CTX-002 explicitly defers this).
- `chi consult` argv parsing, flag handling, help text.
- `chi plan new` scaffolding logic.
- Workspace-mode resolver (`src/workspace.ts`).
- Provider parity (`cura`/`ollama` unaffected by design).
- API-key error messages (CTX-002 #8); the prototype assumes
  `ANTHROPIC_API_KEY` is set.

These all return in **PRD-003** (Production), after G2 closes.

## Procedure

### 1. Prerequisites

```sh
export ANTHROPIC_API_KEY=<your key>           # required
node --version                                # must be 20+
```

### 2. Throwaway install — does NOT commit

The dep is installed transiently for the duration of the prototype run.
ADR-007 authorises this; PRD-003 will add the permanent `dependencies`
entry.

```sh
cd /tmp && mkdir -p chi-exp-002 && cd chi-exp-002
npm init -y >/dev/null
npm pkg set type=module
npm install --no-save @anthropic-ai/claude-agent-sdk xstate zod
```

### 3. Plant the target file

```sh
cat > prototype-target.md <<'EOF'
# Test fixture for chi EXP-002

This document intentionally omits the user's identity to force the
model to use the `chi.ask_user` tool.

Project status: green.
EOF
```

### 4. Run the prototype

Save the script below as `prototype.mjs` in `/tmp/chi-exp-002/` and run
`node prototype.mjs`.

```js
// prototype.mjs — EXP-002 H2 + H4 test. Runs once, prints a verdict.
//
// Architecture mirror of CTX-002 §System spec:
//
//   prototype.mjs
//     ├── machine                ← single XState machine (the H4 surface)
//     ├── sdkActor               ← fromCallback that pumps SDK iterator
//     │                            into machine events (TEXT, TOOL_USE, RESULT)
//     ├── askUserTool            ← chi.ask_user custom tool, readline pause
//     └── snapshot subscription  ← collects ordered transition log

import {
  query,
  tool,
  createSdkMcpServer,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { setup, createActor, fromCallback, assign } from "xstate";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const rl = readline.createInterface({ input, output });

// --- chi.ask_user custom tool -------------------------------------------
const askUserTool = tool(
  "ask_user",
  "Ask the human a clarifying question and return their answer verbatim.",
  {
    question: z.string().describe("The question to display to the user."),
    options: z.array(z.string()).optional(),
  },
  async ({ question, options }) => {
    const banner = options?.length
      ? `\n${question}\n${options.map((o, i) => `  ${i + 1}) ${o}`).join("\n")}\n> `
      : `\n${question}\n> `;
    const answer = await rl.question(banner);
    return { content: [{ type: "text", text: answer }] };
  },
);

const chiTools = createSdkMcpServer({
  name: "chi",
  version: "0.0.1-exp-002",
  tools: [askUserTool],
});

// --- SDK iterator → machine events (H4 core) ----------------------------
const sdkActor = fromCallback(({ sendBack, input }) => {
  let cancelled = false;
  (async () => {
    try {
      for await (const msg of query(input)) {
        if (cancelled) return;
        if (msg.type === "assistant") {
          for (const block of msg.message.content) {
            if (block.type === "text") {
              sendBack({ type: "TEXT", text: block.text });
            }
            if (block.type === "tool_use") {
              sendBack({ type: "TOOL_USE", name: block.name, id: block.id });
            }
            // R3 check — any Edit/Write tool_use under permissionMode: "plan"
            // is a violation; the verdict pass condition treats this as fatal.
          }
        }
        if (msg.type === "result") {
          sendBack({ type: "RESULT", subtype: msg.subtype });
        }
      }
      if (!cancelled) sendBack({ type: "RESULT", subtype: "exhausted" });
    } catch (err) {
      if (!cancelled) sendBack({ type: "ERROR", error: String(err) });
    }
  })();
  return () => {
    cancelled = true;
  };
});

// --- the machine --------------------------------------------------------
const machine = setup({
  types: {
    context: {} as {
      lastText: string;
      sawWriteAttempt: boolean;
      pendingTool?: string;
    },
    events: {} as
      | { type: "START"; queryArgs: Parameters<typeof query>[0] }
      | { type: "TEXT"; text: string }
      | { type: "TOOL_USE"; name: string; id: string }
      | { type: "RESULT"; subtype: string }
      | { type: "ERROR"; error: string }
      | { type: "USER_CANCELLED" },
  },
  actors: { sdkActor },
  guards: {
    isChiAskUser: ({ event }) =>
      event.type === "TOOL_USE" && event.name === "mcp__chi__ask_user",
    isWriteTool: ({ event }) =>
      event.type === "TOOL_USE" &&
      (event.name === "Write" || event.name === "Edit"),
  },
}).createMachine({
  id: "orchestrator",
  initial: "idle",
  context: { lastText: "", sawWriteAttempt: false },
  states: {
    idle: {
      on: {
        START: {
          target: "running",
          // queryArgs forwarded into the invoked actor below
        },
      },
    },
    running: {
      invoke: {
        src: "sdkActor",
        input: ({ event }) =>
          event.type === "START" ? event.queryArgs : undefined,
      },
      initial: "receivingText",
      states: {
        receivingText: {
          on: {
            TEXT: { actions: assign({ lastText: ({ event }) => event.text }) },
            TOOL_USE: [
              {
                target: "executingTool.writeAttempt",
                guard: "isWriteTool",
                actions: assign({ sawWriteAttempt: true }),
              },
              {
                target: "executingTool.chiAskUser",
                guard: "isChiAskUser",
                actions: assign({ pendingTool: ({ event }) => event.name }),
              },
              {
                target: "executingTool.builtInTool",
                actions: assign({ pendingTool: ({ event }) => event.name }),
              },
            ],
          },
        },
        executingTool: {
          initial: "builtInTool",
          states: {
            builtInTool: {},
            chiAskUser: {},
            writeAttempt: { type: "final" }, // R3 violation marker
          },
          on: {
            TEXT: {
              target: "receivingText",
              actions: assign({ lastText: ({ event }) => event.text }),
            },
          },
        },
      },
      on: {
        RESULT: "done",
        ERROR: "terminated",
        USER_CANCELLED: "terminated",
      },
    },
    done: { type: "final" },
    terminated: { type: "final" },
  },
});

// --- run + observe ------------------------------------------------------
const transitionLog = [];
const actor = createActor(machine);
actor.subscribe((snap) => {
  // xstate v5 state value can be string or nested object; flatten to dot path.
  const flat = (v) =>
    typeof v === "string"
      ? v
      : Object.entries(v)
          .map(([k, sub]) => `${k}.${flat(sub)}`)
          .join(",");
  const path = flat(snap.value);
  if (transitionLog[transitionLog.length - 1] !== path) transitionLog.push(path);
});
actor.start();

actor.send({
  type: "START",
  queryArgs: {
    prompt:
      "Read the file `prototype-target.md` in the current directory and tell me the user's name. " +
      "If the document does not state it explicitly, you MUST use the `mcp__chi__ask_user` tool to ask the user. " +
      "Do not guess. After you have the name, reply with a single sentence: 'The user's name is <name>.'",
    options: {
      cwd: process.cwd(),
      permissionMode: "plan", // R3 acceptance
      allowedTools: ["Read", "Glob", "Grep", "mcp__chi__ask_user"],
      mcpServers: { chi: chiTools },
      model: "claude-opus-4-7",
    },
  },
});

// Wait for the machine to reach a final state.
await new Promise((resolve) => {
  const sub = actor.subscribe((snap) => {
    if (snap.status === "done") {
      sub.unsubscribe();
      resolve();
    }
  });
});

rl.close();

// --- verdict ------------------------------------------------------------
const ctx = actor.getSnapshot().context;
const finalText = ctx.lastText;
const counts = {
  builtInTool: transitionLog.filter((p) => p.includes("executingTool.builtInTool")).length,
  chiAskUser: transitionLog.filter((p) => p.includes("executingTool.chiAskUser")).length,
  writeAttempt: transitionLog.filter((p) => p.includes("executingTool.writeAttempt")).length,
};

const verdict = {
  // H2 — SDK capability
  h2: {
    assistantSaidName: /the user'?s name is\s+\S+/i.test(finalText),
    usedRead: counts.builtInTool >= 1,
    usedAskUser: counts.chiAskUser >= 1,
    noWriteAttempt: counts.writeAttempt === 0 && !ctx.sawWriteAttempt,
    reachedDone: actor.getSnapshot().value === "done",
  },
  // H4 — state-machine wrapping
  h4: {
    observedTransitions: transitionLog,
    requiredOrderingObserved: (() => {
      // expected (subsequence, not strict adjacency):
      // idle → running.receivingText → running.executingTool.builtInTool →
      //   running.receivingText → running.executingTool.chiAskUser →
      //   running.receivingText → done
      const expected = [
        "idle",
        "running.receivingText",
        "running.executingTool.builtInTool",
        "running.receivingText",
        "running.executingTool.chiAskUser",
        "running.receivingText",
        "done",
      ];
      let i = 0;
      for (const step of transitionLog) {
        if (step === expected[i]) i += 1;
        if (i === expected.length) return true;
      }
      return false;
    })(),
    noErrorState: !transitionLog.includes("terminated"),
  },
  finalText,
};

console.log("\n--- EXP-002 H2+H4 verdict ---");
console.log(JSON.stringify(verdict, null, 2));

const h2Passed = Object.values(verdict.h2).every(Boolean);
const h4Passed = Object.values(verdict.h4).every(Boolean);

if (h2Passed && h4Passed) {
  console.log("\nH2 + H4 hold. CTX-002 moves to PRD-003.");
  process.exit(0);
} else {
  if (!h2Passed) console.log("\nH2 KILLED. Re-open SDK choice in CTX-002.");
  if (!h4Passed)
    console.log(
      "\nH4 KILLED. Re-open state-machine design per ADR-008 Alternative A (in-tree FSM).",
    );
  process.exit(1);
}
```

### 5. Interpret the output

The script self-judges. The `--- EXP-002 H2 verdict ---` block is the
durable evidence; copy it into the `insights.md` deliverable below.

## Deliverables

- [ ] **`insights-EXP-002.md`** (sibling of this file, written by hand
      or by `chi consult` once it exists) — record:
  - exact verdict JSON from the prototype run
  - any SDK quirks encountered (event types we did not predict, naming
    differences for `mcp__chi__ask_user` vs. `chi.ask_user`, etc.)
  - decision: H2 holds → proceed to PRD-003 | H2 killed → revise CTX-002
- [ ] Verdict JSON pasted as evidence into PRD-003 frontmatter once it
      is drafted.

## Acceptance criteria for G2 → G3

- [ ] Prototype run completed end-to-end on the user's machine with
      `ANTHROPIC_API_KEY` set (chi has no way to run this itself —
      requires human execution by design).
- [ ] Verdict JSON saved in `insights-EXP-002.md`. Both the `h2` block
      and the `h4` block recorded.
- [ ] Either: **all flags in both `h2` and `h4` pass** → H2 and H4
      confirmed, draft PRD-003. Or: any `h2` flag fails → SDK choice
      re-opened in CTX-002 / re-enter G1. Or: any `h4` flag fails → try
      ADR-008 Alternative A (in-tree FSM) before killing CTX-002.
- [ ] The observed `transitionLog` matches the expected ordered
      subsequence documented in the state-machine diagram of
      [CTX-002 § System spec](CTX-002-ai-orchestration-providers.md#system-spec--proposed-shape).
- [ ] No leftover `node_modules`, `package.json`, or fixture files
      committed from `/tmp/chi-exp-002/` (the throwaway dir was the
      whole point).

## Kill Criteria (escape hatches for the exploration itself)

Abort this exploration and rewrite if any of:

- The Agent SDK's published types do not match the runtime behaviour the
  script assumes (e.g. `tool()` / `createSdkMcpServer()` are no longer
  exported under those names). Update the script to current SDK shape
  and retry — but if the shape has churned twice in one quarter, this is
  itself evidence that justifies switching SDKs per ADR-007 SDK-version-
  churn risk.
- The model consistently ignores the explicit "you MUST use the
  `mcp__chi__ask_user` tool" instruction across three runs with
  `claude-opus-4-7`. Then ask-user-questions is not reliably achievable
  via natural-language tool persuasion — investigate stronger steering
  (system prompt? `tool_choice`?) or downgrade the feature's promised
  reliability in CTX-002.
- `permissionMode: "plan"` allows `Write`/`Edit`/`Bash` to execute. R3
  is unfixable at the SDK layer; CTX-002 must redesign the safety story
  (likely: implement permission gating in the Orchestrator layer, do
  not trust the SDK's built-in mode for read-only).
