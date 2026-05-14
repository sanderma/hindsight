import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHooks, type PluginState } from "./hooks.js";
import { makeConfig } from "./test-helpers.js";

function makeState(): PluginState {
  return {
    turnCount: 0,
    missionsSet: new Set(),
    lastMemoryHash: new Map(),
    lastBlock: new Map(),
    lastRetainedTurn: new Map(),
  };
}

function makeClient() {
  return {
    retain: vi.fn().mockResolvedValue({}),
    recall: vi.fn().mockResolvedValue({ results: [] }),
    reflect: vi.fn().mockResolvedValue({ text: "" }),
    createBank: vi.fn().mockResolvedValue({}),
  } as any;
}

function makeOpencodeClient(
  messages: Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }> = []
) {
  return {
    session: {
      messages: vi.fn().mockResolvedValue({ data: messages }),
    },
  };
}

describe("createHooks", () => {
  it("returns all required hooks", () => {
    const hooks = createHooks(
      makeClient(),
      "bank",
      makeConfig(),
      makeState(),
      makeOpencodeClient()
    );
    expect(hooks.event).toBeDefined();
    expect(hooks["experimental.session.compacting"]).toBeDefined();
    expect(hooks["experimental.chat.system.transform"]).toBeDefined();
  });
});

describe("event hook — session.idle", () => {
  it("auto-retains conversation on session.idle with document_id", async () => {
    const client = makeClient();
    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "Hello" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "Hi there" }] },
    ];
    const opencodeClient = makeOpencodeClient(messages);
    const state = makeState();
    const hooks = createHooks(
      client,
      "bank",
      makeConfig({ retainEveryNTurns: 1 }),
      state,
      opencodeClient
    );

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "sess-1" } },
    });

    expect(client.retain).toHaveBeenCalledTimes(1);
    expect(client.retain.mock.calls[0][0]).toBe("bank");
    const opts = client.retain.mock.calls[0][2];
    expect(opts.documentId).toBe("sess-1");
    expect(opts.metadata.session_id).toBe("sess-1");
  });

  it("skips retain when autoRetain is false", async () => {
    const client = makeClient();
    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "Hello" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "Hi" }] },
    ];
    const hooks = createHooks(
      client,
      "bank",
      makeConfig({ autoRetain: false }),
      makeState(),
      makeOpencodeClient(messages)
    );

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "sess-1" } },
    });

    expect(client.retain).not.toHaveBeenCalled();
  });

  it("uses chunked document_id with overlap in last-turn mode", async () => {
    const client = makeClient();
    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "Turn 1" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "Reply 1" }] },
      { info: { role: "user" }, parts: [{ type: "text", text: "Turn 2" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "Reply 2" }] },
    ];
    const config = makeConfig({
      retainMode: "last-turn",
      retainEveryNTurns: 1,
      retainOverlapTurns: 1,
    });
    const state = makeState();
    const hooks = createHooks(client, "bank", config, state, makeOpencodeClient(messages));

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "sess-1" } },
    });

    expect(client.retain).toHaveBeenCalledTimes(1);
    const opts = client.retain.mock.calls[0][2];
    expect(opts.documentId).toMatch(/^sess-1-\d+$/);
  });

  it("respects retainEveryNTurns", async () => {
    const client = makeClient();
    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "Hello" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "Hi" }] },
    ];
    const config = makeConfig({ retainEveryNTurns: 5 });
    const state = makeState();
    const hooks = createHooks(client, "bank", config, state, makeOpencodeClient(messages));

    await hooks.event({
      event: { type: "session.idle", properties: { sessionID: "sess-1" } },
    });

    expect(client.retain).not.toHaveBeenCalled();
  });

  it("does not throw on client error", async () => {
    const client = makeClient();
    client.retain.mockRejectedValue(new Error("Network error"));
    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "Hello" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "Hi" }] },
    ];
    const hooks = createHooks(
      client,
      "bank",
      makeConfig({ retainEveryNTurns: 1 }),
      makeState(),
      makeOpencodeClient(messages)
    );

    await expect(
      hooks.event({
        event: { type: "session.idle", properties: { sessionID: "sess-1" } },
      })
    ).resolves.not.toThrow();
  });
});

