// The one place a test may set a timer: to end a run that has hung, so the test fails instead of hanging the
// suite. A passing test never waits on it. `pnpm lint` refuses timers anywhere else in the tests.

/** Calls `expire` after `ms` unless the returned function is called first. Keeps nothing alive on its own. */
export function backstop(ms: number, expire: () => void): () => void {
  const timer = setTimeout(expire, ms)
  timer.unref()
  return () => clearTimeout(timer)
}
