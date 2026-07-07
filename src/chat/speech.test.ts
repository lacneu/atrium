import { describe, expect, it } from "vitest";
import { resolveSpeechLang, stripMarkdownForSpeech } from "./speech";

describe("resolveSpeechLang", () => {
  it("keeps an explicit tag", () => {
    expect(resolveSpeechLang("en-GB", "fr")).toBe("en-GB");
  });
  it("resolves auto from the UI locale", () => {
    expect(resolveSpeechLang("auto", "fr")).toBe("fr-FR");
    expect(resolveSpeechLang("auto", "en")).toBe("en-US");
  });
  it("falls back to fr-FR when the locale is empty", () => {
    expect(resolveSpeechLang("auto", "")).toBe("fr-FR");
  });
});

describe("stripMarkdownForSpeech", () => {
  it("silences code blocks and inline code", () => {
    const out = stripMarkdownForSpeech("Avant\n```js\nconst x = 1;\n```\nAprès `inline`");
    expect(out).not.toContain("const x");
    expect(out).toContain("(bloc de code)");
    expect(out).toContain("inline");
  });
  it("keeps link labels, drops urls and images", () => {
    const out = stripMarkdownForSpeech("Voir [la doc](https://ex.com/x) ![alt](img.png)");
    expect(out).toContain("la doc");
    expect(out).not.toContain("https://");
    expect(out).not.toContain("img.png");
  });
  it("flattens headings, lists and emphasis", () => {
    const out = stripMarkdownForSpeech("# Titre\n- **gras** et _italique_\n1. deux");
    expect(out).not.toMatch(/[#*_]/);
    expect(out).toContain("Titre");
    expect(out).toContain("gras et italique");
    expect(out).toContain("deux");
  });
  it("reads table cells as prose", () => {
    const out = stripMarkdownForSpeech("| a | b |\n| --- | --- |\n| x | y |");
    expect(out).toContain("a, b");
    expect(out).toContain("x, y");
    expect(out).not.toContain("|");
  });
});
