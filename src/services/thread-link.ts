// The one shape of a link to an open conversation.
//
// There were three: the Conversations rows carried `#thread`, Home's card and
// the attention band did not. The anchor decides where a tap lands, so which
// of the three a reader had followed decided whether they saw the thread they
// asked for — which reads as random. One function, three callers.
//
// Pure, and in services rather than in the view, because the attention list
// composes its own hrefs and a service may not import a view.

/** `/conversations?id=…#thread`. `extraQs` is an already-encoded query
 *  string (paging, filters) and is appended before the anchor. */
export function threadHref(id: string, extraQs = ""): string {
  const query = `id=${encodeURIComponent(id)}${extraQs ? `&${extraQs}` : ""}`;
  return `/conversations?${query}#thread`;
}
