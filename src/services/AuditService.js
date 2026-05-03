/**
 * AuditService handles local logging of all user actions that modify the state.
 * This provides a reliable local "black box" recorder to verify if actions
 * were attempted, even if database synchronization fails.
 */

const AUDIT_LOG_KEY = 'horsebook_audit_log';
const MAX_LOG_ENTRIES = 500;

export function logAction(action, data = {}) {
  try {
    const log = getAuditLog();
    const entry = {
      timestamp: new Date().toISOString(),
      action,
      data: JSON.parse(JSON.stringify(data)), // Deep clone to freeze state
    };
    
    log.unshift(entry);
    
    // Keep only the most recent entries
    const trimmedLog = log.slice(0, MAX_LOG_ENTRIES);
    localStorage.setItem(AUDIT_LOG_KEY, JSON.stringify(trimmedLog));
    
    console.debug(`[Audit] ${action}`, entry);
  } catch (error) {
    console.error('[Audit] Failed to log action', error);
  }
}

export function getAuditLog() {
  try {
    const raw = localStorage.getItem(AUDIT_LOG_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function clearAuditLog() {
  localStorage.removeItem(AUDIT_LOG_KEY);
}

export function downloadAuditLog() {
  const log = getAuditLog();
  const content = JSON.stringify(log, null, 2);
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  
  const a = document.createElement('a');
  a.href = url;
  a.download = `horsebook_audit_log_${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
