import { t, setLang, getLang } from '../i18n.js';
import { el, icon, formatDate, getDatesInRange } from '../utils.js';
import {
  getData, saveData, isAdmin, login, logout,
  getLessonsForDate, GROUP_COLORS, updateInstructorColor, addInstructor, deleteInstructor
} from '../store.js';
import { render, showToast } from '../main.js';
import { isGroupLessonRecord, getLessonParticipants } from '../services/LessonService.js';

// ── Settings helpers ────────────────────────────────────────────────────
const SETTINGS_KEY = 'horsebook_settings';
function getSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}
function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function formatHourOption(hour) {
  return `${String(hour).padStart(2, '0')}:00`;
}

export function getDayScheduleHours() {
  const DEFAULT_START = 8;
  const DEFAULT_END = 21;
  let startHour = Number.parseInt(getSettings().dayScheduleStartHour, 10);
  let endHour = Number.parseInt(getSettings().dayScheduleEndHour, 10);
  if (Number.isNaN(startHour)) startHour = DEFAULT_START;
  if (Number.isNaN(endHour)) endHour = DEFAULT_END;
  startHour = Math.max(0, Math.min(23, startHour));
  endHour = Math.max(1, Math.min(24, endHour));
  if (endHour <= startHour) {
    if (startHour >= 23) { startHour = 22; endHour = 23; }
    else { endHour = startHour + 1; }
  }
  return { startHour, endHour };
}

// ── Instructor payment report ───────────────────────────────────────────
function formatCurrency(amount) {
  if (Number.isNaN(amount)) return '0 zł';
  const fixed = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return `${fixed} zł`;
}

function formatDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return `0 ${t('m')}`;
  const wholeHours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  const parts = [];
  if (wholeHours > 0) parts.push(`${wholeHours}${t('h')}`);
  if (remainingMinutes > 0) parts.push(`${remainingMinutes}${t('m')}`);
  return parts.length > 0 ? parts.join(' ') : `0 ${t('m')}`;
}

function computeInstructorPaymentReport({ instructor, from, to }) {
  const dates = getDatesInRange(from, to);
  let individualCount = 0;
  let individualDurationMinutes = 0;
  const groupSessions = new Map();

  for (const dateStr of dates) {
    const lessons = getLessonsForDate(dateStr);
    for (const lesson of lessons) {
      if (lesson.instructor !== instructor) continue;
      const isCancelled = lesson.cancelledDates && lesson.cancelledDates.includes(dateStr);
      if (isCancelled) continue;

      if (isGroupLessonRecord(lesson)) {
        const key = `${lesson.groupId || lesson.title || 'group'}|${dateStr}|${lesson.startMinute}|${lesson.durationMinutes}|${lesson.instructor}`;
        const entry = groupSessions.get(key) || { participants: 0 };
        entry.participants += getLessonParticipants(lesson).length;
        groupSessions.set(key, entry);
      } else if (lesson.groupId) {
        const key = `${lesson.groupId}|${dateStr}|${lesson.startMinute}|${lesson.durationMinutes}|${lesson.instructor}`;
        const entry = groupSessions.get(key) || { participants: 0 };
        entry.participants += 1;
        groupSessions.set(key, entry);
      } else {
        individualCount += 1;
        individualDurationMinutes += lesson.durationMinutes || 0;
      }
    }
  }

  const groupLessonsCount = groupSessions.size;
  let groupParticipants = 0;
  for (const entry of groupSessions.values()) {
    groupParticipants += entry.participants;
  }
  return { individualCount, individualDurationMinutes, groupLessonsCount, groupParticipants };
}

