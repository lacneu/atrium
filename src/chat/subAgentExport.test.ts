import { describe, it, expect } from "vitest";
import {
  buildSubAgentExportMarkdown,
  subAgentExportFilename,
} from "./subAgentExport";

describe("buildSubAgentExportMarkdown", () => {
  it("includes the task, config, each tool's input/output, and the result", () => {
    const md = buildSubAgentExportMarkdown({
      taskName: "find AI news",
      status: "done",
      parentAgentLabel: "Atrium",
      sessionMeta: { model: "gpt-5.5", modelProvider: "openai", thinkingLevel: "high" },
      result: "## 1. Headline\n- summary",
      tools: [
        {
          name: "web_search",
          status: "error",
          argsText: '{"query":"AI news"}',
          resultText: "tool failed",
        },
        {
          name: "web_fetch",
          status: "done",
          argsText: '{"url":"https://x"}',
          resultText: "PAGE BODY",
        },
      ],
    });
    // Title + the model config line.
    expect(md).toContain("find AI news");
    expect(md).toContain("gpt-5.5");
    expect(md).toContain("openai");
    // Each tool with its name, status, and BOTH input + output (the user's own data).
    expect(md).toContain("web_search");
    expect(md).toContain('{"query":"AI news"}');
    expect(md).toContain("tool failed");
    expect(md).toContain("web_fetch");
    expect(md).toContain("PAGE BODY");
    // The result markdown is included RAW (not fenced), so its heading survives.
    expect(md).toContain("## 1. Headline");
  });

  it("omits sections that have no data (no empty tools / result headers)", () => {
    const md = buildSubAgentExportMarkdown({
      status: "running",
      tools: [],
    });
    // No tools -> no Tools header; no result -> no Result header.
    expect(md).not.toMatch(/##\s.*\(0\)/);
    expect(md.toLowerCase()).not.toContain("undefined");
  });

  it("filename is a safe, short slug of the task", () => {
    expect(subAgentExportFilename("Find the 10 AI news!")).toBe(
      "sous-agent-find-the-10-ai-news.md",
    );
    expect(subAgentExportFilename(undefined)).toBe("sous-agent.md");
    expect(subAgentExportFilename("   ")).toBe("sous-agent.md");
  });
});
