/**
 * Promptfoo custom provider for Hindsight OpenCode recall quality evaluation.
 *
 * Two modes, selected via provider config `recallMode`:
 *
 *   "session-start" (old behavior):
 *     Recalls once at session start with a generic query.
 *     Reuses that block for all subsequent turns.
 *
 *   "per-turn" (new behavior):
 *     Recalls every turn using the full conversation context as query.
 *     Synthesizes a fresh block via reflect when the memory set changes.
 *
 * Running both against the same scenarios directly answers:
 *   "Did the change improve recall quality or make it worse?"
 *
 * Environment variables required:
 *   HINDSIGHT_API_URL          Hindsight server (default: http://localhost:8888)
 *   LLM_BASE_URL               OpenAI-compatible chat endpoint
 *   LLM_API_KEY                API key for the chat endpoint
 *   LLM_MODEL                  Model name (default: gpt-4o-mini)
 */

import { HindsightClient } from "@vectorize-io/hindsight-client";

const HINDSIGHT_API_URL = process.env.HINDSIGHT_API_URL || "http://localhost:8888";
const LLM_BASE_URL = process.env.LLM_BASE_URL || "https://api.openai.com/v1";
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";

const RECALL_BUDGET = "mid";
const RECALL_MAX_TOKENS = 1024;
const RECALL_CONTEXT_TURNS = 3;
const RECALL_MAX_QUERY_CHARS = 800;
const PREAMBLE =
  "Relevant memories from past conversations. Only use memories directly useful here; ignore the rest:";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Turn {
  role: string;
  content: string;
}

function randomBankId(): string {
  return `promptfoo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildTranscript(turns: Turn[]): string {
  return turns
    .map((t) => `[role: ${t.role}]\n${t.content}\n[${t.role}:end]`)
    .join("\n\n");
}

/** Poll recall until at least one result appears or timeout. */
async function waitForMemories(
  client: HindsightClient,
  bankId: string,
  query: string,
  maxMs = 30_000
): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const { results } = await client.recall(bankId, query, { maxTokens: 256 });
    if (results.length > 0) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.warn(`[Hindsight] waitForMemories timed out for bank ${bankId}`);
}

function stripMemoryTags(content: string): string {
  return content
    .replace(/<hindsight_memories>[\s\S]*?<\/hindsight_memories>/g, "")
    .replace(/<relevant_memories>[\s\S]*?<\/relevant_memories>/g, "");
}

function sliceLastTurns(messages: Turn[], n: number): Turn[] {
  if (n <= 0) return [];
  let usersSeen = 0;
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      usersSeen++;
      if (usersSeen >= n) { start = i; break; }
    }
  }
  return start === -1 ? [...messages] : messages.slice(start);
}

function buildQuery(latestUserMsg: string, history: Turn[], contextTurns: number): string {
  const latest = latestUserMsg.trim();
  if (contextTurns <= 1 || !history.length) return latest;

  const contextSlice = sliceLastTurns(history, contextTurns);
  const lines: string[] = [];
  for (const m of contextSlice) {
    const content = stripMemoryTags(m.content).trim();
    if (!content || (m.role === "user" && content === latest)) continue;
    lines.push(`${m.role}: ${content}`);
  }
  if (!lines.length) return latest;

  const composed = `Prior context:\n\n${lines.join("\n")}\n\n${latest}`;
  return composed.length <= RECALL_MAX_QUERY_CHARS
    ? composed
    : latest.slice(0, RECALL_MAX_QUERY_CHARS);
}

async function recallBlock(
  client: HindsightClient,
  bankId: string,
  query: string
): Promise<string | null> {
  const { results } = await client.recall(bankId, query, {
    budget: RECALL_BUDGET,
    maxTokens: RECALL_MAX_TOKENS,
  });
  if (!results.length) return null;
  const formatted = results
    .map((r: { text: string; type?: string | null }) => {
      const typeStr = r.type ? ` [${r.type}]` : "";
      return `- ${r.text}${typeStr}`;
    })
    .join("\n\n");
  return `<hindsight_memories>\n${PREAMBLE}\n\n${formatted}\n</hindsight_memories>`;
}

async function reflectBlock(
  client: HindsightClient,
  bankId: string,
  query: string,
  fallbackResults: Array<{ text: string; type?: string | null }>
): Promise<string> {
  try {
    const { text } = await client.reflect(bankId, query, { budget: RECALL_BUDGET });
    if (text) {
      return `<hindsight_memories>\n${PREAMBLE}\n\n${text}\n</hindsight_memories>`;
    }
  } catch {
    // fall through to raw format
  }
  const formatted = fallbackResults
    .map((r) => `- ${r.text}${r.type ? ` [${r.type}]` : ""}`)
    .join("\n\n");
  return `<hindsight_memories>\n${PREAMBLE}\n\n${formatted}\n</hindsight_memories>`;
}

async function callLlm(systemPrompt: string | null, userPrompt: string): Promise<string> {
  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: userPrompt });

  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({ model: LLM_MODEL, messages }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM call failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? "";
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface ProviderConfig {
  recallMode?: "session-start" | "per-turn";
}

interface CallContext {
  vars: {
    history?: Turn[];
    question?: string;
  };
}

export default {
  id: "hindsight-opencode",

  async callApi(
    prompt: string,
    context: CallContext,
    options: { config?: ProviderConfig }
  ): Promise<{ output: string }> {
    const recallMode = options?.config?.recallMode ?? "per-turn";
    const history: Turn[] = context.vars.history ?? [];
    const question = context.vars.question ?? prompt;

    const client = new HindsightClient({ baseUrl: HINDSIGHT_API_URL });
    const bankId = randomBankId();

    // Retain conversation history
    if (history.length > 0) {
      await client.retain(bankId, buildTranscript(history), {
        documentId: bankId,
        async: true,
      });

      // Wait until at least one memory is available before proceeding
      const lastUserTurn = [...history].reverse().find((m) => m.role === "user");
      if (lastUserTurn) {
        await waitForMemories(client, bankId, lastUserTurn.content);
      }
    }

    let systemPrompt: string | null = null;

    if (recallMode === "session-start") {
      // Old behavior: generic query at session start, reused for all turns
      systemPrompt = await recallBlock(client, bankId, "project context and recent work");
    } else {
      // New behavior: per-turn recall with conversation context, synthesized via reflect
      const allTurns: Turn[] = [...history, { role: "user", content: question }];
      const query = buildQuery(question, allTurns, RECALL_CONTEXT_TURNS);

      const { results } = await client.recall(bankId, query, {
        budget: RECALL_BUDGET,
        maxTokens: RECALL_MAX_TOKENS,
      });

      if (results.length > 0) {
        systemPrompt = await reflectBlock(client, bankId, query, results);
      }
    }

    const output = await callLlm(systemPrompt, question);
    return { output };
  },
};
