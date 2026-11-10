import type {
  CalendarCollisionPolicy,
  CalendarCommand,
  CalendarCommandHandler,
  CalendarId,
  CalendarItem,
  CalendarItemPatch,
  CalendarOccurrence,
  CalendarOccurrenceCapabilityProvider,
  CalendarOccurrenceCommand,
  CalendarPlacementGuard,
  CalendarSource,
  CalendarTemporalSpec,
} from "../core/types.js";
import type { CalendarClock } from "../core/time.js";
import type {
  CalendarCreateDraft,
  CalendarPlacementValidationPort,
  CalendarSourceActionPort,
} from "./types.js";
import {
  calendarOccurrenceCommandContext,
  resolveOccurrenceCapabilities,
  temporalMutationCapabilityRequirements,
  type CalendarOccurrenceCapabilityKey,
  type ResolvedCalendarOccurrenceCapabilities,
} from "../core/authority.js";
import { evaluateCalendarPlacement } from "../core/interaction.js";
import { addDays, startOfDay, toDate } from "../core/time.js";
import { boundProjectionRange, type ResolvedCalendarNavigationBounds } from "./navigation.js";
import { CalendarCommandLifecycle, type CalendarCommandLifecycleStatus } from "./command-lifecycle.js";
import { occurrenceWithPreview, previewPatchForCommand, type PendingOccurrencePreview } from "./occurrence-preview.js";
import { resolveSourceActions, type ResolvedCalendarSourceAction } from "./presentation.js";
import { CalendarEngine } from "../core/calendar-engine.js";

export type CalendarMutationDispatchResult = CalendarCommandLifecycleStatus | "cancelled";

export function mutationCommitted(status: CalendarMutationDispatchResult): boolean {
  return status === "completed" || status === "committed-refresh-failed";
}

interface CalendarMutationCoordinatorOptions {
  readonly engine: CalendarEngine;
  readonly clock: CalendarClock;
  readonly timeZone: string;
  readonly navigationBounds: ResolvedCalendarNavigationBounds;
  readonly collisionPolicy: CalendarCollisionPolicy;
  readonly placementGuards: readonly CalendarPlacementGuard[] | undefined;
  readonly commandHandler: CalendarCommandHandler | undefined;
  readonly trustedHostCommandHandler: CalendarCommandHandler | undefined;
  readonly occurrenceCapabilities: CalendarOccurrenceCapabilityProvider | undefined;
  readonly sourceActions: CalendarSourceActionPort | undefined;
  readonly sources: () => readonly CalendarSource[];
  readonly occurrence: (occurrenceId: string) => CalendarOccurrence | undefined;
  readonly refresh: () => Promise<void>;
  readonly announce: (message: string) => void;
  readonly onCommand: (command: CalendarCommand) => void;
  readonly onPendingChange: (occurrenceId: string, operation: string, pending: boolean) => void;
  readonly onSettled: () => void;
  readonly confirmPlacementWarning: (messages: readonly string[], action: string) => Promise<boolean>;
}

function isPointOccurrence(occurrence: CalendarOccurrence): boolean {
  return occurrence.temporalForm === "point";
}

function isDateLikeOccurrence(occurrence: CalendarOccurrence): boolean {
  return Boolean(occurrence.allDay || occurrence.precision === "date" || occurrence.temporal?.kind === "date");
}

export class CalendarMutationCoordinator {
  private readonly lifecycle = new CalendarCommandLifecycle();
  private readonly pendingPreviews = new Map<string, PendingOccurrencePreview>();

  public constructor(private readonly options: CalendarMutationCoordinatorOptions) {}

  public authoritativeOccurrence(occurrence: CalendarOccurrence): CalendarOccurrence {
    return this.options.occurrence(occurrence.occurrenceId) ?? occurrence;
  }

  public capabilities(occurrence: CalendarOccurrence): ResolvedCalendarOccurrenceCapabilities {
    const authoritative = this.authoritativeOccurrence(occurrence);
    const source = this.options.sources().find(candidate => candidate.id === authoritative.calendarId);
    return resolveOccurrenceCapabilities(authoritative, source, this.options.occurrenceCapabilities);
  }

