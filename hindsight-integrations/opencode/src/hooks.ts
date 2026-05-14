/**
 * Hook implementations for the Hindsight OpenCode plugin.
 *
 * Hooks:
 *   - event (session.idle) → auto-retain conversation transcript
 *   - experimental.session.compacting → retain + inject memories into compaction context
 *   - experimental.chat.system.transform → recall every turn, inject only when relevant
 *
 * Per-turn recall strategy:
 *   1. Recall using the last N turns (user + assistant) as query context
 *   2. Hash the result set — if unchanged from last turn, reuse the cached block (vLLM prefix cache hit)
 *   3. If the memory set changed, call reflect to synthesize a fresh block, then cache it
 */

import type { HindsightClient } from "@vectorize-io/hindsight-client";
import type { HindsightConfig } from "./config.js";
import { debugLog } from "./config.js";
import {
  formatMemories,
  stripMemoryTags,
  composeRecallQuery,
  truncateRecallQuery,
  prepareRetentionTranscript,
  sliceLastTurnsByUserBoundary,
  type Message,
} from "./content.js";
import { ensureBankMission } from "./bank.js";

export interface PluginState {
  turnCount: number;
  missionsSet: Set<string>;
  /** Per-session hash of last recalled memory set, for change detection */
  lastMemoryHash: Map<string, string>;
  /** Per-session last synthesized memory block, reused when hash is stable */
  lastBlock: Map<string, string>;
  /** Track last retained turn count per session to avoid duplicates */
  lastRetainedTurn: Map<string, number>;
}

interface EventInput {
  event: {
    type: string;
    properties: Record<string, unknown>;
  };
}

interface CompactingInput {
  sessionID: string;
}

interface CompactingOutput {
  context: string[];
  prompt?: string;
}

interface SystemTransformInput {
  sessionID?: string;
  model: unknown;
}

interface SystemTransformOutput {
  system: string[];
}

type OpencodeClient = {
  session: {
    messages: (params: { path: { id: string } }) => Promise<{
      data?: Array<{
        info: { role: string };
        parts: Array<{ type: string; text?: string }>;
      }>;
      error?: unknown;
      request?: unknown;
      response?: unknown;
    }>;
  };
};

export interface HindsightHooks {
  event: (input: EventInput) => Promise<void>;
  "experimental.session.compacting": (
    input: CompactingInput,
    output: CompactingOutput
  ) => Promise<void>;
  "experimental.chat.system.transform": (
    input: SystemTransformInput,
    output: SystemTransformOutput
  ) => Promise<void>;
}

const MAX_CACHED_SESSIONS = 1000;

