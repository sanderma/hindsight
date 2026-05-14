import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the HindsightClient before importing the plugin
vi.mock("@vectorize-io/hindsight-client", () => {
  const MockHindsightClient = vi.fn(function (this: any) {
    this.retain = vi.fn().mockResolvedValue({});
    this.recall = vi.fn().mockResolvedValue({ results: [] });
    this.reflect = vi.fn().mockResolvedValue({ text: "" });
    this.createBank = vi.fn().mockResolvedValue({});
  });
  return { HindsightClient: MockHindsightClient };
});

import { HindsightPlugin } from "./index.js";
import { HindsightClient } from "@vectorize-io/hindsight-client";

const mockPluginInput = {
  client: {
    session: {
      messages: vi.fn().mockResolvedValue({ data: [] }),
    },
  },
  project: { id: "test-project", worktree: "/tmp/test", vcs: "git" },
  directory: "/tmp/test-project",
  worktree: "/tmp/test-project",
  serverUrl: new URL("http://localhost:3000"),
  $: {} as any,
};

describe("HindsightPlugin", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("HINDSIGHT_")) delete process.env[key];
    }
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns empty hooks when no API URL configured", async () => {
    const result = await HindsightPlugin(mockPluginInput as any);
    expect(result).toEqual({});
    expect(HindsightClient).not.toHaveBeenCalled();
  });

  it("returns tools and hooks when configured", async () => {
    process.env.HINDSIGHT_API_URL = "http://localhost:8888";

    const result = await HindsightPlugin(mockPluginInput as any);

    expect(HindsightClient).toHaveBeenCalledWith({
      baseUrl: "http://localhost:8888",
      apiKey: undefined,
    });

    expect(result.tool).toBeDefined();
    expect(result.tool!.hindsight_retain).toBeDefined();
    expect(result.tool!.hindsight_recall).toBeDefined();
    expect(result.tool!.hindsight_reflect).toBeDefined();
    expect(result.event).toBeDefined();
    expect(result["experimental.session.compacting"]).toBeDefined();
    expect(result["experimental.chat.system.transform"]).toBeDefined();
  });

  it("passes API key when configured", async () => {
    process.env.HINDSIGHT_API_URL = "http://localhost:8888";
    process.env.HINDSIGHT_API_TOKEN = "my-token";

    await HindsightPlugin(mockPluginInput as any);

    expect(HindsightClient).toHaveBeenCalledWith({
      baseUrl: "http://localhost:8888",
      apiKey: "my-token",
    });
  });

  it("accepts plugin options", async () => {
    const result = await HindsightPlugin(mockPluginInput as any, {
      hindsightApiUrl: "http://example.com",
      bankId: "custom-bank",
    });

    expect(result.tool).toBeDefined();
    expect(HindsightClient).toHaveBeenCalledWith({
      baseUrl: "http://example.com",
      apiKey: undefined,
    });
  });
});

describe("HindsightPlugin state sharing", () => {
  beforeEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("HINDSIGHT_")) delete process.env[key];
    }
    vi.clearAllMocks();
  });

  it("shares cached memory state across multiple plugin instantiations", async () => {
    process.env.HINDSIGHT_API_URL = "http://localhost:8888";

    const messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "Hello" }] },
    ];
    const pluginInputWithMessages = {
      ...mockPluginInput,
      client: {
        session: {
          messages: vi.fn().mockResolvedValue({ data: messages }),
        },
      },
    };

    // Simulate two plugin instances (OpenCode instantiates per session)
    const result1 = await HindsightPlugin(pluginInputWithMessages as any);
    const result2 = await HindsightPlugin(pluginInputWithMessages as any);

    // Prime the cache via instance 1
    const client1 = (HindsightClient as any).mock.instances[0];
    client1.recall.mockResolvedValue({ results: [{ text: "Cached memory", type: "world" }] });
    client1.reflect.mockResolvedValue({ text: "Synthesized block." });

    const output1 = { system: [] as string[] };
    await result1["experimental.chat.system.transform"]!(
      { sessionID: "sess-A", model: {} },
      output1
    );
    expect(output1.system.length).toBe(1);

    // Instance 2 should see the cached block (module-level state is shared)
    const client2 = (HindsightClient as any).mock.instances[1];
    client2.recall.mockResolvedValue({ results: [{ text: "Cached memory", type: "world" }] });

    const output2 = { system: [] as string[] };
    await result2["experimental.chat.system.transform"]!(
      { sessionID: "sess-A", model: {} },
      output2
    );

    // Cache hit — reflect not called on instance 2
    expect(client2.reflect).not.toHaveBeenCalled();
    expect(output2.system[0]).toBe(output1.system[0]);
  });
});

describe("plugin default export", () => {
  it("default-exports the Plugin function itself", async () => {
    const mod = await import("./index.js");
    expect(typeof mod.default).toBe("function");
    // OpenCode iterates Object.entries(mod) and calls every export as a
    // Plugin factory, deduping by reference. The default export must be
    // the same reference as the named HindsightPlugin export to avoid
    // running the factory twice.
    expect(mod.default).toBe(mod.HindsightPlugin);
  });
});
