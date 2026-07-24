import { normalizeTags } from './normalizeTags';

export type BurnerEventType = 'task' | 'habit' | 'focusTime' | 'meeting' | 'fixed' | 'buffer' | 'personal';
export type SourceSystem = 'todoist' | 'canvas' | 'google' | 'manual' | 'ai-engine';
export type EventPriority = 'critical' | 'high' | 'medium' | 'low';
export const EVENT_PRIORITIES: EventPriority[] = ['critical', 'high', 'medium', 'low'];

// Lower number = more important. Single source of truth for priority
// ordering — lib/autoReschedule.ts's conflict-resolution mover-selection and
// lib/aiTasks.ts's "what should I work on next" ranking both reuse this
// rather than each defining their own copy.
export const PRIORITY_RANK: Record<EventPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export interface EventPrivateProperties {
  schemaVersion: '1';
  type: BurnerEventType;
  flexible: 'true' | 'false';
  sourceSystem: SourceSystem;
  sourceId: string;
  sourceCalendarId: string;
  sourceLabel: string;
  priority: EventPriority;
  colorTag: string;
  deadline: string;
  tags: string;
}

// Color is derived from category, not freely chosen, so every event is
// guaranteed to have one — there's no "forgot to set a color" state.
export const CATEGORY_COLORS: Record<BurnerEventType, string> = {
  task: '#4285F4',
  habit: '#8E24AA',
  focusTime: '#00897B',
  meeting: '#F4511E',
  fixed: '#E53935',
  buffer: '#9E9E9E',
  personal: '#43A047',
};

// extendedProperties values silently truncate above 1024 characters with no
// error from the Calendar API — every field here is fixed/enum-sized and
// should never come close, so getting near the limit signals a bug upstream.
const MAX_VALUE_LENGTH = 500;

export function encodeEventMetadata(props: EventPrivateProperties): Record<string, string> {
  for (const [key, value] of Object.entries(props)) {
    if (value.length > MAX_VALUE_LENGTH) {
      throw new Error(
        `eventMetadata field "${key}" is ${value.length} chars, exceeding the ${MAX_VALUE_LENGTH}-char safety guard (Calendar API silently truncates extendedProperties at 1024 chars)`
      );
    }
  }

  return { ...props };
}

export function decodeEventMetadata(
  extendedProperties?: { private?: Record<string, string> } | null
): Partial<EventPrivateProperties> {
  const raw = extendedProperties?.private ?? {};
  return raw as Partial<EventPrivateProperties>;
}

// Item 13 ("Labels") — extendedProperties.private is a flat Record<string,
// string> (Calendar API allows no arrays), so tags are comma-joined into
// this one field rather than given their own key per tag. Commas within a
// tag are stripped rather than escaped, same "flat string, good-enough"
// tradeoff already accepted for every other field here.
export function encodeEventTags(tags: string[]): string {
  return normalizeTags(tags)
    .map((t) => t.replace(/,/g, ''))
    .join(',');
}

export function decodeEventTags(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').filter((t) => t.length > 0);
}