describe("compacting hook", () => {
  it("retains before compaction and recalls context", async () => {
    const client = makeClient();
    client.recall.mockResolvedValue({
      results: [{ text: "Important fact", type: "world" }],
    });
    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "Build the feature" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "Working on it" }] },
    ];
    const output = { context: [] as string[], prompt: undefined };
    const hooks = createHooks(
      client,
      "bank",
      makeConfig(),
      makeState(),
      makeOpencodeClient(messages)
    );

    await hooks["experimental.session.compacting"]({ sessionID: "sess-1" }, output);

    expect(client.retain).toHaveBeenCalled();
    expect(client.recall).toHaveBeenCalled();
    expect(output.context.length).toBeGreaterThan(0);
    expect(output.context[0]).toContain("hindsight_memories");
    expect(output.context[0]).toContain("Important fact");
  });

  it("pre-compaction retain includes documentId and session metadata", async () => {
    const client = makeClient();
    client.recall.mockResolvedValue({ results: [] });
    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "Hello" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "Hi" }] },
    ];
    const output = { context: [] as string[] };
    const hooks = createHooks(
      client,
      "bank",
      makeConfig(),
      makeState(),
      makeOpencodeClient(messages)
    );

    await hooks["experimental.session.compacting"]({ sessionID: "sess-1" }, output);

    expect(client.retain).toHaveBeenCalledTimes(1);
    const opts = client.retain.mock.calls[0][2];
    expect(opts.documentId).toBe("sess-1");
    expect(opts.metadata.session_id).toBe("sess-1");
  });

  it("pre-compaction retain uses chunked documentId in last-turn mode", async () => {
    const client = makeClient();
    client.recall.mockResolvedValue({ results: [] });
    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "Hello" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "Hi" }] },
    ];
    const config = makeConfig({ retainMode: "last-turn", retainEveryNTurns: 1 });
    const output = { context: [] as string[] };
    const hooks = createHooks(client, "bank", config, makeState(), makeOpencodeClient(messages));

    await hooks["experimental.session.compacting"]({ sessionID: "sess-1" }, output);

    const opts = client.retain.mock.calls[0][2];
    expect(opts.documentId).toMatch(/^sess-1-\d+$/);
  });

  it("resets lastRetainedTurn so idle-retain resumes after compaction", async () => {
    const client = makeClient();
    client.recall.mockResolvedValue({ results: [] });
    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "Hello" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "Hi" }] },
    ];
    const state = makeState();
    state.lastRetainedTurn.set("sess-1", 10);
    const output = { context: [] as string[] };
    const hooks = createHooks(client, "bank", makeConfig(), state, makeOpencodeClient(messages));

    await hooks["experimental.session.compacting"]({ sessionID: "sess-1" }, output);

    expect(state.lastRetainedTurn.has("sess-1")).toBe(false);
  });

  it("does not throw on error", async () => {
    const client = makeClient();
    client.recall.mockRejectedValue(new Error("Failed"));
    const messages = [{ info: { role: "user" }, parts: [{ type: "text", text: "Test" }] }];
    const output = { context: [] as string[] };
    const hooks = createHooks(
      client,
      "bank",
      makeConfig(),
      makeState(),
      makeOpencodeClient(messages)
    );

    await expect(
      hooks["experimental.session.compacting"]({ sessionID: "s" }, output)
    ).resolves.not.toThrow();
  });
});

