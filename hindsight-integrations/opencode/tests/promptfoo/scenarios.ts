/**
 * Shared scenario definitions for promptfoo evaluation.
 *
 * Single source of truth for histories, questions, and assertions.
 * setup.ts reads this, retains each history to a fresh bank, and
 * writes generated-tests.json with the bankId added.
 */

export interface Turn {
  role: string;
  content: string;
}

export interface Assertion {
  type: string;
  value: string;
}

export interface Scenario {
  description: string;
  history: Turn[];
  question: string;
  assert: Assertion[];
}

export const scenarios: Scenario[] = [
  {
    description: "Recalls user's programming language preference",
    history: [
      {
        role: "user",
        content:
          "I always write systems code in Rust. It's my go-to for anything performance-critical.",
      },
      {
        role: "assistant",
        content: "Rust is excellent for that — zero-cost abstractions and memory safety.",
      },
    ],
    question: "What language should I use for a new CLI tool?",
    assert: [
      {
        type: "llm-rubric",
        value:
          "The response recommends or strongly considers Rust based on the user's stated preference",
      },
      { type: "icontains", value: "rust" },
    ],
  },

  {
    description: "Recalls user's database preference",
    history: [
      {
        role: "user",
        content:
          "All my AI projects use PostgreSQL with pgvector. I never use anything else for vector storage.",
      },
      {
        role: "assistant",
        content: "pgvector is a solid choice — it keeps your vector store inside Postgres.",
      },
    ],
    question: "What database should I use for my new embedding search feature?",
    assert: [
      {
        type: "llm-rubric",
        value:
          "The response recommends PostgreSQL or pgvector based on the user's stated preference",
      },
      { type: "icontains", value: "postgres" },
    ],
  },

  {
    description: "Uses assistant turn context to surface relevant memory",
    history: [
      { role: "user", content: "I'm a backend engineer focused on distributed systems." },
      {
        role: "assistant",
        content:
          "I'll keep that in mind — distributed systems work often involves consensus protocols, eventual consistency, and high-availability design.",
      },
      { role: "user", content: "I'm building a new service." },
      {
        role: "assistant",
        content: "Is this a stateful service or stateless? And do you need it to be highly available?",
      },
    ],
    question: "What architecture patterns fit my usual work?",
    assert: [
      {
        type: "llm-rubric",
        value:
          "The response mentions distributed systems, high availability, or related patterns relevant to a backend engineer's typical work",
      },
    ],
  },

  {
    description: "Targeted recall: surfaces correct memory for specific question",
    history: [
      {
        role: "user",
        content:
          "For frontend work I always use React with TypeScript. Never Vue or Angular.",
      },
      {
        role: "assistant",
        content: "React + TypeScript is a powerful and well-supported combination.",
      },
      {
        role: "user",
        content: "I also prefer Tailwind for styling over CSS-in-JS solutions.",
      },
      {
        role: "assistant",
        content: "Tailwind makes styling fast once you know the utility classes.",
      },
    ],
    question: "What CSS approach should I use for this new dashboard?",
    assert: [
      {
        type: "llm-rubric",
        value: "The response recommends Tailwind CSS based on the user's stated preference",
      },
      { type: "icontains", value: "tailwind" },
    ],
  },

  {
    description: "Surfaces correct memory when multiple preferences stored",
    history: [
      {
        role: "user",
        content: "I prefer pytest for Python testing and always use fixtures for setup.",
      },
      { role: "assistant", content: "Pytest fixtures are very flexible for test setup." },
      { role: "user", content: "For JavaScript I use Vitest, not Jest." },
      { role: "assistant", content: "Vitest is faster and has better ESM support." },
    ],
    question: "What test framework should I use for a new Python library?",
    assert: [
      {
        type: "llm-rubric",
        value: "The response recommends pytest (not Jest or Vitest) for the Python library",
      },
      { type: "icontains", value: "pytest" },
    ],
  },

  {
    description: "Does not misapply unrelated memory",
    history: [
      { role: "user", content: "I prefer dark mode in all my editors and terminals." },
      { role: "assistant", content: "Dark mode is easier on the eyes for long coding sessions." },
    ],
    question: "What is the time complexity of quicksort in the average case?",
    assert: [
      { type: "icontains", value: "O(n log n)" },
      {
        type: "llm-rubric",
        value:
          "The response correctly states O(n log n) average case and does not mention editor themes",
      },
    ],
  },
];
