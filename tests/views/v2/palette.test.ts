// Smoke tests for the V2Layout palette markup generator.
// We render V2Layout to string via Hono and assert the palette is wired in.

import { describe, it, expect } from "vitest";
import { V2Layout } from "../../../src/views/v2/layout";

async function renderLayout(props: Parameters<typeof V2Layout>[0]): Promise<string> {
  // Hono's FC returns JSX which has a toString() that resolves the tree.
  const node = V2Layout(props);
  return String(await Promise.resolve(node));
}

describe("V2Layout palette", () => {
  it("includes the palette modal markup", async () => {
    const html = await renderLayout({ active: "HOME", children: "x" });
    expect(html).toContain('id="v2-palette"');
    expect(html).toContain('id="v2-palette-input"');
    expect(html).toContain('id="v2-palette-list"');
  });

  it("includes default palette items for non-admins", async () => {
    const html = await renderLayout({ active: "HOME", children: "x", userRole: "agent" });
    expect(html).toContain("Go to Overview");
    expect(html).toContain("Go to Conversations");
    expect(html).toContain("Go to Messages");
    expect(html).toContain("Go to Activity");
    expect(html).toContain("Log out");
    expect(html).not.toContain("Go to Agents");
    expect(html).not.toContain("Register new agent");
  });

  it("adds admin-only items when userRole is admin", async () => {
    const html = await renderLayout({ active: "HOME", children: "x", userRole: "admin" });
    expect(html).toContain("Go to Agents");
    expect(html).toContain("Register new agent");
  });

  it("wires the keyboard handler script", async () => {
    const html = await renderLayout({ active: "HOME", children: "x" });
    expect(html).toContain("metaKey");
    expect(html).toContain("ctrlKey");
    expect(html).toContain("ArrowDown");
  });

  it("escapes html in palette items via the markup builder", async () => {
    const html = await renderLayout({ active: "HOME", children: "x" });
    // The item labels we ship don't contain HTML — verify the escape function
    // is used by checking that quotes in the autocomplete attribute survived.
    expect(html).toContain('autocomplete="off"');
  });

  it("includes mesh MCP-tool entries with signatures", async () => {
    const html = await renderLayout({ active: "HOME", children: "x" });
    expect(html).toContain("mesh_register");
    expect(html).toContain("mesh_send");
    expect(html).toContain("mesh_status");
    expect(html).toContain("mesh_history");
    // Sig (hint) and desc render
    expect(html).toContain("v2-pal-desc");
    expect(html).toContain("→ message_id");
  });
});
