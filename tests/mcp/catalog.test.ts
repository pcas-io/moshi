import { describe, it, expect } from "vitest";
import { createHarness } from "./harness";
import { MCP_TOOL_CATALOG } from "../../src/mcp/catalog";

/** Rough parameter names as printed in a catalog signature: the part
 *  before "→", split on commas, stripped of `?`, defaults and notes. */
function signatureParams(signature: string): string[] {
  const inside = signature.split("→")[0].replace(/^\s*\(|\)\s*$/g, "");
  return inside
    .split(",")
    .map((p) => p.trim().split(/[?=\s:]/)[0])
    .filter(Boolean);
}

describe("MCP tool catalog (C4)", () => {
  it("lists exactly the registered tools", async () => {
    const h = createHarness();
    const client = await h.connect("alpha");
    const registered = (await client.listTools()).tools.map((t) => t.name).sort();
    const listed = MCP_TOOL_CATALOG.map((t) => t.name).sort();
    expect(listed).toEqual(registered);
  });

  it("signatures name only parameters the tool schema actually has", async () => {
    const h = createHarness();
    const client = await h.connect("alpha");
    const tools = (await client.listTools()).tools;
    for (const ref of MCP_TOOL_CATALOG) {
      const tool = tools.find((t) => t.name === ref.name)!;
      const schemaProps = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      );
      for (const p of signatureParams(ref.signature)) {
        expect(schemaProps, `${ref.name}: "${p}" is not a parameter`).toContain(p);
      }
    }
  });
});