function openInstructorPaymentModal() {
  const data = getData();
  const overlay = el('div', { className: 'modal-overlay', onClick: (e) => {
    if (e.target === overlay) overlay.remove();
  }});

  const modal = el('div', { className: 'modal' });
  modal.appendChild(el('div', { className: 'modal-handle' }));
  modal.appendChild(el('h3', {}, t('instructorPaymentReport')));

  const instructorGroup = el('div', { className: 'form-group' });
  instructorGroup.appendChild(el('label', {}, t('selectInstructor')));
  const instructorSelect = el('select', { className: 'form-input', id: 'payment-instructor-select' });
  instructorSelect.appendChild(el('option', { value: '' }, t('noInstructor')));
  for (const instr of data.instructors || []) {
    const name = instr.name || instr;
    instructorSelect.appendChild(el('option', { value: name }, name));
  }
  instructorGroup.appendChild(instructorSelect);
  modal.appendChild(instructorGroup);

  const rangeRow = el('div', { className: 'form-row' });
  const fromGroup = el('div', { className: 'form-group' });
  fromGroup.appendChild(el('label', {}, t('dateFrom')));
  const fromInput = el('input', { className: 'form-input', type: 'date' });
  fromGroup.appendChild(fromInput);
  rangeRow.appendChild(fromGroup);

  const toGroup = el('div', { className: 'form-group' });
  toGroup.appendChild(el('label', {}, t('dateTo')));
  const toInput = el('input', { className: 'form-input', type: 'date', value: formatDate(new Date()) });
  toGroup.appendChild(toInput);
  rangeRow.appendChild(toGroup);
  modal.appendChild(rangeRow);

  const ratesRow = el('div', { className: 'form-row' });
  const individualRateGroup = el('div', { className: 'form-group' });
  individualRateGroup.appendChild(el('label', {}, t('individualRate')));
  const individualRateInput = el('input', { className: 'form-input', type: 'number', min: '0', step: '1', value: '60' });
  individualRateGroup.appendChild(individualRateInput);
  ratesRow.appendChild(individualRateGroup);

  const groupRateGroup = el('div', { className: 'form-group' });
  groupRateGroup.appendChild(el('label', {}, t('groupRatePerPerson')));
  const groupRateInput = el('input', { className: 'form-input', type: 'number', min: '0', step: '1', value: '30' });
  groupRateGroup.appendChild(groupRateInput);
  ratesRow.appendChild(groupRateGroup);
  modal.appendChild(ratesRow);

  const summary = el('div', { className: 'report-summary' },
    el('div', { className: 'report-summary-muted' }, t('reportInstructions'))
  );
  modal.appendChild(summary);

  const updateSummary = () => {
    const instructor = instructorSelect.value;
    const from = fromInput.value;
    const to = toInput.value;
    const individualRate = parseFloat(individualRateInput.value);
    const groupRate = parseFloat(groupRateInput.value);

    if (!instructor || !from || !to) {
      summary.innerHTML = '';
      summary.appendChild(el('div', { className: 'report-summary-muted' }, t('reportInstructions')));
      return;
    }

    const report = computeInstructorPaymentReport({ instructor, from, to });
    const individualPay = (report.individualDurationMinutes / 60) * (isNaN(individualRate) ? 0 : individualRate);
    const groupPay = report.groupParticipants * (isNaN(groupRate) ? 0 : groupRate);
    const totalPay = individualPay + groupPay;

    summary.innerHTML = '';
    summary.appendChild(el('div', { className: 'report-summary-title' }, t('reportSummary')));

    const grid = el('div', { className: 'report-summary-grid' });
    grid.appendChild(el('div', { className: 'report-summary-label' }, t('individualLessons')));
    grid.appendChild(el('div', { className: 'report-summary-value' }, String(report.individualCount)));
    grid.appendChild(el('div', { className: 'report-summary-label' }, t('individualDuration')));
    grid.appendChild(el('div', { className: 'report-summary-value' }, formatDuration(report.individualDurationMinutes)));
    grid.appendChild(el('div', { className: 'report-summary-label' }, t('groupLessons')));
    grid.appendChild(el('div', { className: 'report-summary-value' }, String(report.groupLessonsCount)));
    grid.appendChild(el('div', { className: 'report-summary-label' }, t('groupParticipants')));
    grid.appendChild(el('div', { className: 'report-summary-value' }, String(report.groupParticipants)));
    grid.appendChild(el('div', { className: 'report-summary-label' }, t('individualPay')));
    grid.appendChild(el('div', { className: 'report-summary-value' }, formatCurrency(individualPay)));
    grid.appendChild(el('div', { className: 'report-summary-label' }, t('groupPay')));
    grid.appendChild(el('div', { className: 'report-summary-value' }, formatCurrency(groupPay)));
    grid.appendChild(el('div', { className: 'report-summary-label total' }, t('totalPay')));
    grid.appendChild(el('div', { className: 'report-summary-value total' }, formatCurrency(totalPay)));
    summary.appendChild(grid);
  };

  instructorSelect.addEventListener('change', updateSummary);
  fromInput.addEventListener('change', updateSummary);
  toInput.addEventListener('change', updateSummary);
  individualRateInput.addEventListener('input', updateSummary);
  groupRateInput.addEventListener('input', updateSummary);

  const btnRow = el('div', { className: 'btn-group', style: { marginTop: '16px' } });
  btnRow.appendChild(el('button', {
    className: 'btn btn-secondary',
    style: { width: '100%' },
    onClick: () => overlay.remove()
  }, t('close')));
  modal.appendChild(btnRow);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

// ── Sub-builders ────────────────────────────────────────────────────────
function buildDayScheduleSettings() {
  const { startHour, endHour } = getDayScheduleHours();
  const row = el('div', { className: 'settings-hours-row' });

  const startWrap = el('label', { className: 'settings-field' });
  startWrap.appendChild(el('span', { className: 'settings-field-label' }, t('dayCalendarStart')));
  const startSelect = el('select', { className: 'form-input', id: 'setting-day-start-select' });
  for (let hour = 0; hour <= 23; hour++) {
    const opt = el('option', { value: String(hour) }, formatHourOption(hour));
    if (hour === startHour) opt.selected = true;
    startSelect.appendChild(opt);
  }
  startWrap.appendChild(startSelect);

  const endWrap = el('label', { className: 'settings-field' });
  endWrap.appendChild(el('span', { className: 'settings-field-label' }, t('dayCalendarEnd')));
  const endSelect = el('select', { className: 'form-input', id: 'setting-day-end-select' });
  for (let hour = 1; hour <= 24; hour++) {
    const opt = el('option', { value: String(hour) }, formatHourOption(hour % 24));
    if (hour === endHour) opt.selected = true;
    endSelect.appendChild(opt);
  }
  endWrap.appendChild(endSelect);

  const persistHours = () => {
    let nextStart = Number.parseInt(startSelect.value, 10);
    let nextEnd = Number.parseInt(endSelect.value, 10);
    if (nextEnd <= nextStart) {
      if (document.activeElement === startSelect) {
        nextEnd = Math.min(24, nextStart + 1);
        endSelect.value = String(nextEnd);
      } else {
        nextStart = Math.max(0, nextEnd - 1);
        startSelect.value = String(nextStart);
      }
    }
    const newSettings = getSettings();
    newSettings.dayScheduleStartHour = nextStart;
    newSettings.dayScheduleEndHour = nextEnd;
    saveSettings(newSettings);
  };

  startSelect.addEventListener('change', persistHours);
  endSelect.addEventListener('change', persistHours);
  row.appendChild(startWrap);
  row.appendChild(endWrap);
  return row;
}

function buildGridScaleSettings() {
  return el('div', { className: 'is-hidden' });
}

function promptAdminLogin() {
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

// ── Main export ─────────────────────────────────────────────────────────
export function buildSettingsView() {
  const container = el('div');
  const data = getData();
  const settings = getSettings();

  // ── Auth Section
  const authSection = el('div', { className: 'settings-section' });
  if (isAdmin()) {
    authSection.appendChild(el('h4', {}, t('adminRole')));
    authSection.appendChild(el('p', { style: { marginBottom: '16px', color: 'var(--text-secondary)' } }, t('adminDesc')));
    authSection.appendChild(el('button', {
      className: 'btn btn-secondary',
      style: { width: '100%' },
      onClick: async () => { await logout(); render(); }
    }, t('logout')));
  } else {
    authSection.appendChild(el('button', {
      className: 'btn btn-primary',
      style: { width: '100%' },
      onClick: promptAdminLogin
    }, icon('login'), t('loginAsAdmin')));
  }
  container.appendChild(authSection);
  if (!isAdmin()) {
    // Non-admin: language + display only
    const displaySection = el('div', { className: 'settings-section' });
    displaySection.appendChild(el('h4', {}, t('language')));
    const langRow = el('div', { className: 'add-item-row', style: { marginBottom: '16px' } });
    const langSelect = el('select', { className: 'form-input', id: 'setting-lang-select' });
    for (const l of [{ code: 'en', name: 'English' }, { code: 'pl', name: 'Polski' }]) {
      const opt = el('option', { value: l.code }, l.name);
      if (getLang() === l.code) opt.selected = true;
      langSelect.appendChild(opt);
    }
    langSelect.onchange = (e) => setLang(e.target.value);
    langRow.appendChild(langSelect);
    displaySection.appendChild(langRow);
    displaySection.appendChild(el('h4', {}, t('display')));
    displaySection.appendChild(el('div', { style: { marginTop: '12px' } }, buildGridScaleSettings()));
    container.appendChild(displaySection);
  } else {
    // ── Display section (admin)
  const displaySection = el('div', { className: 'settings-section' });
  displaySection.appendChild(el('h4', {}, t('language')));
  const langRow = el('div', { className: 'add-item-row', style: { marginBottom: '16px' } });
  const langSelect = el('select', { className: 'form-input', id: 'setting-lang-select' });
  for (const l of [{ code: 'en', name: 'English' }, { code: 'pl', name: 'Polski' }]) {
    const opt = el('option', { value: l.code }, l.name);
    if (getLang() === l.code) opt.selected = true;
    langSelect.appendChild(opt);
  }
  langSelect.onchange = (e) => setLang(e.target.value);
  langRow.appendChild(langSelect);
  displaySection.appendChild(langRow);
  displaySection.appendChild(el('h4', {}, t('display')));

  const timeLineRow = el('div', { className: 'toggle-row' });
  timeLineRow.appendChild(el('span', {}, t('showTimeLine')));
  const timeLineToggle = el('div', {
    className: `toggle ${settings.showTimeLine !== false ? 'active' : ''}`,
    id: 'setting-timeline-toggle',
    onClick: () => {
      timeLineToggle.classList.toggle('active');
      const newSettings = getSettings();
      newSettings.showTimeLine = timeLineToggle.classList.contains('active');
      saveSettings(newSettings);
    }
  });
  timeLineRow.appendChild(timeLineToggle);
  displaySection.appendChild(timeLineRow);
  displaySection.appendChild(buildDayScheduleSettings());
  displaySection.appendChild(el('div', { style: { marginTop: '12px' } }, buildGridScaleSettings()));
  container.appendChild(displaySection);

  // ── Horses
  const horsesSection = el('div', { className: 'settings-section' });
  horsesSection.appendChild(el('h4', {}, t('horses')));
  const horsesList = el('div', { className: 'settings-list' });
  for (const h of data.horses) {
    const chip = el('div', { className: 'settings-chip' },
      h,
      isAdmin() ? el('button', { className: 'remove-chip', onClick: () => {
        data.horses = data.horses.filter(x => x !== h);
        saveData(); render();
      }}, icon('close')) : ''
    );
    horsesList.appendChild(chip);
  }
  horsesSection.appendChild(horsesList);

  const addHorseRow = el('div', { className: 'add-item-row' });
  const horseInput = el('input', { className: 'form-input', type: 'text', placeholder: t('addHorse'), id: 'add-horse-input' });
  addHorseRow.appendChild(horseInput);
  addHorseRow.appendChild(el('button', {
    className: 'btn btn-primary btn-sm',
    onClick: () => {
      const name = horseInput.value.trim();
      if (name && !data.horses.includes(name)) { data.horses.push(name); saveData(); render(); }
    }
  }, icon('add')));
  horsesSection.appendChild(addHorseRow);
  container.appendChild(horsesSection);

  // ── Instructors
  const instrSection = el('div', { className: 'settings-section' });
  instrSection.appendChild(el('h4', {}, t('instructors')));
  const instrList = el('div', { className: 'settings-list' });
  for (const i of data.instructors) {
    const colorBox = el('div', {
      className: 'instructor-color-box',
      style: { backgroundColor: i.color },
      onClick: (e) => {
        e.stopPropagation();
        const p = chip.querySelector('.instructor-color-palette');
        if (p) p.classList.toggle('visible');
      }
    });

    const palette = el('div', { className: 'instructor-color-palette' });
    GROUP_COLORS.forEach(color => {
      const pChip = el('div', {
        className: `color-palette-chip ${i.color === color ? 'active' : ''}`,
        style: { backgroundColor: color },
        onClick: (e) => {
          e.stopPropagation();
          updateInstructorColor(i.name, color);
          colorBox.style.backgroundColor = color;
          palette.classList.remove('visible');
          palette.querySelectorAll('.color-palette-chip').forEach(c => c.classList.remove('active'));
          pChip.classList.add('active');
        }
      });
      palette.appendChild(pChip);
    });

    const chip = el('div', { className: 'settings-chip instructor-chip' },
      colorBox,
      palette,
      el('span', { className: 'instructor-name' }, i.name),
      isAdmin() ? el('button', { className: 'remove-chip', onClick: () => { deleteInstructor(i.name); render(); }}, icon('close')) : ''
    );
    instrList.appendChild(chip);
  }
  instrSection.appendChild(instrList);

  const addInstrRow = el('div', { className: 'add-item-row' });
  const instrInput = el('input', { className: 'form-input', type: 'text', placeholder: t('addInstructor'), id: 'add-instructor-input' });
  addInstrRow.appendChild(instrInput);
  addInstrRow.appendChild(el('button', {
    className: 'btn btn-primary btn-sm',
    onClick: () => { const name = instrInput.value.trim(); if (addInstructor(name)) render(); }
  }, icon('add')));
  instrSection.appendChild(addInstrRow);
  container.appendChild(instrSection);

  // ── Reports
  const reportSection = el('div', { className: 'settings-section' });
  reportSection.appendChild(el('h4', {}, t('reports')));
  reportSection.appendChild(el('button', {
    className: 'btn btn-primary btn-sm',
    style: { width: '100%' },
    onClick: () => openInstructorPaymentModal()
  }, icon('payments'), t('generatePaymentReport')));
  container.appendChild(reportSection);

  // ── Data management
  const dataSection = el('div', { className: 'settings-section' });
  dataSection.appendChild(el('h4', {}, t('data')));
  dataSection.appendChild(el('button', {
    className: 'btn btn-secondary btn-sm',
    style: { marginBottom: '8px', width: '100%' },
    onClick: () => {
      const d = getData();
      const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `horsebook-backup-${formatDate(new Date())}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast(t('backupDownloaded'), 'download');
    }
  }, icon('download'), t('exportBackup')));

  dataSection.appendChild(el('button', {
    className: 'btn btn-secondary btn-sm',
    style: { width: '100%' },
    onClick: () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      input.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const imported = JSON.parse(ev.target.result);
            Object.assign(data, imported);
            saveData(); render();
            showToast(t('dataImportedSuccessfully'), 'upload');
          } catch {
            showToast(t('invalidBackupFile'), 'error');
          }
        };
        reader.readAsText(file);
      };
      input.click();
    }
  }, icon('upload'), t('importBackup')));
  container.appendChild(dataSection);
  }

  // ── Database Info (Admin only)
  if (isAdmin()) {
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
    const isTest = supabaseUrl.includes('ntgbganoxvpxrfhdrary');
    const dbTag = isTest ? t('test') : t('live');
    const tagColor = isTest ? 'var(--amber)' : 'var(--green)';
    const tagBg = isTest ? 'var(--amber-soft)' : 'var(--green-soft)';

    const dbInfo = el('div', {
      style: {
        marginTop: '32px',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '8px',
        opacity: '0.7'
      }
    });
    dbInfo.append(
      el('div', {
        style: {
          fontSize: '0.6rem',
          fontWeight: '700',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          color: 'var(--text-muted)'
        }
      }),
      el('div', {
        style: {
          fontSize: '0.7rem',
          fontWeight: '700',
          color: tagColor,
          padding: '4px 12px',
          background: tagBg,
          borderRadius: '999px',
          border: `1px solid ${tagColor}33`,
          textTransform: 'uppercase',
          letterSpacing: '0.05em'
        }
      }, dbTag)
    );
    // Explicit label for database info
    dbInfo.firstChild.textContent = t('database');
    container.appendChild(dbInfo);
  }

  return container;
}
