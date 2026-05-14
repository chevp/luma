import { setup, assign } from "xstate";
import { sdkActor, type QueryArgs } from "./sdk-actor.js";

/**
 * The single XState v5 machine that wraps the Agent SDK iterator. Authoritative
 * spec is CTX-002 §System spec; ADR-008 governs scope (orchestrator-only).
 *
 * State diagram (matches CTX-002):
 *
 *   idle → running.receivingText
 *        ↘ running.executingTool.{builtInTool|chiAskUser|writeAttempt}
 *        → done | terminated.{error|userCancelled}
 *
 * `writeAttempt` is the R3 violation marker: a Write/Edit tool_use under
 * permissionMode: "plan" should never happen — if it does, we want the
 * machine to record it so command code can fail loud.
 */

export interface MachineContext {
  lastText: string;
  pendingTool?: string;
  sawWriteAttempt: boolean;
  errorMessage?: string;
}

export type MachineEvent =
  | { type: "START"; queryArgs: QueryArgs }
  | { type: "TEXT"; text: string }
  | { type: "TOOL_USE"; name: string; id: string }
  | { type: "RESULT"; subtype: string }
  | { type: "ERROR"; error: string }
  | { type: "USER_CANCELLED" };

const CHI_ASK_USER_TOOL_NAME = "mcp__chi__ask_user";
const WRITE_TOOL_NAMES = new Set(["Write", "Edit", "NotebookEdit"]);

export const orchestratorMachine = setup({
  types: {
    context: {} as MachineContext,
    events: {} as MachineEvent,
  },
  actors: { sdkActor },
  guards: {
    isChiAskUser: ({ event }) =>
      event.type === "TOOL_USE" && event.name === CHI_ASK_USER_TOOL_NAME,
    isWriteTool: ({ event }) =>
      event.type === "TOOL_USE" && WRITE_TOOL_NAMES.has(event.name),
  },
}).createMachine({
  id: "orchestrator",
  initial: "idle",
  context: { lastText: "", sawWriteAttempt: false },
  states: {
    idle: {
      on: {
        START: { target: "running" },
      },
    },
    running: {
      invoke: {
        src: "sdkActor",
        input: ({ event }) => {
          if (event.type !== "START") {
            throw new Error("running invoked without START event");
          }
          return event.queryArgs;
        },
      },
      initial: "receivingText",
      states: {
        receivingText: {
          on: {
            TEXT: {
              actions: assign({
                lastText: ({ event }) => (event.type === "TEXT" ? event.text : ""),
              }),
            },
            TOOL_USE: [
              {
                target: "executingTool.writeAttempt",
                guard: "isWriteTool",
                actions: assign({ sawWriteAttempt: true }),
              },
              {
                target: "executingTool.chiAskUser",
                guard: "isChiAskUser",
                actions: assign({
                  pendingTool: ({ event }) =>
                    event.type === "TOOL_USE" ? event.name : undefined,
                }),
              },
              {
                target: "executingTool.builtInTool",
                actions: assign({
                  pendingTool: ({ event }) =>
                    event.type === "TOOL_USE" ? event.name : undefined,
                }),
              },
            ],
          },
        },
        executingTool: {
          initial: "builtInTool",
          states: {
            builtInTool: {},
            chiAskUser: {},
            // The R3 violation marker. permissionMode:"plan" should make this
            // unreachable; if it fires, command code surfaces a loud error.
            writeAttempt: { type: "final" },
          },
          on: {
            TEXT: {
              target: "receivingText",
              actions: assign({
                lastText: ({ event }) => (event.type === "TEXT" ? event.text : ""),
                pendingTool: undefined,
              }),
            },
            TOOL_USE: [
              {
                target: "executingTool.writeAttempt",
                guard: "isWriteTool",
                actions: assign({ sawWriteAttempt: true }),
              },
              {
                target: "executingTool.chiAskUser",
                guard: "isChiAskUser",
                actions: assign({
                  pendingTool: ({ event }) =>
                    event.type === "TOOL_USE" ? event.name : undefined,
                }),
              },
              {
                target: "executingTool.builtInTool",
                actions: assign({
                  pendingTool: ({ event }) =>
                    event.type === "TOOL_USE" ? event.name : undefined,
                }),
              },
            ],
          },
        },
      },
      on: {
        RESULT: "done",
        ERROR: {
          target: "terminated.error",
          actions: assign({
            errorMessage: ({ event }) => (event.type === "ERROR" ? event.error : "unknown"),
          }),
        },
        USER_CANCELLED: "terminated.userCancelled",
      },
    },
    done: { type: "final" },
    terminated: {
      initial: "error",
      states: {
        error: { type: "final" },
        userCancelled: { type: "final" },
      },
    },
  },
});

export type OrchestratorMachine = typeof orchestratorMachine;
