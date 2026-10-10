import DefaultPreference from 'react-native-default-preference';

// Editable on the login screen. Default is the PC's LAN address; with a USB cable and
// `adb reverse tcp:8000 tcp:8000` you can use http://localhost:8000 instead.
export const DEFAULT_SERVER = 'http://192.168.1.23:8000';
let serverUrl = DEFAULT_SERVER;

const SERVER_KEY = 'server_url';
const TOKEN_KEY = 'auth_token';
const BLOCKED_KEY = 'blocked_numbers'; // read by BlockingScreeningService.kt

export type BlockedNumber = { id: number; number: string; label: string };
export type Category = 'spam' | 'scam' | 'telemarketer' | 'robocall' | 'harassment' | 'other';
export type Lookup = { number: string; report_count: number; top_category: string | null };

let token: string | null = null;

export async function loadToken() {
  serverUrl = (await DefaultPreference.get(SERVER_KEY)) || DEFAULT_SERVER;
  token = (await DefaultPreference.get(TOKEN_KEY)) || null;
  return token;
}

export const getServerUrl = () => serverUrl;

export async function setServerUrl(url: string) {
  serverUrl = url.trim().replace(/\/+$/, '') || DEFAULT_SERVER;
  await DefaultPreference.set(SERVER_KEY, serverUrl);
}

async function setToken(value: string | null) {
  token = value;
  if (value) await DefaultPreference.set(TOKEN_KEY, value);
  else await DefaultPreference.clear(TOKEN_KEY);
}

const REQUEST_TIMEOUT_MS = 8000;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Without a timeout an unreachable server can hang a request for minutes.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${serverUrl}/api${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Token ${token}` } : {}),
      },
    });
  } catch (e) {
    throw new Error(controller.signal.aborted ? 'no response after 8 seconds' : (e instanceof Error ? e.message : String(e)));
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const first = Object.values(body as Record<string, unknown>).flat()[0];
    throw new Error(typeof first === 'string' ? first : `Request failed (${res.status})`);
  }
  return body as T;
}

export async function login(username: string, password: string) {
  const { token: t } = await request<{ token: string }>('/auth/login/', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  await setToken(t);
}

export async function register(username: string, password: string) {
  const { token: t } = await request<{ token: string }>('/auth/register/', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  await setToken(t);
}

export async function logout() {
  await setToken(null);
  await DefaultPreference.set(BLOCKED_KEY, '');
  await DefaultPreference.set('spam_numbers', '');
}

/** Fetch the block list and mirror it where the call-screening service can read it. */
export async function fetchBlocklist(): Promise<BlockedNumber[]> {
  const list = await request<BlockedNumber[]>('/blocklist/');
  await DefaultPreference.set(BLOCKED_KEY, list.map(b => b.number).join(','));
  return list;
}

export async function blockNumber(number: string, label = '') {
  await request('/blocklist/', { method: 'POST', body: JSON.stringify({ number, label }) });
  return fetchBlocklist();
}

export async function unblock(id: number) {
  await request(`/blocklist/${id}/`, { method: 'DELETE' });
  return fetchBlocklist();
}

/** Unblocks every number this account has blocked, then refreshes the phone's saved copy. */
export async function unblockAll() {
  await request('/blocklist/', { method: 'DELETE' });
  return fetchBlocklist();
}

export function reportNumber(number: string, category: Category, note = '') {
  return request('/reports/', { method: 'POST', body: JSON.stringify({ number, category, note }) });
}

export type Reputation = { report_count: number; top_category: string | null };
export const SPAM_THRESHOLD = 2; // keep in sync with backend SPAM_REPORT_THRESHOLD
const SPAM_KEY = 'spam_numbers'; // read by BlockingScreeningService.kt
const AUTO_BLOCK_KEY = 'auto_block_spam'; // "1" = reject known spam silently; otherwise show the spam card

/** Report counts for many numbers at once, keyed by normalized number. */
export function bulkLookup(numbers: string[]) {
  return request<Record<string, Reputation>>('/lookup/bulk/', {
    method: 'POST',
    body: JSON.stringify({ numbers }),
  });
}

/**
 * Save the known-spam numbers where the call-screening service can read them: the 50 most-reported numbers
 * plus every number this phone has seen labelled as scam. A call from one of them shows the red spam card.
 */
export async function syncSpamList(limit = 50): Promise<number> {
  const [top, mine] = await Promise.all([
    request<Array<{ number: string }>>(`/spam/?limit=${limit}`),
    request<Array<{ number: string }>>('/scam-calls/'),
  ]);
  const numbers = [...new Set([...top, ...mine].map(s => s.number))];
  await DefaultPreference.set(SPAM_KEY, numbers.join(','));
  return numbers.length;
}

/** Silently rejecting known spam is off unless the user turns it on; by default it shows the red card instead. */
export async function getAutoBlock(): Promise<boolean> {
  return (await DefaultPreference.get(AUTO_BLOCK_KEY)) === '1';
}

export function setAutoBlock(on: boolean) {
  return DefaultPreference.set(AUTO_BLOCK_KEY, on ? '1' : '0');
}

export function lookupNumber(number: string) {
  return request<Lookup>(`/lookup/?number=${encodeURIComponent(number)}`);
}

export type ScamSyncResult = { logged: number; blocked: number; reported: number };

/** Log calls the phone labelled as scam, and have the server block + report their numbers (idempotent). */
export function syncScamCalls(calls: Array<{ number: string; label: string; called_at: number }>) {
  return request<ScamSyncResult>('/scam-calls/sync/', { method: 'POST', body: JSON.stringify({ calls }) });
}
