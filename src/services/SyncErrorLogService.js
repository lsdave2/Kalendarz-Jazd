const SYNC_ERROR_LOG_KEY = 'horsebook_sync_error_log';
const MAX_SYNC_ERROR_LOG_ENTRIES = 50;

function readEntries() {
  try {
    const raw = localStorage.getItem(SYNC_ERROR_LOG_KEY);
    const entries = raw ? JSON.parse(raw) : [];
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

function writeEntries(entries) {
  try {
    localStorage.setItem(SYNC_ERROR_LOG_KEY, JSON.stringify(entries));
  } catch (error) {
    console.error('[sync-log] Failed to persist sync error log', error);
  }
}

export function getSyncErrorLog() {
  return readEntries()
    .filter(entry => entry && typeof entry.message === 'string')
    .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
}

export function addSyncErrorLogEntry({ message, type = 'error' } = {}) {
  if (!message) return;
  const entries = readEntries();
  entries.unshift({
    id: typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `sync-log-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    timestamp: new Date().toISOString(),
    type,
    message: String(message),
  });
  writeEntries(entries.slice(0, MAX_SYNC_ERROR_LOG_ENTRIES));
}

export function clearSyncErrorLog() {
  try {
    localStorage.removeItem(SYNC_ERROR_LOG_KEY);
  } catch (error) {
    console.error('[sync-log] Failed to clear sync error log', error);
  }
}
