// name → role, for the avatar lookups of the Log and Conversations pages.
//
// The names looked up here come from history rows, and messages outlive
// their agent by 30 days. A plain object would answer "constructor" with an
// inherited function, which the avatar then tried to lower-case: one deleted
// agent with that name turned both pages into an HTTP 500. This index owns
// nothing it was not given.

export type RoleIndex = Record<string, string | null>;

export function roleIndex(
  agents: ReadonlyArray<{ name: string; role: string | null }>,
): RoleIndex {
  const index: RoleIndex = Object.create(null);
  for (const agent of agents) index[agent.name] = agent.role;
  return index;
}
