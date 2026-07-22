// inbox_items.status is a smallint, not text — this is the single source of
// truth for what each integer means. Reference these constants rather than
// writing the raw number inline.
export const InboxStatus = {
  NEW: 0,
  PARSED: 1,
  SCHEDULED: 2,
  DISCARDED: 3,
} as const;
