/**
 * Integration tests for the Hindsight OpenCode plugin.
 *
 * Tests the per-turn recall pipeline against a live Hindsight API:
 *   - systemTransform injects a block when relevant memories exist
 *   - Second call with identical messages reuses the cached block (no extra reflect)
 *   - Block clears when recall returns nothing
 *
 * Requirements:
 *   Running Hindsight API at HINDSIGHT_API_URL (default: http://localhost:8888)
 *   LLM configured on that server (needed for retain + reflect)
 *
 * Run:
 *   HINDSIGHT_API_URL=http://localhost:8888 npm run test:integration
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { HindsightClient } from "@vectorize-io/hindsight-client";
import { createHooks, type PluginState } from "../src/hooks.js";
import { makeConfig } from "../src/test-helpers.js";

const HINDSIGHT_API_URL = process.env.HINDSIGHT_API_URL || "http://localhost:8888";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomBankId(): string {
  return `opencode_test_${Math.random().toString(36).slice(2, 14)}`;
}

function makeState(): PluginState {
  return {
    turnCount: 0,
    missionsSet: new Set(),
    lastMemoryHash: new Map(),
    lastBlock: new Map(),
    lastRetainedTurn: new Map(),
  };
}

function makeOpencodeClient(messages: Array<{ role: string; content: string }>) {
  return {
    session: {
      messages: vi.fn().mockResolvedValue({
        data: messages.map((m) => ({
          info: { role: m.role },
          parts: [{ type: "text", text: m.content }],
        })),
      }),
    },
  };
}

async function waitForApi(url: string, maxMs = 5000): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Poll recall until at least one result appears or timeout. */
async function waitForMemories(
  client: HindsightClient,
  bankId: string,
  query: string,
  maxMs = 30_000
): Promise<boolean> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const { results } = await client.recall(bankId, query, { maxTokens: 256 });
    if (results.length > 0) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("opencode integration — per-turn recall", () => {
  let client: HindsightClient;

  beforeAll(async () => {
    const reachable = await waitForApi(HINDSIGHT_API_URL);
    if (!reachable) {
      throw new Error(
        `Hindsight API not reachable at ${HINDSIGHT_API_URL}. ` +
          "Start the server before running integration tests."
      );
    }
    client = new HindsightClient({ baseUrl: HINDSIGHT_API_URL });
  });

  it("injects memory block when relevant memories exist", async () => {
    const bankId = randomBankId();

    await client.retain(
      bankId,
      "[role: user]\nI always use Rust for systems programming.\n[user:end]\n\n" +
        "[role: assistant]\nRust is excellent for that!\n[assistant:end]",
      { documentId: bankId, async: true }
    );

    const ready = await waitForMemories(client, bankId, "programming language preference");
    expect(ready).toBe(true);

    const state = makeState();
    const messages = [{ role: "user", content: "What language should I use for a new CLI tool?" }];
    const hooks = createHooks(
      client,
      bankId,
      makeConfig(),
      state,
      makeOpencodeClient(messages) as any
    );

    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output);

    expect(output.system.length).toBe(1);
    expect(output.system[0]).toContain("<hindsight_memories>");
    expect(output.system[0]).toContain("</hindsight_memories>");
    // Block must not contain a timestamp (cache stability)
    expect(output.system[0]).not.toMatch(/Current time:/);
  }, 60_000);

  it("reuses cached block on second call with same messages (no extra reflect)", async () => {
    const bankId = randomBankId();

    await client.retain(
      bankId,
      "[role: user]\nI prefer functional programming with pure functions.\n[user:end]\n\n" +
        "[role: assistant]\nFunctional style keeps code predictable!\n[assistant:end]",
      { documentId: bankId, async: true }
    );

    const ready = await waitForMemories(client, bankId, "programming style preference");
    expect(ready).toBe(true);

    const messages = [{ role: "user", content: "How should I structure this data transform?" }];
    const state = makeState();
    const reflectSpy = vi.spyOn(client, "reflect");

    const hooks = createHooks(
      client,
      bankId,
      makeConfig(),
      state,
      makeOpencodeClient(messages) as any
    );

    // First call — should hit reflect to synthesize
    const output1 = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output1);
    expect(output1.system.length).toBe(1);
    const reflectCallsAfterFirst = reflectSpy.mock.calls.length;

    // Second call — same messages, same recall results → cache hit, no new reflect
    const output2 = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output2);
    expect(output2.system.length).toBe(1);
    expect(output2.system[0]).toBe(output1.system[0]); // exact same cached string
    expect(reflectSpy.mock.calls.length).toBe(reflectCallsAfterFirst); // no new reflect call

    reflectSpy.mockRestore();
  }, 60_000);

  it("injects nothing and clears cache when recall returns no results", async () => {
    const bankId = randomBankId(); // empty bank — no memories

    const state = makeState();
    // Pre-seed cache to verify it gets cleared
    state.lastMemoryHash.set("sess-1", "stale-hash");
    state.lastBlock.set("sess-1", "<hindsight_memories>stale</hindsight_memories>");

    const messages = [{ role: "user", content: "What is the weather like today?" }];
    const hooks = createHooks(
      client,
      bankId,
      makeConfig(),
      state,
      makeOpencodeClient(messages) as any
    );

    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output);

    expect(output.system.length).toBe(0);
    expect(state.lastMemoryHash.has("sess-1")).toBe(false);
    expect(state.lastBlock.has("sess-1")).toBe(false);
  }, 30_000);

  it("uses both user and assistant turns to build richer query", async () => {
    const bankId = randomBankId();

    await client.retain(
      bankId,
      "[role: user]\nI work on distributed systems at scale.\n[user:end]\n\n" +
        "[role: assistant]\nI'll keep distributed systems context in mind.\n[assistant:end]",
      { documentId: bankId, async: true }
    );

    const ready = await waitForMemories(client, bankId, "distributed systems work");
    expect(ready).toBe(true);

    // Multi-turn conversation — assistant's previous response adds context for recall
    const messages = [
      { role: "user", content: "I'm building a new service." },
      { role: "assistant", content: "What kind of service? Distributed or single-node?" },
      { role: "user", content: "Something similar to what I usually do." },
    ];
    const state = makeState();
    const hooks = createHooks(
      client,
      bankId,
      makeConfig({ recallContextTurns: 3 }),
      state,
      makeOpencodeClient(messages) as any
    );

    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output);

    // Multi-turn context should surface the distributed systems memory
    expect(output.system.length).toBe(1);
    expect(output.system[0]).toContain("<hindsight_memories>");
  }, 60_000);
});
