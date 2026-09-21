// Loaded before anything else (`node --import ./docker/early-signals.mjs …`).
//
// node is PID 1 in the container, and PID 1 gets no default signal handling.
// The service installs its SIGTERM handler at the end of its start-up; until
// then (the TypeScript loader, the imports, the migrations) a SIGTERM was
// simply dropped, and the container sat there until Docker killed it 30 s
// later. A deploy that is cancelled right after it began does exactly that.
//
// One listener per signal, installed now and never replaced: the service
// swaps the FUNCTION it delegates to (src/index.tsx).
const stop = { handle: () => process.exit(0) };
globalThis.__moshiStop = stop;
process.on("SIGTERM", () => stop.handle("SIGTERM"));
process.on("SIGINT", () => stop.handle("SIGINT"));
