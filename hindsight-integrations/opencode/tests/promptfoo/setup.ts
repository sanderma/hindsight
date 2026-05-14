/**
 * Promptfoo eval setup script.
 *
 * Retains each scenario's conversation history to a dedicated Hindsight bank,
 * waits until memories are available, then writes generated-tests.json so
 * both providers (session-start and per-turn) query the SAME extracted
 * memories — making the comparison apples-to-apples.
 *
 * Run before `promptfoo eval`:
 *   npx tsx tests/promptfoo/setup.ts
 *
 * Or via the combined script:
 *   npm run eval
 *
 * Output: tests/promptfoo/generated-tests.json  (git-ignored)
 *
 * Requires: HINDSIGHT_API_URL (default: http://localhost:8888)
 */

import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HindsightClient } from "@vectorize-io/hindsight-client";
import { scenarios, type Turn } from "./scenarios.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const HINDSIGHT_API_URL = process.env.HINDSIGHT_API_URL || "http://localhost:8888";
const WAIT_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 1_500;

function randomBankId(): string {
  return `promptfoo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function buildTranscript(turns: Turn[]): string {
  return turns
    .map((t) => `[role: ${t.role}]\n${t.content}\n[${t.role}:end]`)
    .join("\n\n");
}

async function waitForMemories(
  client: HindsightClient,
  bankId: string,
  query: string
): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { results } = await client.recall(bankId, query, { maxTokens: 256 });
    if (results.length > 0) return;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.warn(`  ⚠ Timed out waiting for memories in bank ${bankId}`);
}

async function main() {
  const client = new HindsightClient({ baseUrl: HINDSIGHT_API_URL });

  // Verify server is up
  try {
    await fetch(`${HINDSIGHT_API_URL}/health`, { signal: AbortSignal.timeout(3000) });
  } catch {
    console.error(`✗ Hindsight API not reachable at ${HINDSIGHT_API_URL}`);
    process.exit(1);
  }

  console.log(`Setting up ${scenarios.length} scenarios against ${HINDSIGHT_API_URL}\n`);

  const generatedTests: Array<{
    description: string;
    vars: { bankId: string; question: string };
    assert: Array<{ type: string; value: string }>;
    options: { timeout: number };
  }> = [];

  for (const [i, scenario] of scenarios.entries()) {
    const bankId = randomBankId();
    console.log(`[${i + 1}/${scenarios.length}] ${scenario.description}`);
    console.log(`  Bank: ${bankId}`);

    // Retain conversation history
    await client.retain(bankId, buildTranscript(scenario.history), {
      documentId: bankId,
      async: true,
    });

    // Wait until at least one memory is available
    const lastUserTurn = [...scenario.history].reverse().find((t) => t.role === "user");
    if (lastUserTurn) {
      process.stdout.write("  Waiting for memories...");
      await waitForMemories(client, bankId, lastUserTurn.content);
      console.log(" ready");
    }

    generatedTests.push({
      description: scenario.description,
      vars: { bankId, question: scenario.question },
      assert: scenario.assert,
      options: { timeout: 90_000 },
    });
  }

  const outputPath = join(__dirname, "generated-tests.json");
  writeFileSync(outputPath, JSON.stringify(generatedTests, null, 2));
  console.log(`\n✓ Written to ${outputPath}`);
  console.log(`\nRun the eval:\n  cd tests/promptfoo && npx promptfoo@latest eval`);
}

main().catch((e) => {
  console.error("Setup failed:", e);
  process.exit(1);
});
