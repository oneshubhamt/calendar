import type { ISODateTime } from "../core/types.js";

export interface GoogleEventDateTime {
  readonly date?: string | undefined;
  readonly dateTime?: string | undefined;
  readonly timeZone?: string | undefined;
}
export interface GoogleEventReminder { readonly method: "email" | "popup"; readonly minutes: number; }
export interface GoogleCalendarEvent {
  readonly id?: string | undefined;
  readonly iCalUID?: string | undefined;
  readonly etag?: string | undefined;
  readonly status?: "confirmed" | "tentative" | "cancelled" | undefined;
  readonly summary?: string | undefined;
  readonly description?: string | undefined;
  readonly location?: string | undefined;
  readonly start?: GoogleEventDateTime | undefined;
  readonly end?: GoogleEventDateTime | undefined;
  readonly recurrence?: readonly string[] | undefined;
  readonly recurringEventId?: string | undefined;
  readonly originalStartTime?: GoogleEventDateTime | undefined;
  readonly updated?: ISODateTime | undefined;
  readonly sequence?: number | undefined;
  readonly reminders?: { readonly useDefault?: boolean | undefined; readonly overrides?: readonly GoogleEventReminder[] | undefined } | undefined;
  readonly extendedProperties?: { readonly private?: Readonly<Record<string, string>> | undefined; readonly shared?: Readonly<Record<string, string>> | undefined } | undefined;
  readonly transparency?: "opaque" | "transparent" | undefined;
}

export interface GoogleEventsPage {
  readonly items: readonly GoogleCalendarEvent[];
  readonly nextPageToken?: string | undefined;
  readonly nextSyncToken?: string | undefined;
}

export interface GoogleCalendarTransport {
  listEvents(request: {
    readonly calendarId: string;
    readonly pageToken?: string | undefined;
    readonly syncToken?: string | undefined;
    readonly timeMin?: string | undefined;
    readonly timeMax?: string | undefined;
    readonly singleEvents?: boolean | undefined;
    readonly showDeleted?: boolean | undefined;
  }): Promise<GoogleEventsPage>;
  getEvent(calendarId: string, eventId: string): Promise<GoogleCalendarEvent>;
  listInstances(calendarId: string, recurringEventId: string, pageToken?: string): Promise<GoogleEventsPage>;
  insertEvent(calendarId: string, event: GoogleCalendarEvent): Promise<GoogleCalendarEvent>;
  updateEvent(calendarId: string, eventId: string, event: GoogleCalendarEvent, etag?: string): Promise<GoogleCalendarEvent>;
  patchEvent(calendarId: string, eventId: string, patch: GoogleCalendarEvent, etag?: string): Promise<GoogleCalendarEvent>;
  deleteEvent(calendarId: string, eventId: string, etag?: string): Promise<void>;
}

export interface GoogleAccessToken { readonly accessToken: string; readonly expiresAt?: number | undefined; }
export interface GoogleAccessTokenProvider { token(): Promise<GoogleAccessToken>; }

export class GoogleCalendarHttpError extends Error {
  public constructor(public readonly status: number, message: string, public readonly body?: string) { super(message); this.name = "GoogleCalendarHttpError"; }
}
export class GoogleSyncTokenExpiredError extends Error { public constructor() { super("Google Calendar sync token expired; a new full sync is required."); this.name = "GoogleSyncTokenExpiredError"; } }

export class GoogleCalendarRestTransport implements GoogleCalendarTransport {
  public constructor(private readonly tokens: GoogleAccessTokenProvider, private readonly fetcher: typeof fetch = fetch) {}

