import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCompressionPrompt, sanitizeCompressionText } from "../src/prompts/compression.js";
import { OpenAIProvider } from "../src/providers/openai.js";

afterEach(() => vi.restoreAllMocks());

describe("binary-safe compression prompts", () => {
  it("removes screenshot JPEG Base64 before token truncation", () => {
    const binary = "/9j/" + "QSkZJRgABAQA".repeat(400);
    const prompt = buildCompressionPrompt({
      hookType: "post_tool_use", timestamp: "2026-11-23",
      toolOutput: { screenshot: binary, action: "Raise", result: "accessibility state unchanged" },
    });
    expect(prompt).not.toContain(binary.slice(0, 200));
    expect(prompt).toContain("[omitted encoded binary payload]");
    expect(prompt).toContain("accessibility state unchanged");
    expect(prompt).toContain("Raise");
  });

  it("removes data:image URI and preserves adjacent metadata", () => {
    const jpeg = "data:image/jpeg;base64," + "/9j/" + "aBcD1234+eF".repeat(90);
    const prompt = buildCompressionPrompt({
      hookType: "post_tool_use", timestamp: "2026-11-23",
      toolOutput: `action: screenshot; ${jpeg}; window: Crowisp`,
    });
    expect(prompt).toContain("[omitted image/jpeg binary image]");
    expect(prompt).not.toContain("aBcD1234+eF");
    expect(prompt).toContain("window: Crowisp");
  });

  it("preserves long source identifiers that are not encoded binary", () => {
    const identifier = "a".repeat(300);
    expect(sanitizeCompressionText(identifier)).toBe(identifier);
  });
});

describe("OpenAI-compatible truncated completions", () => {
  it("rejects finish_reason=length even when the provider returned partial XML", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        choices: [{ finish_reason: "length", message: { content: "<observation><files>" } }],
      }), { status: 200 }),
    );
    const provider = new OpenAIProvider("local", "qwen3-4b", 4096, "http://localhost:1234/v1");
    await expect(provider.compress("system", "prompt")).rejects.toThrow(/incomplete/);
  });

  it("accepts complete XML with finish_reason=stop", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "<observation/>" } }],
      }), { status: 200 }),
    );
    const provider = new OpenAIProvider("local", "qwen3-4b", 4096, "http://localhost:1234/v1");
    await expect(provider.compress("system", "prompt")).resolves.toBe("<observation/>");
  });
});
