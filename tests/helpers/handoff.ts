// Where the consent form sends the browser. POST /oauth/authorize answers with
// a page that hands the browser on (a refresh and a link), not with a 302:
// Chrome applies form-action to every redirect that follows a form post.

const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** The URL of the hand-off page's refresh, or a thrown error that says what came instead. */
export function handoffTargetIn(html: string): string {
  const m = /<meta http-equiv="refresh" content="0;url=([^"]*)">/.exec(html);
  if (!m) throw new Error(`no hand-off in: ${html.slice(0, 200)}`);
  return unescape(m[1]);
}

export async function handoffTarget(res: Response): Promise<string> {
  if (res.status !== 200) throw new Error(`expected the hand-off page (200), got ${res.status}`);
  return handoffTargetIn(await res.text());
}