  public async listEvents(request: Parameters<GoogleCalendarTransport["listEvents"]>[0]): Promise<GoogleEventsPage> {
    const params = new URLSearchParams();
    if (request.pageToken) params.set("pageToken", request.pageToken);
    if (request.syncToken) params.set("syncToken", request.syncToken);
    if (request.timeMin) params.set("timeMin", request.timeMin);
    if (request.timeMax) params.set("timeMax", request.timeMax);
    if (request.singleEvents !== undefined) params.set("singleEvents", String(request.singleEvents));
    if (request.showDeleted !== undefined) params.set("showDeleted", String(request.showDeleted));
    const response = await this.request(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(request.calendarId)}/events?${params}`, { method: "GET" });
    if (response.status === 410 && request.syncToken) throw new GoogleSyncTokenExpiredError();
    return parseJson<GoogleEventsPage>(response);
  }

  public async getEvent(calendarId: string, eventId: string): Promise<GoogleCalendarEvent> {
    const response = await this.request(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: "GET" });
    return parseJson<GoogleCalendarEvent>(response);
  }

  public async listInstances(calendarId: string, recurringEventId: string, pageToken?: string): Promise<GoogleEventsPage> {
    const params = new URLSearchParams(); if (pageToken) params.set("pageToken", pageToken);
    const response = await this.request(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(recurringEventId)}/instances?${params}`, { method: "GET" });
    return parseJson<GoogleEventsPage>(response);
  }

  public async insertEvent(calendarId: string, event: GoogleCalendarEvent): Promise<GoogleCalendarEvent> {
    const response = await this.request(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, { method: "POST", body: JSON.stringify(event), headers: { "Content-Type": "application/json" } });
    return parseJson<GoogleCalendarEvent>(response);
  }

  public async updateEvent(calendarId: string, eventId: string, event: GoogleCalendarEvent, etag?: string): Promise<GoogleCalendarEvent> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (etag) headers["If-Match"] = etag;
    const response = await this.request(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: "PUT", body: JSON.stringify(event), headers });
    return parseJson<GoogleCalendarEvent>(response);
  }

  public async patchEvent(calendarId: string, eventId: string, patch: GoogleCalendarEvent, etag?: string): Promise<GoogleCalendarEvent> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (etag) headers["If-Match"] = etag;
    const response = await this.request(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: "PATCH", body: JSON.stringify(patch), headers });
    return parseJson<GoogleCalendarEvent>(response);
  }

  public async deleteEvent(calendarId: string, eventId: string, etag?: string): Promise<void> {
    const headers: Record<string, string> = {};
    if (etag) headers["If-Match"] = etag;
    await this.request(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: "DELETE", headers });
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const token = await this.tokens.token();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token.accessToken}`);
    const response = await this.fetcher(url, { ...init, headers });
    if (!response.ok && response.status !== 410) throw new GoogleCalendarHttpError(response.status, `Google Calendar API request failed (${response.status}).`, await response.text());
    return response;
  }
}

export interface GoogleIdentityServicesOptions {
  readonly clientId: string;
  readonly scope: string;
  readonly prompt?: "" | "consent" | "select_account";
}

/** Browser-only token provider for Google Identity Services. No client secret is used or stored. */
export function createGoogleIdentityServicesTokenProvider(options: GoogleIdentityServicesOptions): GoogleAccessTokenProvider {
  type TokenResponse = { access_token?: string; expires_in?: number; error?: string };
  type TokenClient = { requestAccessToken: (request?: { prompt?: string }) => void };
  type GoogleGlobal = { accounts?: { oauth2?: { initTokenClient?: (input: { client_id: string; scope: string; callback: (response: TokenResponse) => void }) => TokenClient } } };
  let cached: GoogleAccessToken | null = null;
  let pending: Promise<GoogleAccessToken> | null = null;
  return {
    async token() {
      if (cached && (!cached.expiresAt || cached.expiresAt - Date.now() > 60_000)) return cached;
      if (pending) return pending;
      pending = new Promise<GoogleAccessToken>((resolve, reject) => {
        const google = (globalThis as { google?: GoogleGlobal }).google;
        const init = google?.accounts?.oauth2?.initTokenClient;
        if (!init) { reject(new Error("Google Identity Services is not available on this page.")); return; }
        const client = init({ client_id: options.clientId, scope: options.scope, callback: response => {
          pending = null;
          if (!response.access_token || response.error) { reject(new Error(response.error || "Google authorization failed.")); return; }
          cached = { accessToken: response.access_token, ...(response.expires_in ? { expiresAt: Date.now() + response.expires_in * 1000 } : {}) };
          resolve(cached);
        } });
        client.requestAccessToken({ prompt: options.prompt ?? "" });
      });
      return pending;
    },
  };
}

export const GOOGLE_CALENDAR_SCOPES = Object.freeze({
  overlay: "https://www.googleapis.com/auth/calendar.events.readonly",
  ownedEvents: "https://www.googleapis.com/auth/calendar.events.owned",
  allEvents: "https://www.googleapis.com/auth/calendar.events",
} as const);

async function parseJson<T>(response: Response): Promise<T> { if (!response.ok) throw new GoogleCalendarHttpError(response.status, `Google Calendar API request failed (${response.status}).`, await response.text()); return await response.json() as T; }
