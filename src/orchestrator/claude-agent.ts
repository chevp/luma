import { createActor, type AnyActorRef } from "xstate";
import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import {
  MissingAnthropicKeyError,
  type Orchestrator,
  type OrchestratorOptions,
  type OrchestratorRun,
  type Snapshot,
  type SnapshotState,
} from "./types.js";
import { orchestratorMachine } from "./state-machine.js";
import type { QueryArgs } from "./sdk-actor.js";
import { readlineAskUser } from "./ask-user.js";
import { makeAskUserTool } from "./tools/chi-ask-user.js";
import { makePlanCreateTool, makePlanListTool } from "./tools/chi-plan.js";

/**
 * The claude-agent orchestrator: a thin facade that
 *   1. validates ANTHROPIC_API_KEY (CTX-002 R2 / Decision #8 — checked at the
 *      first orchestrator call, NOT at boot, so other commands stay green when
 *      only cura credentials are set);
 *   2. assembles SDK options + chi.* tool MCP server;
 *   3. spins up the XState actor and exposes the typed Snapshot stream.
 *
 * Per ADR-008, this is the only file (alongside state-machine / sdk-actor /
 * tools/) that touches xstate or @anthropic-ai/claude-agent-sdk types in any
 * way commands can see.
 */

function flatten(value: unknown): SnapshotState {
  if (typeof value === "string") return value as SnapshotState;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 1) {
      const entry = entries[0];
      if (entry) {
        const [k, sub] = entry;
        return `${k}.${flatten(sub)}` as SnapshotState;
      }
    }
  }
  return "idle";
}

function snapshotFromActor(actor: AnyActorRef): Snapshot {
  const snap = actor.getSnapshot();
  const ctx = snap.context as { lastText?: string; pendingTool?: string; errorMessage?: string };
  const state = flatten(snap.value);
  const out: Snapshot = { state };
  if (ctx.lastText) out.lastAssistantText = ctx.lastText;
  if (ctx.pendingTool) out.pendingToolName = ctx.pendingTool;
  if (state === "terminated.error" && ctx.errorMessage) {
    out.error = { message: ctx.errorMessage };
  }
  return out;
}

export const claudeAgentOrchestrator: Orchestrator = {
  name: "claude-agent",

  async ping(): Promise<boolean> {
    return Boolean(process.env.ANTHROPIC_API_KEY);
  },

  start(opts: OrchestratorOptions, prompt: string): OrchestratorRun {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new MissingAnthropicKeyError();
    }

    const askUser = opts.askUser ?? readlineAskUser;
    const chiServer = createSdkMcpServer({
      name: "chi",
      version: "0.1.0",
      tools: [
        makeAskUserTool(askUser),
        makePlanCreateTool(opts.cwd),
        makePlanListTool(opts.cwd),
      ],
    });

    const queryArgs: QueryArgs = {
      prompt,
      options: {
        cwd: opts.cwd,
        permissionMode: opts.permissionMode,
        allowedTools: opts.allowedTools,
        mcpServers: { chi: chiServer },
        model: opts.model ?? "claude-opus-4-7",
        ...(opts.systemPrompt ? { customSystemPrompt: opts.systemPrompt } : {}),
      },
    };

    const actor = createActor(orchestratorMachine);
    const listeners = new Set<(snap: Snapshot) => void>();

    actor.subscribe(() => {
      const snap = snapshotFromActor(actor);
      for (const fn of listeners) fn(snap);
    });

    const done = new Promise<Snapshot>((resolve) => {
      const sub = actor.subscribe((s) => {
        if (s.status === "done") {
          sub.unsubscribe();
          resolve(snapshotFromActor(actor));
        }
      });
    });

    actor.start();
    actor.send({ type: "START", queryArgs });

    return {
      subscribe(listener) {
        listeners.add(listener);
        // Fire current state immediately for late subscribers.
        listener(snapshotFromActor(actor));
        return {
          unsubscribe() {
            listeners.delete(listener);
          },
        };
      },
      send(event) {
        actor.send(event);
      },
      done,
    };
  },
};