export function createHooks(
  hindsightClient: HindsightClient,
  bankId: string,
  config: HindsightConfig,
  state: PluginState,
  opencodeClient: OpencodeClient
): HindsightHooks {
  interface RecallOutcome {
    context: string | null;
    ok: boolean;
  }

  /** Recall memories and format as raw context string (used by compaction). */
  async function recallForContext(query: string): Promise<RecallOutcome> {
    try {
      const response = await hindsightClient.recall(bankId, query, {
        budget: config.recallBudget as "low" | "mid" | "high",
        maxTokens: config.recallMaxTokens,
        types: config.recallTypes,
        tags: config.recallTags.length ? config.recallTags : undefined,
        tagsMatch: config.recallTags.length ? config.recallTagsMatch : undefined,
      });

      const results = response.results || [];
      if (!results.length) return { context: null, ok: true };

      const formatted = formatMemories(results);
      const context =
        `<hindsight_memories>\n` +
        `${config.recallPromptPreamble}\n\n` +
        `${formatted}\n` +
        `</hindsight_memories>`;
      return { context, ok: true };
    } catch (e) {
      debugLog(config, "Recall failed:", e);
      return { context: null, ok: false };
    }
  }

  /** Extract plain-text messages from an OpenCode session */
  async function getSessionMessages(sessionId: string): Promise<Message[]> {
    try {
      debugLog(config, `getSessionMessages: fetching messages for session ${sessionId}`);
      const response = await opencodeClient.session.messages({
        path: { id: sessionId },
      });
      if (response.error) {
        debugLog(
          config,
          `getSessionMessages: error=${JSON.stringify(response.error)?.substring(0, 500)}`
        );
      }
      const rawMessages = response.data || [];
      const messages: Message[] = [];
      for (const msg of rawMessages) {
        const role = msg.info.role;
        if (role !== "user" && role !== "assistant") continue;
        const textParts = msg.parts.filter((p) => p.type === "text" && p.text).map((p) => p.text!);
        if (textParts.length) {
          messages.push({ role, content: textParts.join("\n") });
        }
      }
      debugLog(config, `getSessionMessages: raw=${rawMessages.length}, parsed=${messages.length}`);
      return messages;
    } catch (e) {
      debugLog(config, "Failed to get session messages:", e);
      return [];
    }
  }

  /**
   * Retain messages for a session, respecting retainMode and documentId semantics.
   * Used by both idle-retain and pre-compaction retain.
   */
  async function retainSession(sessionId: string, messages: Message[]): Promise<void> {
    const retainFullWindow = config.retainMode === "full-session";
    let targetMessages: Message[];
    let documentId: string;

    if (retainFullWindow) {
      targetMessages = messages;
      documentId = sessionId;
    } else {
      const windowTurns = config.retainEveryNTurns + config.retainOverlapTurns;
      targetMessages = sliceLastTurnsByUserBoundary(messages, windowTurns);
      documentId = `${sessionId}-${Date.now()}`;
    }

    const { transcript } = prepareRetentionTranscript(targetMessages, true);
    if (!transcript) return;

    await ensureBankMission(hindsightClient, bankId, config, state.missionsSet);
    await hindsightClient.retain(bankId, transcript, {
      documentId,
      context: config.retainContext,
      tags: config.retainTags.length ? config.retainTags : undefined,
      metadata: Object.keys(config.retainMetadata).length
        ? { ...config.retainMetadata, session_id: sessionId }
        : { session_id: sessionId },
      async: true,
    });
  }

  /** Auto-retain conversation transcript */
  async function handleSessionIdle(sessionId: string): Promise<void> {
    debugLog(config, `handleSessionIdle called for session ${sessionId}`);
    if (!config.autoRetain) return;

    const messages = await getSessionMessages(sessionId);
    if (!messages.length) return;

    const userTurns = messages.filter((m) => m.role === "user").length;
    const lastRetained = state.lastRetainedTurn.get(sessionId) || 0;
    debugLog(
      config,
      `handleSessionIdle: userTurns=${userTurns}, lastRetained=${lastRetained}, retainEveryNTurns=${config.retainEveryNTurns}`
    );

    if (userTurns - lastRetained < config.retainEveryNTurns) return;

    try {
      await retainSession(sessionId, messages);
      state.lastRetainedTurn.set(sessionId, userTurns);
      debugLog(config, `Auto-retained ${messages.length} messages for session ${sessionId}`);
    } catch (e) {
      debugLog(config, "Auto-retain failed:", e);
    }
  }

  const event = async (input: EventInput): Promise<void> => {
    try {
      const { event: evt } = input;
      debugLog(config, `event hook fired: type=${evt.type}`);

      if (evt.type === "session.idle") {
        const sessionId = (evt.properties as { sessionID?: string }).sessionID;
        if (sessionId) {
          await handleSessionIdle(sessionId);
        }
      }
    } catch (e) {
      debugLog(config, "Event hook error:", e);
    }
  };

  const compacting = async (input: CompactingInput, output: CompactingOutput): Promise<void> => {
    try {
      const messages = await getSessionMessages(input.sessionID);
      if (messages.length && config.autoRetain) {
        try {
          await retainSession(input.sessionID, messages);
          state.lastRetainedTurn.delete(input.sessionID);
          debugLog(config, "Pre-compaction retain completed");
        } catch (e) {
          debugLog(config, "Pre-compaction retain failed:", e);
        }
      }

      if (messages.length) {
        const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
        if (lastUserMsg) {
          const query = composeRecallQuery(
            lastUserMsg.content,
            messages,
            config.recallContextTurns
          );
          const truncated = truncateRecallQuery(
            query,
            lastUserMsg.content,
            config.recallMaxQueryChars
          );
          const { context } = await recallForContext(truncated);
          if (context) {
            output.context.push(context);
          }
        }
      }
    } catch (e) {
      debugLog(config, "Compaction hook error:", e);
    }
  };

  const systemTransform = async (
    input: SystemTransformInput,
    output: SystemTransformOutput
  ): Promise<void> => {
    try {
      if (!config.autoRecall) return;
      const sessionId = input.sessionID;
      if (!sessionId) return;

      // Fetch current conversation (user + assistant turns)
      const messages = await getSessionMessages(sessionId);
      if (!messages.length) return;

      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      if (!lastUserMsg) return;

      // Compose query from recent turns of both roles
      const query = truncateRecallQuery(
        composeRecallQuery(lastUserMsg.content, messages, config.recallContextTurns),
        lastUserMsg.content,
        config.recallMaxQueryChars
      );

      // Recall to detect what's relevant
      let results: Array<{ text: string; type?: string | null; mentioned_at?: string | null }>;
      try {
        const response = await hindsightClient.recall(bankId, query, {
          budget: config.recallBudget as "low" | "mid" | "high",
          maxTokens: config.recallMaxTokens,
          types: config.recallTypes,
          tags: config.recallTags.length ? config.recallTags : undefined,
          tagsMatch: config.recallTags.length ? config.recallTagsMatch : undefined,
        });
        results = response.results || [];
      } catch (e) {
        debugLog(config, "Recall failed:", e);
        return;
      }

      if (!results.length) {
        // No relevant memories — clear cache so next change is detected cleanly
        state.lastMemoryHash.delete(sessionId);
        state.lastBlock.delete(sessionId);
        return;
      }

      // Hash by memory content to detect changes
      const hash = results.map((r) => r.text).join("\0");
      const cachedHash = state.lastMemoryHash.get(sessionId);
      const cachedBlock = state.lastBlock.get(sessionId);

      if (cachedHash === hash && cachedBlock) {
        // Same memories as last turn — inject cached block for vLLM prefix cache hit
        output.system.push(cachedBlock);
        debugLog(config, `Injected stable memory block for session ${sessionId}`);
        return;
      }

      // Memory set changed — synthesize a fresh block via reflect
      await ensureBankMission(hindsightClient, bankId, config, state.missionsSet);

      let block: string;
      try {
        const reflectResponse = await hindsightClient.reflect(bankId, query, {
          budget: config.recallBudget as "low" | "mid" | "high",
        });
        if (!reflectResponse.text) return;
        block =
          `<hindsight_memories>\n` +
          `${config.recallPromptPreamble}\n\n` +
          `${reflectResponse.text}\n` +
          `</hindsight_memories>`;
      } catch (e) {
        debugLog(config, "Reflect failed, using formatted memories:", e);
        block =
          `<hindsight_memories>\n` +
          `${config.recallPromptPreamble}\n\n` +
          `${formatMemories(results)}\n` +
          `</hindsight_memories>`;
      }

      // Cap map size to prevent unbounded growth across long-running sessions
      if (state.lastMemoryHash.size >= MAX_CACHED_SESSIONS) {
        const first = state.lastMemoryHash.keys().next().value;
        if (first) {
          state.lastMemoryHash.delete(first);
          state.lastBlock.delete(first);
        }
      }

      state.lastMemoryHash.set(sessionId, hash);
      state.lastBlock.set(sessionId, block);
      output.system.push(block);
      debugLog(config, `Injected updated memory block for session ${sessionId}`);
    } catch (e) {
      debugLog(config, "System transform hook error:", e);
    }
  };

  return {
    event,
    "experimental.session.compacting": compacting,
    "experimental.chat.system.transform": systemTransform,
  };
}
