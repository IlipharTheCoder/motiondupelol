export type BurnerEventType = 'task' | 'habit' | 'focusTime' | 'meeting' | 'fixed' | 'buffer';
export type SourceSystem = 'todoist' | 'canvas' | 'google' | 'manual' | 'ai-engine';

export interface EventPrivateProperties {
  schemaVersion: '1';
  type: BurnerEventType;
  flexible: 'true' | 'false';
  sourceSystem: SourceSystem;
  sourceId: string;
  sourceCalendarId: string;
  sourceLabel: string;
  priority: '1' | '2' | '3' | '4' | '5';
  colorTag: string;
}

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
