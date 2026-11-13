import type { CalendarCommand, CalendarCommandContext, CalendarCommandHandler, CalendarItem, CalendarMetadata, CalendarOccurrence, CalendarRepository } from "../core/types.js";
import { RepositoryCommandHandler } from "../core/commands.js";

export interface IntegrationActionReceipt {
  readonly integration: "study-director" | "revision-director" | "practice-desk" | "calendar";
  readonly action: string;
  readonly changed: boolean;
  readonly sourceId?: string;
}

export interface SourceOpenRequest {
  readonly app: "study-director" | "revision-director" | "practice-desk";
  readonly sourceId: string;
  readonly action?: string;
  readonly metadata?: CalendarMetadata;
}

export interface SourceOpenPort {
  open(request: SourceOpenRequest): Promise<void> | void;
}

function localSourceItem(repository: CalendarRepository, occurrence: CalendarOccurrence | undefined): CalendarItem | undefined {
  if (!occurrence) return undefined;
  return repository.read().items.find(item => item.id === occurrence.sourceItemId);
}

/** Routes calendar-owned mutations to the calendar repository and Study Director plan mutations to its schedule gateway. */
type HistoryOwner = "local" | "study";

export class DirectorEcosystemCommandRouter implements CalendarCommandHandler {
  private readonly local: RepositoryCommandHandler;
  private readonly undoOrder: HistoryOwner[] = [];
  private readonly redoOrder: HistoryOwner[] = [];

  public constructor(
    private readonly repository: CalendarRepository,
    private readonly studyDirector?: CalendarCommandHandler,
    historyLimit = 100,
  ) {
    this.local = new RepositoryCommandHandler(repository, historyLimit);
  }

  public historyState(): { readonly canUndo: boolean; readonly canRedo: boolean } {
    return { canUndo: this.undoOrder.some(owner => this.handler(owner)?.historyState?.().canUndo), canRedo: this.redoOrder.some(owner => this.handler(owner)?.historyState?.().canRedo) };
  }

  public async undo(): Promise<boolean> {
    while (this.undoOrder.length) {
      const owner = this.undoOrder.pop()!;
      const handler = this.handler(owner);
      if (handler?.undo && await handler.undo()) { this.redoOrder.push(owner); return true; }
    }
    return false;
  }

  public async redo(): Promise<boolean> {
    while (this.redoOrder.length) {
      const owner = this.redoOrder.pop()!;
      const handler = this.handler(owner);
      if (handler?.redo && await handler.redo()) { this.undoOrder.push(owner); return true; }
    }
    return false;
  }

  public async execute(command: CalendarCommand, context: CalendarCommandContext): Promise<void> {
    const route = this.route(command);
    await route.handler.execute(command, context);
    this.undoOrder.push(route.owner);
    this.redoOrder.length = 0;
  }

  private handler(owner: HistoryOwner): CalendarCommandHandler | undefined {
    return owner === "local" ? this.local : this.studyDirector;
  }

  private route(command: CalendarCommand): { readonly owner: HistoryOwner; readonly handler: CalendarCommandHandler } {
    if (command.type === "create") {
      if (command.item.calendarId === "study-director:plan" && this.studyDirector) return { owner: "study", handler: this.studyDirector };
      return { owner: "local", handler: this.local };
    }
    const occurrence = "occurrence" in command ? command.occurrence : undefined;
    const local = localSourceItem(this.repository, occurrence);
    if (local) return { owner: "local", handler: this.local };
    if (occurrence?.ownership === "study-plan" && this.studyDirector) return { owner: "study", handler: this.studyDirector };
    if (command.type === "update" || command.type === "remove") {
      const item = this.repository.read().items.find(candidate => candidate.id === command.id);
      if (item) return { owner: "local", handler: this.local };
    }
    throw new Error("This projected calendar item is owned by its source application and is not directly writable here.");
  }
}


/**
 * Generic invalidation source for host-owned Calendar projections. A host with its own
 * event stream can adapt it directly; an integration controller without one can use
 * CalendarIntegrationInvalidationNotifier and call notify() after authoritative changes.
 * Polling is intentionally outside this contract.
 */
export interface CalendarIntegrationInvalidationPort {
  subscribe(listener: () => void): () => void;
}

/** Small controller-side invalidation bridge for hosts that do not already expose subscriptions. */
export class CalendarIntegrationInvalidationNotifier implements CalendarIntegrationInvalidationPort {
  private readonly listeners = new Set<() => void>();

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  public notify(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { continue; }
    }
  }
}

export function subscribeCalendarIntegrationInvalidation(
  port: CalendarIntegrationInvalidationPort | undefined,
  listener: () => void,
): () => void {
  return port?.subscribe(listener) ?? (() => {});
}
