import type { calendar_v3 } from 'googleapis';
import { calendar } from './googleCalendar';
import { supabase } from './supabase';
import { encodeEventMetadata, decodeEventMetadata, CATEGORY_COLORS } from './eventMetadata';

const BURNER_CALENDAR_ID = process.env.GOOGLE_BURNER_CALENDAR_ID!;

const PAGE_SIZE = 250;
const MAX_PAGES_PER_CALENDAR_PER_RUN = 20;
const MAX_TOTAL_RUNTIME_MS = 50_000;
const GOOGLE_WRITE_CONCURRENCY = 3;
const SYNC_HORIZON_DAYS = 365;
const MAX_RETRIES = 5;
const BASE_RETRY_DELAY_MS = 500;

interface SyncStateRow {
  source_calendar_id: string;
  source_calendar_summary: string | null;
  sync_token: string | null;
  page_token: string | null;
  backfill_time_min: string | null;
  backfill_time_max: string | null;
  last_synced_at: string | null;
  last_attempted_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
}

interface MappingRow {
  source_calendar_id: string;
  source_event_id: string;
  burner_event_id: string;
  etag: string | null;
  source_updated_at: string | null;
}

export interface CalendarSyncSummary {
  calendarId: string;
  calendarSummary: string;
  mode: 'backfill' | 'incremental';
  status: 'complete' | 'in_progress' | 'error';
  created: number;
  updated: number;
  deleted: number;
  skipped: number;
  pagesProcessed: number;
  errorMessage: string | null;
}

export interface SyncRunResult {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  truncatedByTimeBudget: boolean;
  calendars: CalendarSyncSummary[];
}

function errorStatusCode(err: unknown): number | undefined {
  const e = err as { code?: number; response?: { status?: number } };
  return e.code ?? e.response?.status;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The Calendar API enforces a much tighter burst limit on writes than reads —
// firing even a handful of concurrent inserts at one calendar (the burner
// calendar, targeted by every source calendar's writes) reliably trips a
// 403 "Rate Limit Exceeded" during a large first backfill. Google's own
// guidance for this is exponential backoff, not fewer concurrent requests
// alone. 429s and 5xx are also transient/retryable; a bare 403 without the
// rate-limit message is a real permission problem and should fail fast.
function isRetryableError(err: unknown): boolean {
  const status = errorStatusCode(err);
  if (status === 429 || status === 500 || status === 503) return true;
  if (status === 403) {
    const message = err instanceof Error ? err.message : '';
    return /rate limit/i.test(message);
  }
  return false;
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > MAX_RETRIES || !isRetryableError(err)) throw err;
      const delay = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 250;
      await sleep(delay);
    }
  }
}

// Collects per-task failures instead of rejecting on the first one. A plain
// Promise.all would fail fast while sibling tasks keep running detached in
// the background — their successful Google writes would never make it into
// the caller's upsert/delete batch, orphaning real burner events with no
// synced_events row to show for them (invisible duplicates on the next retry).
async function runInBatches(tasks: Array<() => Promise<void>>, concurrency: number): Promise<unknown[]> {
  const queue = [...tasks];
  const errors: unknown[] = [];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) || 1 }, async () => {
    while (queue.length > 0) {
      const task = queue.shift();
      if (!task) continue;
      try {
        await task();
      } catch (err) {
        errors.push(err);
      }
    }
  });
  await Promise.all(workers);
  return errors;
}

