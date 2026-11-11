/**
 * Deliver observer notifications without allowing observer failures to change authoritative
 * state outcomes or prevent other observers from receiving the same invalidation.
 */
export function notifyObservers<T>(observers: Iterable<(value: T) => void>, value: T): void {
  for (const observer of [...observers]) {
    try {
      observer(value);
    } catch (error) {
      try {
        const reporter = (globalThis as { readonly reportError?: ((reason: unknown) => void) | undefined }).reportError;
        if (typeof reporter === "function") reporter(error);
      } catch {
        // Reporting is diagnostic only; observer failures never alter authoritative state.
      }
    }
  }
}
