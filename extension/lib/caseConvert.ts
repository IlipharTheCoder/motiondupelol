// The TS analogue of Swift's `JSONDecoder().keyDecodingStrategy =
// .convertFromSnakeCase` (app/motiondupelol/CoreLogic/APIClient.swift) — the
// backend mixes snake_case top-level fields (change_type, proposed_summary,
// tasks_changed) with already-camelCase nested objects (POST /api/chat's
// `usage.inputTokens` etc.), so a single blanket deep-camelize handles both
// uniformly: a no-underscore key round-trips to itself unchanged.
function snakeToCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export function camelizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(camelizeKeys);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[snakeToCamel(key)] = camelizeKeys(val);
    }
    return result;
  }
  return value;
}