  public commandHandlerFor(
    occurrence: CalendarOccurrence,
    capabilities = this.capabilities(occurrence),
  ): CalendarCommandHandler | undefined {
    return capabilities.commandPath === "trusted-host"
      ? this.options.trustedHostCommandHandler
      : this.options.commandHandler;
  }

  public hasCommandPath(
    occurrence: CalendarOccurrence,
    capabilities = this.capabilities(occurrence),
  ): boolean {
    return Boolean(this.commandHandlerFor(occurrence, capabilities));
  }

  public canMove(occurrence: CalendarOccurrence): boolean {
    const capabilities = this.capabilities(occurrence);
    return capabilities.canMove && this.hasCommandPath(occurrence, capabilities);
  }

  public canResize(occurrence: CalendarOccurrence, edge: "start" | "end"): boolean {
    const capabilities = this.capabilities(occurrence);
    const allowed = edge === "start" ? capabilities.canResizeStart : capabilities.canResizeEnd;
    return allowed && this.hasCommandPath(occurrence, capabilities);
  }

  public canDelete(occurrence: CalendarOccurrence): boolean {
    const capabilities = this.capabilities(occurrence);
    return capabilities.canDelete && this.hasCommandPath(occurrence, capabilities);
  }

  public canOpen(occurrence: CalendarOccurrence): boolean {
    return this.capabilities(occurrence).canOpen;
  }

  public canInvokeActions(occurrence: CalendarOccurrence): boolean {
    return this.capabilities(occurrence).canInvokeActions;
  }

  public canMoveToPlacement(occurrence: CalendarOccurrence, allDay: boolean): boolean {
    if (!this.canMove(occurrence)) return false;
    if (isPointOccurrence(occurrence) && allDay) return false;
    if (isDateLikeOccurrence(occurrence) === allDay) return true;
    return this.capabilities(occurrence).canMoveBetweenAllDayAndTimed;
  }

  public isPending(occurrence: CalendarOccurrence | string): boolean {
    return this.lifecycle.isPending(typeof occurrence === "string" ? occurrence : occurrence.occurrenceId);
  }

  public pendingOperation(occurrenceId: string): string | undefined {
    return this.lifecycle.pendingOperation(occurrenceId);
  }

  public previewOccurrence(occurrence: CalendarOccurrence): CalendarOccurrence {
    const preview = this.pendingPreviews.get(occurrence.occurrenceId);
    return preview ? occurrenceWithPreview(occurrence, preview, this.options.timeZone) : occurrence;
  }

  public sourceItem(occurrence: CalendarOccurrence): CalendarItem | undefined {
    return this.options.engine.snapshot().items.find(item => item.id === occurrence.sourceItemId);
  }

  public patchRequirements(
    occurrence: CalendarOccurrence,
    patch: CalendarItemPatch,
  ): CalendarOccurrenceCapabilityKey[] {
    const requirements = new Set<CalendarOccurrenceCapabilityKey>();
    const semanticEdit = patch.calendarId !== undefined
      || patch.title !== undefined
      || patch.description !== undefined
      || patch.location !== undefined
      || patch.kind !== undefined
      || patch.editPolicy !== undefined
      || patch.reminders !== undefined
      || patch.display !== undefined
      || patch.metadata !== undefined
      || patch.temporalForm !== undefined;
    if (semanticEdit) requirements.add("canEdit");
    if (patch.recurrence !== undefined) requirements.add("canChangeRecurrence");

    const beforeTemporal = occurrence.temporal;
    const afterTemporal = patch.temporal === null ? undefined : patch.temporal ?? beforeTemporal;
    const beforeStart = this.resolveDraftTime(occurrence.start, beforeTemporal).getTime();
    const beforeEnd = this.resolveDraftTime(occurrence.end, beforeTemporal).getTime();
    const afterStart = this.resolveDraftTime(patch.start ?? occurrence.start, afterTemporal).getTime();
    const afterEnd = this.resolveDraftTime(patch.end ?? occurrence.end, afterTemporal).getTime();
    const targetDateLike = Boolean(
      (patch.allDay ?? occurrence.allDay)
      || (patch.precision ?? occurrence.precision) === "date"
      || afterTemporal?.kind === "date",
    );
    const temporalRequirements = temporalMutationCapabilityRequirements({
      beforeStart,
      beforeEnd,
      afterStart,
      afterEnd,
      crossesAllDayBoundary: isDateLikeOccurrence(occurrence) !== targetDateLike,
    });
    for (const requirement of temporalRequirements) requirements.add(requirement);
    if (
      temporalRequirements.length === 0
      && (patch.temporal !== undefined || patch.precision !== undefined || patch.allDay !== undefined)
    ) requirements.add("canEdit");
    return [...requirements];
  }

