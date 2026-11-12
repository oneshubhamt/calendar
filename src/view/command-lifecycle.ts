export type CalendarCommandLifecycleStatus = "completed" | "rejected" | "committed-refresh-failed" | "suppressed";

export interface CalendarCommandLifecycleHooks {
  readonly onPendingChange?: (group: string, operation: string, pending: boolean) => void;
  readonly refresh?: () => Promise<void> | void;
  /** Authoritative mutation rejected before commit. */
  readonly onError?: (error: unknown) => void;
  /** Mutation may already be committed; callers must not retry it merely because reprojection failed. */
  readonly onRefreshError?: (error: unknown) => void;
}

function notifyLifecycleHook(run: (() => void) | undefined): void {
  try { run?.(); } catch { /* presentation/notification hooks cannot redefine mutation completion */ }
}

/** Small generic coordinator for one authoritative command at a time per occurrence/group. */
export class CalendarCommandLifecycle {
  private readonly pending = new Map<string, string>();

  public isPending(group: string, operation?: string): boolean {
    const current = this.pending.get(group);
    return operation === undefined ? current !== undefined : current === operation;
  }

  public pendingOperation(group: string): string | undefined {
    return this.pending.get(group);
  }

  public async run(
    group: string,
    operation: string,
    task: () => Promise<void> | void,
    hooks: CalendarCommandLifecycleHooks = {},
  ): Promise<CalendarCommandLifecycleStatus> {
    if (this.pending.has(group)) return "suppressed";
    this.pending.set(group, operation);
    notifyLifecycleHook(() => hooks.onPendingChange?.(group, operation, true));

    let rejection: unknown;
    try {
      await task();
    } catch (error) {
      rejection = error;
    }

    let refreshFailure: unknown;
    try {
      await hooks.refresh?.();
    } catch (error) {
      refreshFailure = error;
    } finally {
      this.pending.delete(group);
      notifyLifecycleHook(() => hooks.onPendingChange?.(group, operation, false));
    }

    if (rejection !== undefined) {
      notifyLifecycleHook(() => hooks.onError?.(rejection));
      return "rejected";
    }
    if (refreshFailure !== undefined) {
      notifyLifecycleHook(() => hooks.onRefreshError?.(refreshFailure));
      return "committed-refresh-failed";
    }
    return "completed";
  }
}
