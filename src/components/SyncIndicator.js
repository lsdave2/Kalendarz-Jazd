import { t } from '../i18n.js';
import { el, icon } from '../utils.js';
import { hasPendingChanges, isAdmin, isSaving } from '../store.js';

export function buildSyncIndicator() {
  if (!isAdmin()) return el('div');

  const saving = isSaving();
  const pending = hasPendingChanges();

  let stateIcon = 'cloud_done';
  let stateClass = 'sync-done';
  let tooltip = t('allSaved') || 'All changes saved';

  if (saving) {
    stateIcon = 'cloud_upload';
    stateClass = 'sync-saving';
    tooltip = t('saving') || 'Saving to database...';
  } else if (pending) {
    stateIcon = 'sync_problem';
    stateClass = 'sync-pending';
    tooltip = t('pendingSync') || 'Unsaved changes - last database save failed';
  }

  return el('div', {
    className: `sync-indicator ${stateClass}`,
    title: tooltip,
    'aria-label': tooltip,
  }, icon(stateIcon));
}

export function refreshSyncIndicators(root = document) {
  if (!isAdmin()) {
    root.querySelectorAll('.sync-indicator').forEach(indicator => indicator.remove());
    return;
  }

  root.querySelectorAll('.sync-indicator').forEach(indicator => {
    indicator.replaceWith(buildSyncIndicator());
  });
}