  public async allowPlacement(
    start: Date,
    end: Date,
    allDay: boolean,
    occurrence: CalendarOccurrence | undefined,
    action: string,
    calendarId: CalendarId | undefined = occurrence?.calendarId,
  ): Promise<boolean> {
    const context = {
      start: start.toISOString(),
      end: end.toISOString(),
      allDay,
      action,
      timeZone: this.options.timeZone,
      ...(calendarId ? { calendarId } : {}),
      ...(occurrence ? { occurrence } : {}),
    };
    const evaluation = await evaluateCalendarPlacement(context, {
      navigationBounds: this.options.navigationBounds,
      guards: this.options.placementGuards,
      collisionPolicy: this.options.collisionPolicy,
      loadCollisionOccurrences: async () => {
        const queryStart = addDays(startOfDay(start, this.options.timeZone), -1, this.options.timeZone);
        const queryEnd = addDays(startOfDay(end, this.options.timeZone), 2, this.options.timeZone);
        const queryRange = boundProjectionRange(
          { start: queryStart.toISOString(), end: queryEnd.toISOString() },
          this.options.navigationBounds,
          this.options.timeZone,
        );
        const allSources = new Set(this.options.sources().map(source => source.id));
        const result = await this.options.engine.query(queryRange, {
          visibleSourceIds: allSources,
          timeZone: this.options.timeZone,
          includeBackgroundRanges: false,
        });
        return result.occurrences;
      },
    });

    if (evaluation.mode === "prevent") {
      this.options.announce(`${action} blocked. ${evaluation.messages.join(" ")}`);
      return false;
    }
    if (evaluation.mode === "allow") return true;

    const allowed = await this.options.confirmPlacementWarning(evaluation.messages, action);
    if (!allowed) this.options.announce(`${action} cancelled after a scheduling warning.`);
    return allowed;
  }

  public placementValidationPort(): CalendarPlacementValidationPort {
    return {
      canPlaceDraft: async (draft, original, action = "create") => this.allowPlacement(
        this.resolveDraftTime(draft.start, draft.temporal),
        this.resolveDraftTime(draft.end, draft.temporal),
        Boolean(draft.allDay),
        original,
        action,
        draft.calendarId,
      ),
    };
  }

  public sourceActionsFor(occurrence: CalendarOccurrence): readonly ResolvedCalendarSourceAction[] {
    const authoritative = this.authoritativeOccurrence(occurrence);
    if (!this.canInvokeActions(authoritative)) return [];
    return resolveSourceActions(this.options.sourceActions, authoritative);
  }

  public async executeSourceAction(actionId: string, occurrence: CalendarOccurrence): Promise<void> {
    const port = this.options.sourceActions;
    if (!port) return;
    const authoritative = this.authoritativeOccurrence(occurrence);
    const status = await this.lifecycle.run(authoritative.occurrenceId, `action:${actionId}`, async () => {
      if (!this.capabilities(authoritative).canInvokeActions) {
        throw new Error(`${authoritative.title}: this action is no longer allowed.`);
      }
      const current = this.sourceActionsFor(authoritative).find(action => action.id === actionId);
      if (!current || !current.enabled || current.pending) {
        throw new Error(`${authoritative.title}: this action is no longer available.`);
      }
      await port.execute(actionId, authoritative);
    }, {
      onPendingChange: this.options.onPendingChange,
      refresh: this.options.refresh,
      onError: error => this.options.announce(
        error instanceof Error ? error.message : "Source action could not be completed.",
      ),
      onRefreshError: error => this.options.announce(
        error instanceof Error
          ? `Action was committed, but the authoritative refresh failed: ${error.message}`
          : "Action was committed, but the authoritative refresh failed. Do not retry the action; refresh Calendar instead.",
      ),
    });
    if (status === "completed") this.options.announce(`${authoritative.title}: action completed.`);
    else if (status === "suppressed") {
      this.options.announce(`${authoritative.title}: a command is already pending.`);
    }
  }

