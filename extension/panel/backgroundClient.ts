// The ONLY place the panel/content-script world calls chrome.runtime —
// every panel module imports this rather than touching chrome.runtime
// directly (extension/CLAUDE.md principle 2). Thin glue, not unit-tested.
import type { BackgroundRequest, BackgroundResponse } from '../lib/messages';

export async function callBackground<T>(request: BackgroundRequest): Promise<T> {
  const response = (await chrome.runtime.sendMessage(request)) as BackgroundResponse<T>;
  if (!response.ok) throw new Error(response.error);
  return response.data;
}
