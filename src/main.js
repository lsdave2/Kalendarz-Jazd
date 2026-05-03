import './style.css';
import { t } from './i18n.js';
import { el, icon, formatDate } from './utils.js';
import {
  loadData, subscribe, isAdmin, logout, processPastLessonsForCredits,
  isSaving, hasPendingChanges
} from './store.js';
import { buildPackagesView } from './views/PackagesView.js';
import { buildSettingsView } from './views/SettingsView.js';
import { buildFinancesView } from './views/FinancesView.js';
import { buildMonthView, buildDayView, calendarState, formatDateNice } from './views/CalendarView.js';

// ── State ──────────────────────────────────────────────────────────────
let currentTab = 'calendar';
let lastRenderKey = null;
let lastRenderedDay = formatDate(new Date());

// Navigation State Management
function updateStateFromHistory(state) {
  if (state) {
    if (state.tab) currentTab = state.tab;
    if (state.date !== undefined) calendarState.selectedDate = state.date;
  } else {
    // Initial state
    currentTab = 'calendar';
    calendarState.selectedDate = null;
  }
  render();
}

window.addEventListener('popstate', (e) => {
  // If a modal is open, it should have its own popstate listener that handles its closing.
  // We only handle view transitions here.
  if (e.state && e.state.modalOpen) return;
  updateStateFromHistory(e.state);
});

function isTabVisible(tabId) {
  if (tabId === 'packages') return isAdmin();
  if (tabId === 'finances') return isAdmin();
  return true;
}

function ensureVisibleTab() {
  if (!isTabVisible(currentTab)) {
    currentTab = 'calendar';
    calendarState.selectedDate = null;
  }
}

loadData();

// ── Render Engine ──────────────────────────────────────────────────────
const app = document.getElementById('app');

function getRenderKey() {
  const calendarKey = calendarState.selectedDate
    ? `day:${calendarState.selectedDate}`
    : `month:${calendarState.viewYear}-${calendarState.viewMonth}`;
  return `${currentTab}|${calendarKey}|${isAdmin() ? 'admin' : 'guest'}`;
}

function refreshLiveUi() {
  const today = formatDate(new Date());

  document.querySelectorAll('.calendar-day[data-date]').forEach(dayCell => {
    const dateStr = dayCell.dataset.date;
    if (!dateStr) return;
    dayCell.classList.toggle('today', dateStr === today);
    dayCell.classList.toggle('past', dateStr < today);
  });

  document.querySelectorAll('.lesson-tile[data-date][data-end-minute]').forEach(tile => {
    const dateStr = tile.dataset.date;
    const endMinute = Number.parseInt(tile.dataset.endMinute || '', 10);
    if (!dateStr || Number.isNaN(endMinute)) return;
    const lessonEnd = new Date(`${dateStr}T00:00:00`);
    lessonEnd.setMinutes(lessonEnd.getMinutes() + endMinute);
    tile.classList.toggle('past', lessonEnd < new Date());
  });
}

export function render() {
  ensureVisibleTab();
  document.title = t('appTitle');
  const renderKey = getRenderKey();
  const isUpdate = lastRenderKey === renderKey;
  const shouldRestoreScroll = isUpdate;
  const previousScrollY = shouldRestoreScroll ? window.scrollY : 0;
  app.innerHTML = '';
  
  if (!(currentTab === 'calendar' && calendarState.selectedDate)) {
    app.appendChild(buildHeader());
  }

  const page = el('div', {
    className: `page ${currentTab === 'calendar' && calendarState.selectedDate ? 'day-view' : ''}`.trim(),
    style: isUpdate ? { animation: 'none' } : {}
  });

  switch (currentTab) {
    case 'calendar':
      if (calendarState.selectedDate) {
        page.appendChild(buildDayView(calendarState.selectedDate));
      } else {
        page.appendChild(buildMonthView());
      }
      break;
    case 'packages':
      page.appendChild(buildPackagesView());
      break;
    case 'finances':
      page.appendChild(buildFinancesView());
      break;
    case 'settings':
      page.appendChild(buildSettingsView());
      break;
  }

  app.appendChild(page);
  app.appendChild(buildBottomNav());
  lastRenderKey = renderKey;

  if (shouldRestoreScroll) {
    requestAnimationFrame(() => window.scrollTo({ top: previousScrollY, left: 0, behavior: 'auto' }));
  }
}

