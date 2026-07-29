// Options page glue — chrome.storage.local only, never chrome.storage.sync
// (extension/CLAUDE.md, architecture principle 4: syncing the key would
// ship it to Google's sync servers). This is the only place the API key is
// ever written; background.ts only ever reads it back.
const baseUrlInput = document.getElementById('baseUrl') as HTMLInputElement;
const apiKeyInput = document.getElementById('apiKey') as HTMLInputElement;
const saveButton = document.getElementById('save') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const hostWarningEl = document.getElementById('hostWarning') as HTMLDivElement;

async function load(): Promise<void> {
  const { apiKey, baseUrl } = await chrome.storage.local.get(['apiKey', 'baseUrl']);
  if (typeof baseUrl === 'string') baseUrlInput.value = baseUrl;
  if (typeof apiKey === 'string') apiKeyInput.value = apiKey;
  checkHostPermissions();
}

// Warns (doesn't block saving) if the entered backend URL's origin isn't
// one of manifest.json's static host_permissions entries — a mismatch here
// means every background.ts fetch to it will be blocked, and that failure
// mode is confusing without this hint pointing at the actual cause.
function checkHostPermissions(): void {
  const url = baseUrlInput.value.trim();
  hostWarningEl.style.display = 'none';
  if (!url) return;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return;
  }
  const granted = (chrome.runtime.getManifest().host_permissions ?? []).some((pattern: string) =>
    pattern.startsWith(`${origin}/`)
  );
  if (!granted) {
    hostWarningEl.textContent =
      `Warning: "${origin}" isn't in this extension's host_permissions (manifest.json). ` +
      'Requests to it will be blocked until the manifest is updated and the extension reloaded.';
    hostWarningEl.style.display = 'block';
  }
}

async function save(): Promise<void> {
  const baseUrl = baseUrlInput.value.trim().replace(/\/$/, '');
  const apiKey = apiKeyInput.value.trim();

  statusEl.className = '';
  if (!baseUrl || !apiKey) {
    statusEl.textContent = 'Both fields are required.';
    statusEl.className = 'error';
    return;
  }

  await chrome.storage.local.set({ baseUrl, apiKey });
  statusEl.textContent = 'Saved.';
  statusEl.className = 'success';
}

baseUrlInput.addEventListener('input', checkHostPermissions);
saveButton.addEventListener('click', () => void save());

void load();