describe("system transform hook — per-turn recall", () => {
  const userMessage = { info: { role: "user" }, parts: [{ type: "text", text: "Help me code" }] };
  const assistantMessage = {
    info: { role: "assistant" },
    parts: [{ type: "text", text: "Sure" }],
  };

  it("calls reflect and injects synthesized block on first relevant turn", async () => {
    const client = makeClient();
    client.recall.mockResolvedValue({
      results: [{ text: "User prefers TypeScript", type: "world" }],
    });
    client.reflect.mockResolvedValue({ text: "User is a TypeScript developer." });

    const output = { system: [] as string[] };
    const hooks = createHooks(
      client,
      "bank",
      makeConfig(),
      makeState(),
      makeOpencodeClient([userMessage])
    );

    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output);

    expect(client.recall).toHaveBeenCalled();
    expect(client.reflect).toHaveBeenCalled();
    expect(output.system.length).toBe(1);
    expect(output.system[0]).toContain("hindsight_memories");
    expect(output.system[0]).toContain("User is a TypeScript developer.");
  });

  it("reuses cached block when memory set is unchanged", async () => {
    const client = makeClient();
    client.recall.mockResolvedValue({
      results: [{ text: "User prefers TypeScript", type: "world" }],
    });
    client.reflect.mockResolvedValue({ text: "User is a TypeScript developer." });

    const state = makeState();
    const hooks = createHooks(
      client,
      "bank",
      makeConfig(),
      state,
      makeOpencodeClient([userMessage, assistantMessage, userMessage])
    );

    // First turn — synthesizes via reflect
    const output1 = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output1);
    expect(client.reflect).toHaveBeenCalledTimes(1);
    expect(output1.system.length).toBe(1);

    // Second turn — same recall results, should reuse cached block
    const output2 = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output2);
    expect(client.reflect).toHaveBeenCalledTimes(1); // no new reflect call
    expect(output2.system[0]).toBe(output1.system[0]); // exact same string reference
  });

  it("re-synthesizes when memory set changes", async () => {
    const client = makeClient();
    client.recall
      .mockResolvedValueOnce({ results: [{ text: "Memory A", type: "world" }] })
      .mockResolvedValueOnce({ results: [{ text: "Memory B", type: "world" }] });
    client.reflect
      .mockResolvedValueOnce({ text: "Synthesized from A." })
      .mockResolvedValueOnce({ text: "Synthesized from B." });

    const state = makeState();
    const hooks = createHooks(
      client,
      "bank",
      makeConfig(),
      state,
      makeOpencodeClient([userMessage])
    );

    const output1 = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output1);

    const output2 = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output2);

    expect(client.reflect).toHaveBeenCalledTimes(2);
    expect(output1.system[0]).toContain("Synthesized from A.");
    expect(output2.system[0]).toContain("Synthesized from B.");
  });

  it("falls back to formatted memories when reflect fails", async () => {
    const client = makeClient();
    client.recall.mockResolvedValue({
      results: [{ text: "Raw memory fact", type: "world" }],
    });
    client.reflect.mockRejectedValue(new Error("LLM unavailable"));

    const output = { system: [] as string[] };
    const hooks = createHooks(
      client,
      "bank",
      makeConfig(),
      makeState(),
      makeOpencodeClient([userMessage])
    );

    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output);

    expect(output.system.length).toBe(1);
    expect(output.system[0]).toContain("hindsight_memories");
    expect(output.system[0]).toContain("Raw memory fact");
  });

  it("injects nothing and clears cache when recall returns no results", async () => {
    const client = makeClient();
    client.recall.mockResolvedValue({ results: [] });

    const state = makeState();
    state.lastMemoryHash.set("sess-1", "old-hash");
    state.lastBlock.set("sess-1", "<hindsight_memories>old</hindsight_memories>");

    const output = { system: [] as string[] };
    const hooks = createHooks(
      client,
      "bank",
      makeConfig(),
      state,
      makeOpencodeClient([userMessage])
    );

    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output);

    expect(output.system.length).toBe(0);
    expect(state.lastMemoryHash.has("sess-1")).toBe(false);
    expect(state.lastBlock.has("sess-1")).toBe(false);
  });

  it("skips when session has no messages yet", async () => {
    const client = makeClient();
    const output = { system: [] as string[] };
    const hooks = createHooks(
      client,
      "bank",
      makeConfig(),
      makeState(),
      makeOpencodeClient([]) // empty session
    );

    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output);

    expect(client.recall).not.toHaveBeenCalled();
    expect(output.system.length).toBe(0);
  });

  it("skips when autoRecall is false", async () => {
    const client = makeClient();
    const output = { system: [] as string[] };
    const hooks = createHooks(
      client,
      "bank",
      makeConfig({ autoRecall: false }),
      makeState(),
      makeOpencodeClient([userMessage])
    );

    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output);

    expect(client.recall).not.toHaveBeenCalled();
    expect(output.system.length).toBe(0);
  });

  it("does not throw on recall error", async () => {
    const client = makeClient();
    client.recall.mockRejectedValue(new Error("Connection refused"));
    const output = { system: [] as string[] };
    const hooks = createHooks(
      client,
      "bank",
      makeConfig(),
      makeState(),
      makeOpencodeClient([userMessage])
    );

    await expect(
      hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output)
    ).resolves.not.toThrow();
    expect(output.system.length).toBe(0);
  });

  it("uses both user and assistant turns in query context", async () => {
    const client = makeClient();
    client.recall.mockResolvedValue({ results: [] });

    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "First question" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "First answer" }] },
      { info: { role: "user" }, parts: [{ type: "text", text: "Follow-up question" }] },
    ];
    const hooks = createHooks(
      client,
      "bank",
      makeConfig({ recallContextTurns: 3 }),
      makeState(),
      makeOpencodeClient(messages)
    );

    const output = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output);

    // Recall should be called with a query that includes prior context
    expect(client.recall).toHaveBeenCalled();
    const query = client.recall.mock.calls[0][1] as string;
    expect(query).toContain("Follow-up question");
    expect(query).toContain("Prior context:");
  });

  it("block contains no timestamp (stable for vLLM prefix caching)", async () => {
    const client = makeClient();
    client.recall.mockResolvedValue({
      results: [{ text: "Some memory", type: "world" }],
    });
    client.reflect.mockResolvedValue({ text: "Synthesized context." });

    const output = { system: [] as string[] };
    const hooks = createHooks(
      client,
      "bank",
      makeConfig(),
      makeState(),
      makeOpencodeClient([userMessage])
    );

    await hooks["experimental.chat.system.transform"]({ sessionID: "sess-1", model: {} }, output);

    expect(output.system[0]).not.toMatch(/Current time:/);
    expect(output.system[0]).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