// ── Header ─────────────────────────────────────────────────────────────
function buildHeader() {
  const titleText = currentTab === 'calendar'
    ? (calendarState.selectedDate ? formatDateNice(calendarState.selectedDate) : t('appTitle'))
    : currentTab === 'packages' ? t('clientsTab') : currentTab === 'finances' ? t('financesTab') : t('settings');
  const titleIcon = currentTab === 'packages' ? 'groups' : 'calendar_month';

  const header = el('header', { className: 'app-header' },
    el('h1', {},
      icon(titleIcon),
      titleText
    ),
    currentTab === 'settings' ? buildSyncIndicator() : null
  );

  if (calendarState.selectedDate) {
    const todayBtn = el('button', {
      className: 'header-btn',
      onClick: () => { 
        calendarState.selectedDate = null; 
        history.pushState({ tab: 'calendar', date: null }, '');
        render(); 
      },
      title: t('backToCalendar')
    }, icon('calendar_today'));
    header.querySelector('h1').prepend(todayBtn);
  }

  return header;
}


function buildSyncIndicator() {
  if (!isAdmin()) return el('div');

  const saving = isSaving();
  const pending = hasPendingChanges();
  
  let stateIcon = 'cloud_done';
  let stateClass = 'sync-done';
  let tooltip = t('allSaved') || 'All changes saved';

  if (saving) {
    stateIcon = 'cloud_upload';
    stateClass = 'sync-saving';
    tooltip = t('saving') || 'Saving to cloud...';
  } else if (pending) {
    stateIcon = 'cloud_off';
    stateClass = 'sync-pending';
    tooltip = t('pendingSync') || 'Changes pending (offline)';
  }

  return el('div', { 
    className: `sync-indicator ${stateClass}`,
    title: tooltip
  }, icon(stateIcon));
}

// ── Bottom Nav ─────────────────────────────────────────────────────────
function buildBottomNav() {
  const nav = el('div', { className: 'bottom-nav' });
  const admin = isAdmin();

  const tabs = [
    { id: 'calendar', icon: 'calendar_month', label: t('calendar') },
  ];

  if (admin) {
    tabs.push({ id: 'packages', icon: 'groups', label: t('clientsTab') });
    tabs.push({ id: 'finances', icon: 'payments', label: t('financesTab') });
  }

  tabs.push({ id: 'settings', icon: 'settings', label: t('settings') });

  for (const tab of tabs) {
    const item = el('button', {
      className: `nav-item ${currentTab === tab.id ? 'active' : ''}`,
      id: `nav-${tab.id}`,
      onClick: () => {
        let nextTab = tab.id;
        let nextDate = null;

        if (tab.id === 'calendar') {
          if (currentTab === 'calendar' && calendarState.selectedDate) {
            nextDate = null;
          } else {
            nextTab = 'calendar';
            nextDate = formatDate(new Date());
          }
        } else {
          nextTab = tab.id;
          nextDate = null;
        }

        if (nextTab !== currentTab || nextDate !== calendarState.selectedDate) {
          // If we are switching from another tab to calendar day view,
          // push the month view state first so that 'back' (UI or Android) returns to month view.
          if (nextTab === 'calendar' && nextDate && currentTab !== 'calendar') {
            history.pushState({ tab: 'calendar', date: null }, '');
          }

          currentTab = nextTab;
          calendarState.selectedDate = nextDate;
          history.pushState({ tab: currentTab, date: calendarState.selectedDate }, '');
          render();
        }
      }
    }, icon(tab.icon), tab.label);
    nav.appendChild(item);
  }

  return nav;
}

// ── Toast ──────────────────────────────────────────────────────────────
export function showToast(message, iconName = 'info') {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const toast = el('div', { className: 'toast' },
    icon(iconName),
    message
  );
  document.body.appendChild(toast);
  requestAnimationFrame(() => {
    toast.classList.add('show');
  });
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// ── Init ───────────────────────────────────────────────────────────────
subscribe(render);
render();

window.addEventListener('store-error', (e) => {
  if (e.detail && e.detail.message) {
    showToast(e.detail.message, 'warning');
  }
});

setInterval(() => {
  if (isAdmin()) {
    processPastLessonsForCredits();
  }
  const today = formatDate(new Date());
  if (today !== lastRenderedDay) {
    lastRenderedDay = today;
    render();
    return;
  }
  refreshLiveUi();
}, 60000);

async function promptAdminLogin() {
  // This is now mainly in SettingsView, but if called from elsewhere:
  const { login } = await import('./store.js');
  const email = prompt(t('emailLabel'));
  if (!email) return;
  const password = prompt(t('passwordLabel'));
  if (!password) return;
  login(email, password).then(success => {
    if (success) {
      showToast(t('loginSuccess'), 'check_circle');
      render();
    } else {
      showToast(t('loginFailed'), 'error');
    }
  });
}
