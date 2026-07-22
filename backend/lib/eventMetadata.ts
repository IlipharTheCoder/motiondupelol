export type BurnerEventType = 'task' | 'habit' | 'focusTime' | 'meeting' | 'fixed' | 'buffer';
export type SourceSystem = 'todoist' | 'canvas' | 'google' | 'manual' | 'ai-engine';
export type EventPriority = 'critical' | 'high' | 'medium' | 'low';

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