// `calendarList.list()` cannot be used here: it only reflects calendars a
// human has explicitly added to their own Google Calendar UI. Sharing a
// calendar with the service account's email grants ACL access but never
// populates its calendarList — there's no Google API to enumerate "every
// calendar this identity has ACL access to" from a cold start, so the source
// calendar IDs (and their human-readable labels) are configured explicitly
// instead, as "label:calendarId" pairs — the label is a user-chosen tag
// (e.g. "Kids", ".edu"), not necessarily Google's own calendar summary, and
// is what gets written onto every synced event so its origin is taggable.
function discoverSourceCalendars(): { id: string; label: string }[] {
  const entries = (process.env.GOOGLE_SOURCE_CALENDAR_IDS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const result: { id: string; label: string }[] = [];
  for (const entry of entries) {
    const separatorIndex = entry.indexOf(':');
    if (separatorIndex === -1) {
      throw new Error(
        `GOOGLE_SOURCE_CALENDAR_IDS entry "${entry}" is missing a "label:calendarId" separator`
      );
    }
    const label = entry.slice(0, separatorIndex).trim();
    const id = entry.slice(separatorIndex + 1).trim();
    if (!label || !id || id === BURNER_CALENDAR_ID) continue;
    result.push({ id, label });
  }

  return result;
}

async function getOrCreateSyncState(calendarId: string, summary: string): Promise<SyncStateRow> {
  const { data: existing, error: selectError } = await supabase
    .from('calendar_sync_state')
    .select('*')
    .eq('source_calendar_id', calendarId)
    .maybeSingle();

  if (selectError) throw new Error(`calendar_sync_state read failed: ${selectError.message}`);
  if (existing) return existing as SyncStateRow;

  const { data: inserted, error: insertError } = await supabase
    .from('calendar_sync_state')
    .insert({ source_calendar_id: calendarId, source_calendar_summary: summary })
    .select('*')
    .single();

  if (insertError) throw new Error(`calendar_sync_state insert failed: ${insertError.message}`);
  return inserted as SyncStateRow;
}

// Google requires every page of one continuous list request to resend the
// same filters that established it — timeMin/timeMax must stay frozen across
// a backfill's pages (even across separate invocations), and syncToken/
// timeMin/timeMax must never be combined with each other.
function buildListParams(
  calendarId: string,
  state: SyncStateRow
): calendar_v3.Params$Resource$Events$List {
  const base = {
    calendarId,
    singleEvents: true,
    showDeleted: true,
    maxResults: PAGE_SIZE,
  };

  if (state.page_token) {
    if (state.sync_token) {
      // Continuing a paginated incremental delta.
      return { ...base, pageToken: state.page_token };
    }
    // Continuing a paginated backfill — reuse the bounds frozen when it started.
    return {
      ...base,
      pageToken: state.page_token,
      timeMin: state.backfill_time_min!,
      timeMax: state.backfill_time_max!,
    };
  }

  if (state.sync_token) {
    return { ...base, syncToken: state.sync_token };
  }

  const timeMin = state.backfill_time_min ?? new Date().toISOString();
  const timeMax =
    state.backfill_time_max ??
    new Date(Date.now() + SYNC_HORIZON_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return { ...base, timeMin, timeMax };
}

async function resetSyncState(calendarId: string): Promise<void> {
  const { error } = await supabase
    .from('calendar_sync_state')
    .update({
      sync_token: null,
      page_token: null,
      backfill_time_min: null,
      backfill_time_max: null,
    })
    .eq('source_calendar_id', calendarId);
  if (error) throw new Error(`calendar_sync_state reset failed: ${error.message}`);
}

async function fetchPage(
  calendarId: string,
  state: SyncStateRow
): Promise<{
  events: calendar_v3.Schema$Event[];
  nextPageToken: string | null;
  nextSyncToken: string | null;
  tokenWasReset: boolean;
  effectiveState: SyncStateRow;
}> {
  try {
    const { data } = await withRetry(() => calendar.events.list(buildListParams(calendarId, state)));
    return {
      events: data.items ?? [],
      nextPageToken: data.nextPageToken ?? null,
      nextSyncToken: data.nextSyncToken ?? null,
      tokenWasReset: false,
      effectiveState: state,
    };
  } catch (err) {
    if (errorStatusCode(err) === 410 && state.sync_token) {
      // Expired syncToken — Google's documented recovery is to clear all
      // state and perform a fresh full sync.
      await resetSyncState(calendarId);
      const resetState: SyncStateRow = {
        ...state,
        sync_token: null,
        page_token: null,
        backfill_time_min: null,
        backfill_time_max: null,
      };
      const { data } = await withRetry(() => calendar.events.list(buildListParams(calendarId, resetState)));
      return {
        events: data.items ?? [],
        nextPageToken: data.nextPageToken ?? null,
        nextSyncToken: data.nextSyncToken ?? null,
        tokenWasReset: true,
        effectiveState: resetState,
      };
    }
    throw err;
  }
}

async function applyPage(
  calendarId: string,
  calendarLabel: string,
  events: calendar_v3.Schema$Event[]
): Promise<{ created: number; updated: number; deleted: number; skipped: number }> {
  let created = 0;
  let updated = 0;
  let deleted = 0;
  let skipped = 0;

  const eventIds = events.map((e) => e.id).filter((id): id is string => !!id);
  if (eventIds.length === 0) {
    return { created, updated, deleted, skipped };
  }

  const { data: mappingRows, error: mappingError } = await supabase
    .from('synced_events')
    .select('*')
    .eq('source_calendar_id', calendarId)
    .in('source_event_id', eventIds);

  if (mappingError) throw new Error(`synced_events read failed: ${mappingError.message}`);

  const mapping = new Map<string, MappingRow>();
  for (const row of (mappingRows ?? []) as MappingRow[]) {
    mapping.set(row.source_event_id, row);
  }

  // Each task writes its own synced_events row immediately after its own
  // Google write succeeds, rather than collecting into a batch flushed once
  // at the end of the page. A page can be large (up to 250 events); if the
  // serverless function is hard-killed mid-page (Vercel's maxDuration, or a
  // burst of write-rate-limit retries eating the time budget), a batched
  // flush loses every successful write that came before the kill — the next
  // run refetches the same page and recreates the same events as duplicates,
  // since nothing on our side ever recorded they'd already been created.
  // Per-event flushing shrinks that window from "the rest of the page" down
  // to a single event's own two network calls.
  async function recordUpsert(event: calendar_v3.Schema$Event, burnerEventId: string) {
    const { error } = await supabase.from('synced_events').upsert(
      {
        source_calendar_id: calendarId,
        source_event_id: event.id!,
        burner_event_id: burnerEventId,
        etag: event.etag ?? null,
        source_updated_at: event.updated ?? null,
      },
      { onConflict: 'source_calendar_id,source_event_id' }
    );
    if (error) throw new Error(`synced_events upsert failed: ${error.message}`);
  }

  async function recordDelete(event: calendar_v3.Schema$Event) {
    const { error } = await supabase
      .from('synced_events')
      .delete()
      .eq('source_calendar_id', calendarId)
      .eq('source_event_id', event.id!);
    if (error) throw new Error(`synced_events delete failed: ${error.message}`);
  }

  const tasks = events.map((event) => async () => {
    if (!event.id) return;
    const existing = mapping.get(event.id);

    if (event.status === 'cancelled') {
      if (!existing) {
        skipped++;
        return;
      }
      try {
        await withRetry(() =>
          calendar.events.delete({
            calendarId: BURNER_CALENDAR_ID,
            eventId: existing.burner_event_id,
          })
        );
      } catch (err) {
        const status = errorStatusCode(err);
        if (status !== 404 && status !== 410) throw err;
      }
      await recordDelete(event);
      deleted++;
      return;
    }

    if (existing && existing.etag && existing.etag === event.etag) {
      skipped++;
      return;
    }

    const requestBody: calendar_v3.Schema$Event = {
      summary: event.summary,
      description: event.description,
      location: event.location,
      start: event.start,
      end: event.end,
      extendedProperties: {
        private: encodeEventMetadata({
          schemaVersion: '1',
          type: 'meeting',
          flexible: 'false',
          sourceSystem: 'google',
          sourceId: event.id,
          sourceCalendarId: calendarId,
          sourceLabel: calendarLabel,
          priority: 'medium',
          colorTag: CATEGORY_COLORS.meeting,
          deadline: '',
        }),
      },
    };

    if (existing) {
      try {
        const { data } = await withRetry(() =>
          calendar.events.update({
            calendarId: BURNER_CALENDAR_ID,
            eventId: existing.burner_event_id,
            requestBody,
          })
        );
        await recordUpsert(event, data.id!);
        updated++;
      } catch (err) {
        if (errorStatusCode(err) !== 404) throw err;
        // Burner event was deleted out-of-band — self-heal via insert.
        const { data } = await withRetry(() =>
          calendar.events.insert({ calendarId: BURNER_CALENDAR_ID, requestBody })
        );
        await recordUpsert(event, data.id!);
        created++;
      }
    } else {
      const { data } = await withRetry(() =>
        calendar.events.insert({ calendarId: BURNER_CALENDAR_ID, requestBody })
      );
      await recordUpsert(event, data.id!);
      created++;
    }
  });

  const taskErrors = await runInBatches(tasks, GOOGLE_WRITE_CONCURRENCY);

  if (taskErrors.length > 0) {
    throw taskErrors[0];
  }

  return { created, updated, deleted, skipped };
}

async function syncOneCalendar(
  calendarId: string,
  calendarSummary: string,
  deadline: number
): Promise<CalendarSyncSummary> {
  const result: CalendarSyncSummary = {
    calendarId,
    calendarSummary,
    mode: 'incremental',
    status: 'complete',
    created: 0,
    updated: 0,
    deleted: 0,
    skipped: 0,
    pagesProcessed: 0,
    errorMessage: null,
  };

  try {
    let state = await getOrCreateSyncState(calendarId, calendarSummary);
    result.mode = state.sync_token ? 'incremental' : 'backfill';

    if (!state.sync_token && !state.page_token && !state.backfill_time_min) {
      const timeMin = new Date().toISOString();
      const timeMax = new Date(Date.now() + SYNC_HORIZON_DAYS * 24 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from('calendar_sync_state')
        .update({
          backfill_time_min: timeMin,
          backfill_time_max: timeMax,
          last_attempted_at: new Date().toISOString(),
        })
        .eq('source_calendar_id', calendarId)
        .select('*')
        .single();
      if (error) throw new Error(`calendar_sync_state update failed: ${error.message}`);
      state = data as SyncStateRow;
    }

    for (let page = 0; page < MAX_PAGES_PER_CALENDAR_PER_RUN; page++) {
      if (Date.now() > deadline) {
        result.status = 'in_progress';
        return result;
      }

      const { events, nextPageToken, nextSyncToken, tokenWasReset, effectiveState } = await fetchPage(
        calendarId,
        state
      );
      state = effectiveState;
      if (tokenWasReset) result.mode = 'backfill';

      const pageCounts = await applyPage(calendarId, calendarSummary, events);
      result.created += pageCounts.created;
      result.updated += pageCounts.updated;
      result.deleted += pageCounts.deleted;
      result.skipped += pageCounts.skipped;
      result.pagesProcessed++;

      const now = new Date().toISOString();

      if (nextPageToken) {
        const { error } = await supabase
          .from('calendar_sync_state')
          .update({ page_token: nextPageToken, last_attempted_at: now })
          .eq('source_calendar_id', calendarId);
        if (error) throw new Error(`calendar_sync_state checkpoint failed: ${error.message}`);
        state = { ...state, page_token: nextPageToken };
        continue;
      }

      const { error } = await supabase
        .from('calendar_sync_state')
        .update({
          sync_token: nextSyncToken,
          page_token: null,
          backfill_time_min: null,
          backfill_time_max: null,
          last_synced_at: now,
          last_attempted_at: now,
          last_error: null,
          last_error_at: null,
        })
        .eq('source_calendar_id', calendarId);
      if (error) throw new Error(`calendar_sync_state completion failed: ${error.message}`);

      result.status = 'complete';
      return result;
    }

    result.status = 'in_progress'; // hit the per-run page cap before finishing
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    await supabase
      .from('calendar_sync_state')
      .update({
        last_error: message,
        last_error_at: new Date().toISOString(),
        last_attempted_at: new Date().toISOString(),
      })
      .eq('source_calendar_id', calendarId);
    result.status = 'error';
    result.errorMessage = message;
    return result;
  }
}

export async function runSync(): Promise<SyncRunResult> {
  const startedAt = Date.now();
  const deadline = startedAt + MAX_TOTAL_RUNTIME_MS;

  const sourceCalendars = discoverSourceCalendars();
  const calendars: CalendarSyncSummary[] = [];
  let truncatedByTimeBudget = false;

  for (const source of sourceCalendars) {
    if (Date.now() > deadline) {
      truncatedByTimeBudget = true;
      calendars.push({
        calendarId: source.id,
        calendarSummary: source.label,
        mode: 'backfill',
        status: 'in_progress',
        created: 0,
        updated: 0,
        deleted: 0,
        skipped: 0,
        pagesProcessed: 0,
        errorMessage: null,
      });
      continue;
    }

    const summary = await syncOneCalendar(source.id, source.label, deadline);
    if (summary.status === 'in_progress') truncatedByTimeBudget = true;
    calendars.push(summary);
  }

  const finishedAt = Date.now();
  return {
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - startedAt,
    truncatedByTimeBudget,
    calendars,
  };
}

export interface DedupeResult {
  groupsScanned: number;
  groupsWithDuplicates: number;
  eventsDeleted: number;
  errors: string[];
}

// Maintenance tool: collapses burner-calendar events that were duplicated by
// a mid-page kill under the old batched-flush behavior (see the comment on
// recordUpsert/recordDelete above) — or by any other future cause that
// produces more than one burner event for the same source event. Keyed off
// the same extendedProperties every synced event already carries, so it
// needs no separate bookkeeping of its own.
export async function dedupeBurnerEvents(): Promise<DedupeResult> {
  let events: calendar_v3.Schema$Event[] = [];
  let pageToken: string | undefined;
  do {
    const { data } = await withRetry(() =>
      calendar.events.list({
        calendarId: BURNER_CALENDAR_ID,
        singleEvents: true,
        showDeleted: false,
        maxResults: PAGE_SIZE,
        pageToken,
      })
    );
    events = events.concat(data.items ?? []);
    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);

  const groups = new Map<string, calendar_v3.Schema$Event[]>();
  for (const event of events) {
    const meta = decodeEventMetadata(event.extendedProperties);
    if (!meta.sourceId || !meta.sourceCalendarId) continue; // never touch untagged/manual events
    const key = `${meta.sourceCalendarId}::${meta.sourceId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(event);
  }

  const dupeGroups = [...groups.entries()].filter(([, list]) => list.length > 1);
  let eventsDeleted = 0;

  const tasks = dupeGroups.map(([key, group]) => async () => {
    const [sourceCalendarId, sourceId] = key.split('::');
    const { data: mappingRow, error: mappingError } = await supabase
      .from('synced_events')
      .select('*')
      .eq('source_calendar_id', sourceCalendarId)
      .eq('source_event_id', sourceId)
      .maybeSingle();
    if (mappingError) throw new Error(`synced_events read failed for ${key}: ${mappingError.message}`);

    let canonical = mappingRow ? group.find((e) => e.id === mappingRow.burner_event_id) : undefined;

    if (!canonical) {
      // Mapping missing or pointing at a copy that no longer exists in this
      // group — fall back to the most-recently-updated copy and repoint
      // synced_events at it.
      canonical = [...group].sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''))[0];
      const { error } = await supabase.from('synced_events').upsert(
        {
          source_calendar_id: sourceCalendarId,
          source_event_id: sourceId,
          burner_event_id: canonical.id!,
          etag: canonical.etag ?? null,
          source_updated_at: canonical.updated ?? null,
        },
        { onConflict: 'source_calendar_id,source_event_id' }
      );
      if (error) throw new Error(`synced_events repoint failed for ${key}: ${error.message}`);
    }

    for (const event of group) {
      if (event.id === canonical.id) continue;
      try {
        await withRetry(() => calendar.events.delete({ calendarId: BURNER_CALENDAR_ID, eventId: event.id! }));
        eventsDeleted++;
      } catch (err) {
        const status = errorStatusCode(err);
        if (status !== 404 && status !== 410) throw err;
      }
    }
  });

  const taskErrors = await runInBatches(tasks, GOOGLE_WRITE_CONCURRENCY);

  return {
    groupsScanned: groups.size,
    groupsWithDuplicates: dupeGroups.length,
    eventsDeleted,
    errors: taskErrors.map((err) => (err instanceof Error ? err.message : String(err))),
  };
}
