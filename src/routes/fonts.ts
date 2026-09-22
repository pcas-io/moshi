// GET /fonts/<file>: the woff2 files of src/views/fonts.ts and the two
// licence texts. Public, like the pages that need them before a sign-in.
//
// A fixed list, read once: nothing a request says is ever joined to a path.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { FONT_FILES } from "../views/fonts.js";

const LICENCES = ["OFL-sora.txt", "OFL-jetbrainsmono.txt"] as const;
const YEAR = "public, max-age=31536000, immutable";

function load(): Map<string, { bytes: Buffer; type: string; cache: string }> {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../../public/fonts");
  const files = new Map<string, { bytes: Buffer; type: string; cache: string }>();
  for (const name of FONT_FILES) files.set(name, { bytes: readFileSync(join(dir, name)), type: "font/woff2", cache: YEAR });
  // The licence may change its wording; its name does not change with it.
  for (const name of LICENCES) files.set(name, { bytes: readFileSync(join(dir, name)), type: "text/plain; charset=utf-8", cache: "public, max-age=86400" });
  return files;
}

// biome-ignore lint/suspicious/noExplicitAny: the app's env types are not needed here
export function registerFontRoutes(app: Hono<any>): void {
  const files = load();
  app.get("/fonts/:file", (c) => {
    const asset = files.get(c.req.param("file"));
    if (!asset) return c.json({ error: "not_found" }, 404);
    return new Response(new Uint8Array(asset.bytes), {
      status: 200,
      headers: { "Content-Type": asset.type, "Content-Length": String(asset.bytes.length), "Cache-Control": asset.cache },
    });
  });
}
