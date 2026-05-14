/**
 * Promptfoo custom provider for Hindsight OpenCode recall quality evaluation.
 *
 * Two modes, selected via provider config `recallMode`:
 *
 *   "session-start" (old behavior):
 *     Recalls once at session start with a generic query.
 *
 *   "per-turn" (new behavior):
 *     Recalls using the current question as query, synthesizes via reflect.
 *
 * Both providers receive the same pre-populated bankId from generated-tests.json
 * (created by setup.ts), so they query identical extracted memories.
 * The only variable is the recall strategy — making the comparison apples-to-apples.
 *
 * Environment variables:
 *   HINDSIGHT_API_URL   Hindsight server (default: http://localhost:8888)
 *   LLM_BASE_URL        OpenAI-compatible endpoint
 *   LLM_API_KEY         API key
 *   LLM_MODEL           Model name (default: gpt-4o-mini)
 */

import { HindsightClient } from "@vectorize-io/hindsight-client";

const HINDSIGHT_API_URL = process.env.HINDSIGHT_API_URL || "http://localhost:8888";
const LLM_BASE_URL = process.env.LLM_BASE_URL || "https://api.openai.com/v1";
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";

const RECALL_BUDGET = "mid";
const RECALL_MAX_TOKENS = 1024;
const PREAMBLE =
  "Relevant memories from past conversations. Only use memories directly useful here; ignore the rest:";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function recallRaw(
  client: HindsightClient,
  bankId: string,
  query: string
): Promise<Array<{ text: string; type?: string | null }>> {
  const { results } = await client.recall(bankId, query, {
    budget: RECALL_BUDGET,
    maxTokens: RECALL_MAX_TOKENS,
  });
  return results;
}

function formatBlock(content: string): string {
  return `<hindsight_memories>\n${PREAMBLE}\n\n${content}\n</hindsight_memories>`;
}

function formatRaw(results: Array<{ text: string; type?: string | null }>): string {
  return results
    .map((r) => `- ${r.text}${r.type ? ` [${r.type}]` : ""}`)
    .join("\n\n");
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
    throw new Error(`LLM call failed (${res.status}): ${await res.text()}`);
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
    bankId?: string;
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
    const bankId = context.vars.bankId;
    const question = context.vars.question ?? prompt;

    if (!bankId) throw new Error("bankId missing from vars — did you run setup.ts?");

    const client = new HindsightClient({ baseUrl: HINDSIGHT_API_URL });

    let systemPrompt: string | null = null;

    if (recallMode === "session-start") {
      // Old behavior: generic query, no synthesis
      const results = await recallRaw(client, bankId, "project context and recent work");
      if (results.length > 0) {
        systemPrompt = formatBlock(formatRaw(results));
      }
    } else {
      // New behavior: query from the actual message, synthesize via reflect
      const results = await recallRaw(client, bankId, question);
      if (results.length > 0) {
        try {
          const { text } = await client.reflect(bankId, question, { budget: RECALL_BUDGET });
          systemPrompt = text ? formatBlock(text) : formatBlock(formatRaw(results));
        } catch {
          systemPrompt = formatBlock(formatRaw(results));
        }
      }
    }

    const output = await callLlm(systemPrompt, question);
    return { output };
  },
};
