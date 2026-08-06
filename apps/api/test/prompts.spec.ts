import { describe, expect, it } from "vitest";
import { buildApplyPrompt, parseApplyResult } from "../src/modules/ai/prompts/apply-generate.v1.js";
import { normalizeForCache, truncateText } from "../src/modules/ai/text.js";

describe("prompt template assembly (plan §8.2)", () => {
  it("apply: regeneration instruction changes the cache input and is delimited", () => {
    const base = { cvText: "CV", jdText: "JD", title: "T", company: null };
    const without = buildApplyPrompt(base);
    const withInstr = buildApplyPrompt({ ...base, instruction: "shorter" });
    expect(without.cacheInput).not.toBe(withInstr.cacheInput);
    expect(withInstr.messages[1]?.content).toContain("<user_instruction>\nshorter\n</user_instruction>");
    expect(withInstr.messages[0]?.content).toContain("HONESTY RULE");
  });
});

describe("structured-output validators (plan §8.4)", () => {
  it("parseApplyResult enforces its shape", () => {
    expect(
      parseApplyResult({
        cover_letter: "Dear…",
        answers: [{ question: "q", answer: "a" }],
        recommendations: [],
        gaps_flagged: [],
      }),
    ).not.toBeNull();
    expect(
      parseApplyResult({ cover_letter: "", answers: [], recommendations: [], gaps_flagged: [] }),
    ).toBeNull();
  });
});

describe("normalization + truncation (T5.2)", () => {
  it("normalizeForCache: lowercase + whitespace collapse", () => {
    expect(normalizeForCache("  Hello\n\n  WORLD ")).toBe("hello world");
  });

  it("short text is returned untouched, untruncated", () => {
    expect(truncateText("abc", 100)).toEqual({ text: "abc", truncated: false });
  });

  it("long text is cut at a paragraph boundary and flagged", () => {
    const head = "a".repeat(950);
    const text = `${head}\n\n${"b".repeat(200)}`;
    const result = truncateText(text, 1000);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("[...truncated]");
    // Cut happened at the paragraph break (950 > 80% of 1000), not mid-word.
    expect(result.text.startsWith(head)).toBe(true);
    expect(result.text.length).toBeLessThan(text.length);
  });
});
