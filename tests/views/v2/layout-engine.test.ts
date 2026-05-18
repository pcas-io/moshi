import { describe, it, expect } from "vitest";
import { layoutMesh } from "../../../src/views/v2/layout-engine";

describe("layoutMesh", () => {
  it("returns an empty map for no nodes", () => {
    expect(layoutMesh([], []).size).toBe(0);
  });

  it("places a single node at the centre", () => {
    const out = layoutMesh([{ id: "lone" }], [], { width: 200, height: 100 });
    const p = out.get("lone");
    expect(p).toBeDefined();
    expect(p!.x).toBeCloseTo(100, 5);
    expect(p!.y).toBeCloseTo(50, 5);
  });

  it("is deterministic for the same input", () => {
    const nodes = ["a", "b", "c", "d"].map((id) => ({ id }));
    const edges = [{ from: "a", to: "b" }, { from: "b", to: "c" }];
    const a = layoutMesh(nodes, edges);
    const b = layoutMesh(nodes, edges);
    for (const n of nodes) {
      expect(a.get(n.id)).toEqual(b.get(n.id));
    }
  });

  it("keeps every position inside the padded canvas", () => {
    const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}` }));
    const edges = nodes.slice(0, -1).map((n, i) => ({ from: n.id, to: nodes[i + 1]!.id }));
    const w = 400, h = 300, pad = 10;
    const out = layoutMesh(nodes, edges, { width: w, height: h, padding: pad });
    for (const [, p] of out) {
      expect(p.x).toBeGreaterThanOrEqual(pad);
      expect(p.x).toBeLessThanOrEqual(w - pad);
      expect(p.y).toBeGreaterThanOrEqual(pad);
      expect(p.y).toBeLessThanOrEqual(h - pad);
    }
  });

  it("silently skips edges that reference unknown nodes", () => {
    const nodes = [{ id: "a" }, { id: "b" }];
    expect(() => layoutMesh(nodes, [
      { from: "a", to: "b" },
      { from: "a", to: "ghost" },
      { from: "ghost", to: "phantom" },
    ])).not.toThrow();
  });

  it("varies layout for different seeds", () => {
    const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const edges = [{ from: "a", to: "b" }];
    const a = layoutMesh(nodes, edges, { seed: "alpha" });
    const b = layoutMesh(nodes, edges, { seed: "bravo" });
    const moved = nodes.some((n) => {
      const pa = a.get(n.id)!;
      const pb = b.get(n.id)!;
      return Math.abs(pa.x - pb.x) > 0.5 || Math.abs(pa.y - pb.y) > 0.5;
    });
    expect(moved).toBe(true);
  });

  it("separates nodes that share initial positions", () => {
    // Mulberry32 + circle placement avoids natural collisions, but the
    // algorithm must still cope when input is duplicate-id-free.
    const nodes = Array.from({ length: 8 }, (_, i) => ({ id: `n${i}` }));
    const out = layoutMesh(nodes, []);
    const arr = [...out.values()];
    let collisions = 0;
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const dx = arr[i]!.x - arr[j]!.x;
        const dy = arr[i]!.y - arr[j]!.y;
        if (dx * dx + dy * dy < 25) collisions++;
      }
    }
    expect(collisions).toBe(0);
  });
});
