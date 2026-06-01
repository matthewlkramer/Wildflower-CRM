const STORAGE_KEY = 'magio_enabled';
const TOKEN_KEY = 'wildflower_extension_token';

let cachedValue: boolean | null = null;
// undefined = not yet loaded; null = loaded but unset.
let cachedToken: string | null | undefined = undefined;

export async function getTrackingEnabled(): Promise<boolean> {
  if (cachedValue !== null) return cachedValue;
  const result = await chrome.storage.local.get(STORAGE_KEY);
  cachedValue = result[STORAGE_KEY] === undefined ? true : result[STORAGE_KEY];
  return cachedValue;
}

export function getTrackingEnabledSync(): boolean {
  return cachedValue ?? true;
}

export async function setTrackingEnabled(enabled: boolean): Promise<void> {
  cachedValue = enabled;
  await chrome.storage.local.set({ [STORAGE_KEY]: enabled });
}

// ─── Per-user extension token ──────────────────────────────────────────────
// Generated in the CRM Settings page and pasted into the popup. Used to
// authenticate the per-recipient server-send endpoint.
export async function getExtensionToken(): Promise<string | null> {
  if (cachedToken !== undefined) return cachedToken;
  const result = await chrome.storage.local.get(TOKEN_KEY);
  cachedToken = (result[TOKEN_KEY] as string | undefined) ?? null;
  return cachedToken;
}

export function getExtensionTokenSync(): string | null {
  return cachedToken ?? null;
}

export async function setExtensionToken(token: string): Promise<void> {
  const value = token.trim();
  cachedToken = value || null;
  await chrome.storage.local.set({ [TOKEN_KEY]: cachedToken });
}

export function initStorageListener(onToggle: (enabled: boolean) => void) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_KEY]) {
      cachedValue = changes[STORAGE_KEY].newValue;
      onToggle(cachedValue!);
    }
    if (changes[TOKEN_KEY]) {
      cachedToken = (changes[TOKEN_KEY].newValue as string | undefined) ?? null;
    }
  });
}

export async function loadInitialState(): Promise<boolean> {
  const enabled = await getTrackingEnabled();
  cachedValue = enabled;
  await getExtensionToken();
  return enabled;
}
