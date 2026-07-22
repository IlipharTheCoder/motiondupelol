export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];

  const seen = new Set<string>();
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const normalized = tag.trim().toLowerCase();
    if (normalized) seen.add(normalized);
  }

  return [...seen];
}
