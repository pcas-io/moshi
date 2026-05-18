// Force-directed layout for the mesh-topology graph.
// Pure function — given nodes + edges, returns deterministic {x, y} positions.
// Determinism comes from a seeded RNG so server-rendered output is stable
// across requests for the same input.

export interface LayoutNode {
  id: string;
}

export interface LayoutEdge {
  from: string;
  to: string;
  weight?: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface LayoutOptions {
  width?: number;
  height?: number;
  iterations?: number;
  /** Repulsion magnitude between every pair of nodes. */
  charge?: number;
  /** Ideal edge length. Spring force pulls connected nodes towards this. */
  linkDistance?: number;
  /** Gravity towards the centre. */
  gravity?: number;
  /** Padding kept clear from the canvas border. */
  padding?: number;
  /** Initial-placement radius as a fraction of min(width, height).
   *  Higher values start nodes further from centre — useful when the
   *  graph has many nodes and gravity tends to over-cluster them. */
  initialRadiusFactor?: number;
  /** Seed for deterministic initial placement. */
  seed?: string;
}

const DEFAULTS: Required<Omit<LayoutOptions, "seed">> & { seed: string } = {
  width: 520,
  height: 260,
  iterations: 240,
  charge: 1600,
  linkDistance: 90,
  gravity: 0.04,
  padding: 18,
  initialRadiusFactor: 0.32,
  seed: "moshi-v2",
};

// Mulberry32 — small, fast, deterministic PRNG.
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * Compute force-directed positions for a graph. Returns a Map keyed by
 * node id. Edges referring to unknown node ids are silently skipped —
 * this lets callers pass the full message-edge list without filtering.
 */
export function layoutMesh(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  opts: LayoutOptions = {},
): Map<string, Point> {
  const o = { ...DEFAULTS, ...opts };
  const positions = new Map<string, Point>();
  const velocities = new Map<string, Point>();

  if (nodes.length === 0) return positions;

  // Seeded initial placement on a circle around the centre.
  const rng = mulberry32(hashString(o.seed));
  const cx = o.width / 2;
  const cy = o.height / 2;
  const r0 = Math.min(o.width, o.height) * o.initialRadiusFactor;
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const angle = (i / nodes.length) * Math.PI * 2 + rng() * 0.5;
    const radius = r0 * (0.6 + rng() * 0.6);
    positions.set(node.id, {
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
    });
    velocities.set(node.id, { x: 0, y: 0 });
  }

  // Skip edges whose endpoints are not in the node set.
  const validEdges = edges.filter(
    (e) => positions.has(e.from) && positions.has(e.to),
  );

  // Single node: pin to centre.
  if (nodes.length === 1) {
    positions.set(nodes[0]!.id, { x: cx, y: cy });
    return positions;
  }

  for (let step = 0; step < o.iterations; step++) {
    // Cooling factor so movement settles over time.
    const alpha = 1 - step / o.iterations;
    const damping = 0.78;

    // Pairwise repulsion.
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]!;
      const pa = positions.get(a.id)!;
      const va = velocities.get(a.id)!;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]!;
        const pb = positions.get(b.id)!;
        const vb = velocities.get(b.id)!;
        let dx = pa.x - pb.x;
        let dy = pa.y - pb.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          // Co-located — nudge apart with a deterministic jitter.
          dx = (rng() - 0.5) * 0.5;
          dy = (rng() - 0.5) * 0.5;
          d2 = dx * dx + dy * dy + 0.01;
        }
        const force = (o.charge * alpha) / d2;
        const dist = Math.sqrt(d2);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        va.x += fx;
        va.y += fy;
        vb.x -= fx;
        vb.y -= fy;
      }
    }

    // Spring attraction along edges.
    for (const edge of validEdges) {
      const pa = positions.get(edge.from)!;
      const pb = positions.get(edge.to)!;
      const va = velocities.get(edge.from)!;
      const vb = velocities.get(edge.to)!;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const w = edge.weight ?? 1;
      // Stronger weight = shorter resting length.
      const rest = o.linkDistance / Math.max(0.5, Math.log2(1 + w));
      const k = 0.06 * alpha * Math.min(2, w);
      const force = (dist - rest) * k;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      va.x += fx;
      va.y += fy;
      vb.x -= fx;
      vb.y -= fy;
    }

    // Gravity towards centre + integrate.
    for (const node of nodes) {
      const p = positions.get(node.id)!;
      const v = velocities.get(node.id)!;
      v.x += (cx - p.x) * o.gravity * alpha;
      v.y += (cy - p.y) * o.gravity * alpha;
      v.x *= damping;
      v.y *= damping;
      // Cap velocity to prevent divergence early on.
      const speed = Math.sqrt(v.x * v.x + v.y * v.y);
      const maxSpeed = 30 * alpha + 1;
      if (speed > maxSpeed) {
        v.x = (v.x / speed) * maxSpeed;
        v.y = (v.y / speed) * maxSpeed;
      }
      p.x += v.x;
      p.y += v.y;
      // Clamp inside the padded canvas.
      p.x = Math.max(o.padding, Math.min(o.width - o.padding, p.x));
      p.y = Math.max(o.padding, Math.min(o.height - o.padding, p.y));
    }
  }

  return positions;
}