  public async dispatchOccurrence(
    command: CalendarOccurrenceCommand,
    requirements: readonly CalendarOccurrenceCapabilityKey[],
    operation: string,
  ): Promise<CalendarCommandLifecycleStatus> {
    const occurrence = this.authoritativeOccurrence(command.occurrence);
    if (this.lifecycle.isPending(occurrence.occurrenceId)) {
      this.options.announce(`${occurrence.title}: a command is already pending.`);
      return "suppressed";
    }

    const previewPatch = previewPatchForCommand(command);
    if (previewPatch) this.pendingPreviews.set(occurrence.occurrenceId, { patch: previewPatch });
    const status = await this.lifecycle.run(occurrence.occurrenceId, operation, async () => {
      const capabilities = this.capabilities(occurrence);
      if (requirements.some(key => capabilities[key] !== true)) {
        throw new Error(`${occurrence.title}: this action is no longer allowed.`);
      }
      const handler = this.commandHandlerFor(occurrence, capabilities);
      if (!handler) throw new Error(`${occurrence.title}: no command path is available for this action.`);
      await handler.execute(
        command,
        calendarOccurrenceCommandContext(command, this.options.clock.now().toISOString(), this.options.timeZone),
      );
      this.options.onCommand(command);
    }, {
      onPendingChange: this.options.onPendingChange,
      refresh: this.options.refresh,
      onError: error => this.options.announce(
        error instanceof Error ? error.message : "Calendar command could not be completed.",
      ),
      onRefreshError: error => this.options.announce(
        error instanceof Error
          ? `Calendar change was committed, but the authoritative refresh failed: ${error.message}`
          : "Calendar change was committed, but the authoritative refresh failed. Do not retry the mutation; refresh Calendar instead.",
      ),
    });

    this.pendingPreviews.delete(occurrence.occurrenceId);
    this.options.onSettled();
    return status;
  }

  public async dispatch(command: CalendarCommand): Promise<void> {
    if (
      command.type === "update-occurrence"
      || command.type === "move-occurrence"
      || command.type === "resize-occurrence"
      || command.type === "cancel-occurrence"
    ) {
      throw new Error("Occurrence commands must use the capability-aware command path");
    }
    const handler = this.options.commandHandler;
    if (!handler) throw new Error("Calendar mutation requires a command handler");
    await handler.execute(command, {
      now: this.options.clock.now().toISOString(),
      timeZone: this.options.timeZone,
    });
    this.options.onCommand(command);
    await this.options.refresh();
  }

  public async undo(): Promise<boolean> {
    const undo = this.options.commandHandler?.undo;
    if (!undo) return false;
    const changed = await undo.call(this.options.commandHandler);
    if (changed) {
      this.options.announce("Calendar change undone.");
      await this.options.refresh();
    }
    return changed;
  }

  public async redo(): Promise<boolean> {
    const redo = this.options.commandHandler?.redo;
    if (!redo) return false;
    const changed = await redo.call(this.options.commandHandler);
    if (changed) {
      this.options.announce("Calendar change redone.");
      await this.options.refresh();
    }
    return changed;
  }

  private resolveDraftTime(value: string, temporal: CalendarTemporalSpec | undefined): Date {
    if (temporal?.kind === "date") return toDate(value, this.options.timeZone);
    if (temporal?.kind === "zoned") return toDate(value, temporal.timeZone ?? this.options.timeZone);
    if (temporal?.kind === "floating") return toDate(value, this.options.timeZone);
    return toDate(value);
  }
}
