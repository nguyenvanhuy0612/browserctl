// Preloaded into a bridge process under test: the first line on stdin throws from a timer, which
// the process sees as an uncaught exception.
process.stdin.once("data", () => {
  setImmediate(() => {
    throw new Error("planted uncaught exception");
  });
});
