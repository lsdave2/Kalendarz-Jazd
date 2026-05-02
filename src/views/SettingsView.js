import { t, setLang, getLang } from '../i18n.js';
import { el, icon, formatDate, getDatesInRange, setupModalSwipeToClose } from '../utils.js';
import {
  getData, saveData, isAdmin, login, logout, generateId,
  getLessonsForDate, GROUP_COLORS, updateInstructorColor, addInstructor, deleteInstructor,
  addHorse, deleteHorse, importData,
  addExpense, updateExpense, deleteExpense
} from '../store.js';
import { render, showToast } from '../main.js';
import { isGroupLessonRecord, isCustomLessonRecord, getLessonParticipants } from '../services/LessonService.js';
import {
  formatCurrency, formatDuration, parseRate,
  getPaymentReportRates, savePaymentReportRates,
  getRevenueReportRates, saveRevenueReportRates,
  computeRevenueReport, computeInstructorPaymentReport, computeInstructorPaymentAmount
} from '../services/ReportService.js';

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

// Removed duplicated reporting logic - now using ReportService.js

function createRevenueStatValue(count, revenue) {
  return el('div', { className: 'report-summary-stat' },
    el('div', { className: 'report-summary-stat-count' }, `${count}×`),
    el('div', { className: 'report-summary-stat-revenue' }, formatCurrency(revenue))
  );
}

function openInstructorPaymentModal() {
  const data = getData();
  const savedRates = getPaymentReportRates();
  const overlay = el('div', { className: 'modal-overlay' });
  overlay.onclick = (e) => {
    if (e.target === overlay) closeModal();
  };

  const modal = el('div', { className: 'modal' });
  const handle = el('div', { className: 'modal-handle' });
  const { closeModal } = setupModalSwipeToClose(modal, overlay, handle, () => overlay.remove());
  modal.appendChild(handle);
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
  const individualRateInput = el('input', { className: 'form-input', type: 'number', min: '0', step: '1', value: String(savedRates.individual) });
  individualRateGroup.appendChild(individualRateInput);
  ratesRow.appendChild(individualRateGroup);

  const groupRateGroup = el('div', { className: 'form-group' });
  groupRateGroup.appendChild(el('label', {}, t('groupRatePerPerson')));
  const groupRateInput = el('input', { className: 'form-input', type: 'number', min: '0', step: '1', value: String(savedRates.group) });
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
    savePaymentReportRates(individualRate, groupRate);

    if (!instructor || !from || !to) {
      summary.innerHTML = '';
      summary.appendChild(el('div', { className: 'report-summary-muted' }, t('reportInstructions')));
      return;
    }

    const report = computeInstructorPaymentReport({ instructor, from, to });
    const individualPay = (report.individualDurationMinutes / 60) * (isNaN(individualRate) ? 0 : individualRate);
    const customPay = (report.customDurationMinutes / 60) * (isNaN(individualRate) ? 0 : individualRate);
    const groupPay = report.groupParticipants * (isNaN(groupRate) ? 0 : groupRate);
    const totalPay = individualPay + customPay + groupPay;

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
    grid.appendChild(el('div', { className: 'report-summary-label' }, t('customLesson')));
    grid.appendChild(el('div', { className: 'report-summary-value' }, String(report.customCount)));
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
    onClick: () => closeModal()
  }, t('close')));
  modal.appendChild(btnRow);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

function openRevenueReportModal() {
  const today = formatDate(new Date());
  const data = getData();
  const overlay = el('div', { className: 'modal-overlay' });
  overlay.onclick = (e) => {
    if (e.target === overlay) closeModal();
  };

  const modal = el('div', { className: 'modal' });
  const handle = el('div', { className: 'modal-handle' });
  const { closeModal } = setupModalSwipeToClose(modal, overlay, handle, () => overlay.remove());
  modal.appendChild(handle);
  modal.appendChild(el('h3', {}, t('revenueReportTitle')));

  const rangeRow = el('div', { className: 'form-row' });
  const fromGroup = el('div', { className: 'form-group' });
  fromGroup.appendChild(el('label', {}, t('dateFrom')));
  const fromInput = el('input', { className: 'form-input', type: 'date', value: today });
  fromGroup.appendChild(fromInput);
  rangeRow.appendChild(fromGroup);

  const toGroup = el('div', { className: 'form-group' });
  toGroup.appendChild(el('label', {}, t('dateTo')));
  const toInput = el('input', { className: 'form-input', type: 'date', value: today });
  toGroup.appendChild(toInput);
  rangeRow.appendChild(toGroup);
  modal.appendChild(rangeRow);

  const savedRevenueRates = getRevenueReportRates();

  const ratesRow = el('div', { className: 'form-row' });
  const individualRateGroup = el('div', { className: 'form-group' });
  individualRateGroup.appendChild(el('label', {}, t('individualLessonRate')));
  const individualRateInput = el('input', {
    className: 'form-input',
    type: 'number',
    min: '0',
    step: '0.01',
    value: String(savedRevenueRates.individual)
  });
  individualRateGroup.appendChild(individualRateInput);
  ratesRow.appendChild(individualRateGroup);

  const groupRateGroup = el('div', { className: 'form-group' });
  groupRateGroup.appendChild(el('label', {}, t('groupLessonRate')));
  const groupRateInput = el('input', {
    className: 'form-input',
    type: 'number',
    min: '0',
    step: '0.01',
    value: String(savedRevenueRates.group)
  });
  groupRateGroup.appendChild(groupRateInput);
  ratesRow.appendChild(groupRateGroup);
  modal.appendChild(ratesRow);

  const packageRatesRow = el('div', { className: 'form-row' });
  const individualPackageRateGroup = el('div', { className: 'form-group' });
  individualPackageRateGroup.appendChild(el('label', {}, t('individualPackageLessonRate')));
  const individualPackageRateInput = el('input', {
    className: 'form-input',
    type: 'number',
    min: '0',
    step: '0.01',
    value: String(savedRevenueRates.individualPackage)
  });
  individualPackageRateGroup.appendChild(individualPackageRateInput);
  packageRatesRow.appendChild(individualPackageRateGroup);

  const groupPackageRateGroup = el('div', { className: 'form-group' });
  groupPackageRateGroup.appendChild(el('label', {}, t('groupPackageLessonRate')));
  const groupPackageRateInput = el('input', {
    className: 'form-input',
    type: 'number',
    min: '0',
    step: '0.01',
    value: String(savedRevenueRates.groupPackage)
  });
  groupPackageRateGroup.appendChild(groupPackageRateInput);
  packageRatesRow.appendChild(groupPackageRateGroup);
  modal.appendChild(packageRatesRow);

  const detailedRow = el('div', { className: 'toggle-row', style: { marginTop: '12px' } });
  detailedRow.appendChild(el('span', {}, t('detailedReport')));
  const detailedToggle = el('div', {
    className: 'toggle',
    onClick: () => {
      detailedToggle.classList.toggle('active');
      updateSummary();
    }
  });
  detailedRow.appendChild(detailedToggle);
  modal.appendChild(detailedRow);
  modal.appendChild(el('p', {
    className: 'report-summary-muted',
    style: { marginTop: '8px', marginBottom: '0' }
  }, t('detailedReportHint')));

  const instructorSection = el('div', { className: 'report-instructor-section' });
  instructorSection.appendChild(el('div', { className: 'report-instructor-title' }, t('deductInstructorPayments')));
  const instructorList = el('div', { className: 'report-instructor-list' });
  const instructorRows = [];
  for (const instr of data.instructors || []) {
    const name = instr.name || instr;
    const rowState = { name, active: false, amount: 0, amountEl: null, toggleEl: null };
    const row = el('div', { className: 'report-instructor-row' });
    const left = el('div', { className: 'report-instructor-left' });
    left.appendChild(el('div', { className: 'report-instructor-name' }, name));
    left.appendChild(el('div', { className: 'report-instructor-payment', }, formatCurrency(0)));
    row.appendChild(left);
    rowState.amountEl = left.lastChild;
    const toggle = el('div', {
      className: 'toggle',
      onClick: () => {
        rowState.active = !rowState.active;
        toggle.classList.toggle('active', rowState.active);
        updateSummary();
      }
    });
    rowState.toggleEl = toggle;
    row.appendChild(toggle);
    instructorList.appendChild(row);
    instructorRows.push(rowState);
  }
  if (instructorRows.length === 0) {
    instructorList.appendChild(el('div', { className: 'report-instructor-empty' }, t('noInstructorsYet') || t('noInstructor')));
  }
  instructorSection.appendChild(instructorList);
  modal.appendChild(instructorSection);

  const summary = el('div', { className: 'report-summary' },
    el('div', { className: 'report-summary-muted' }, t('revenueReportInstructions'))
  );
  modal.appendChild(summary);

  const updateSummary = () => {
    const from = fromInput.value;
    const to = toInput.value;
    if (!from || !to) {
      summary.innerHTML = '';
      summary.appendChild(el('div', { className: 'report-summary-muted' }, t('revenueReportInstructions')));
      return;
    }

    const individualRate = parseRate(individualRateInput.value);
    const groupRate = parseRate(groupRateInput.value);
    const individualPackageRate = parseRate(individualPackageRateInput.value);
    const groupPackageRate = parseRate(groupPackageRateInput.value);
    const paymentRates = getPaymentReportRates();

    saveRevenueReportRates({
      individual: individualRate,
      group: groupRate,
      individualPackage: individualPackageRate,
      groupPackage: groupPackageRate
    });

    const report = computeRevenueReport({
      from,
      to,
      rates: { individualRate, groupRate, individualPackageRate, groupPackageRate }
    });
    const grossRevenue = report.totals.individual.revenue
      + report.totals.group.revenue
      + report.totals.individualPackage.revenue
      + report.totals.groupPackage.revenue
      + report.totals.custom.revenue;
    let instructorDeductions = 0;
    const selectedInstructorRows = [];
    for (const rowState of instructorRows) {
      const amount = computeInstructorPaymentAmount({
        instructor: rowState.name,
        from,
        to,
        individualRate: paymentRates.individual,
        groupRate: paymentRates.group
      });
      rowState.amount = amount;
      if (rowState.amountEl) rowState.amountEl.textContent = formatCurrency(amount);
      if (rowState.active) {
        instructorDeductions += amount;
        selectedInstructorRows.push(rowState);
      }
    }
    const totalRevenue = grossRevenue - instructorDeductions;

    summary.innerHTML = '';
    summary.appendChild(el('div', { className: 'report-summary-title' }, t('reportSummary')));

    if (!detailedToggle.classList.contains('active')) {
      const grid = el('div', { className: 'report-summary-grid' });
      grid.appendChild(el('div', { className: 'report-summary-label' }, t('individualLessonRevenue')));
      grid.appendChild(createRevenueStatValue(report.totals.individual.count, report.totals.individual.revenue));
      grid.appendChild(el('div', { className: 'report-summary-label' }, t('groupLessonRevenue')));
      grid.appendChild(createRevenueStatValue(report.totals.group.count, report.totals.group.revenue));
      grid.appendChild(el('div', { className: 'report-summary-label' }, t('individualPackageLessonRevenue')));
      grid.appendChild(createRevenueStatValue(report.totals.individualPackage.count, report.totals.individualPackage.revenue));
      grid.appendChild(el('div', { className: 'report-summary-label' }, t('groupPackageLessonRevenue')));
      grid.appendChild(createRevenueStatValue(report.totals.groupPackage.count, report.totals.groupPackage.revenue));
      grid.appendChild(el('div', { className: 'report-summary-label' }, t('customLessonRevenue')));
      grid.appendChild(createRevenueStatValue(report.totals.custom.count, report.totals.custom.revenue));
      grid.appendChild(el('div', { className: 'report-summary-label' }, t('grossRevenue')));
      grid.appendChild(el('div', { className: 'report-summary-value' }, formatCurrency(grossRevenue)));
      grid.appendChild(el('div', { className: 'report-summary-label' }, t('instructorDeductions')));
      grid.appendChild(el('div', { className: 'report-summary-value' }, formatCurrency(instructorDeductions)));
      grid.appendChild(el('div', { className: 'report-summary-label total' }, t('netRevenue')));
      grid.appendChild(el('div', { className: 'report-summary-value total' }, formatCurrency(totalRevenue)));
      summary.appendChild(grid);
      return;
    }

    summary.appendChild(el('div', {
      className: 'report-summary-grid',
      style: { marginBottom: '12px' }
    },
      el('div', { className: 'report-summary-label' }, t('grossRevenue')),
      el('div', { className: 'report-summary-value' }, formatCurrency(grossRevenue))
    ));

    for (const day of report.days) {
      const daySection = el('div', { className: 'report-day-section' });
      const dayHeader = el('div', { className: 'report-day-header' });
      dayHeader.appendChild(el('div', { className: 'report-day-title' }, day.dateStr));
      dayHeader.appendChild(el('div', { className: 'report-day-total' }, formatCurrency(day.total)));
      daySection.appendChild(dayHeader);

      const entriesWrap = el('div', { className: 'report-day-entries' });
      for (const entry of day.entries) {
        const row = el('div', { className: 'report-entry-row' });
        const left = el('div', { className: 'report-entry-left' });
        left.appendChild(el('div', { className: 'report-entry-name' }, entry.clientName || t('client')));
        const metaText = entry.lessonType === 'custom' 
          ? t('custom') 
          : `${t(entry.lessonType)} - ${formatDuration(Math.round(entry.durationMultiplier * 60))} × ${formatCurrency(entry.rate)}`;
        left.appendChild(el('div', { className: 'report-entry-meta' }, metaText));
        row.appendChild(left);
        row.appendChild(el('div', { className: 'report-entry-amount' }, formatCurrency(entry.amount)));
        entriesWrap.appendChild(row);
      }

      daySection.appendChild(entriesWrap);
      summary.appendChild(daySection);
    }

    if (selectedInstructorRows.length > 0) {
      const deductionSection = el('div', { className: 'report-day-section' });
      const deductionHeader = el('div', { className: 'report-day-header' });
      deductionHeader.appendChild(el('div', { className: 'report-day-title' }, t('instructorDeductions')));
      deductionHeader.appendChild(el('div', { className: 'report-day-total' }, `-${formatCurrency(instructorDeductions)}`));
      deductionSection.appendChild(deductionHeader);

      const deductionList = el('div', { className: 'report-day-entries' });
      for (const rowState of selectedInstructorRows) {
        const row = el('div', { className: 'report-entry-row' });
        const left = el('div', { className: 'report-entry-left' });
        left.appendChild(el('div', { className: 'report-entry-name' }, rowState.name));
        left.appendChild(el('div', { className: 'report-entry-meta' }, t('instructorPayment')));
        row.appendChild(left);
        row.appendChild(el('div', { className: 'report-entry-amount' }, `-${formatCurrency(rowState.amount)}`));
        deductionList.appendChild(row);
      }
      deductionSection.appendChild(deductionList);
      summary.appendChild(deductionSection);
    }

    summary.appendChild(el('div', { className: 'report-day-section' },
      el('div', { className: 'report-day-header' },
        el('div', { className: 'report-day-title' }, t('netRevenue')),
        el('div', { className: 'report-day-total' }, formatCurrency(totalRevenue))
      )
    ));
  };

  fromInput.addEventListener('change', updateSummary);
  toInput.addEventListener('change', updateSummary);
  individualRateInput.addEventListener('input', updateSummary);
  groupRateInput.addEventListener('input', updateSummary);
  individualPackageRateInput.addEventListener('input', updateSummary);
  groupPackageRateInput.addEventListener('input', updateSummary);

  updateSummary();

  const btnRow = el('div', { className: 'btn-group', style: { marginTop: '16px' } });
  btnRow.appendChild(el('button', {
    className: 'btn btn-secondary',
    style: { width: '100%' },
    onClick: () => closeModal()
  }, t('close')));
  modal.appendChild(btnRow);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

function openExpensesReportModal() {
  const overlay = el('div', { className: 'modal-overlay' });
  overlay.onclick = (e) => {
    if (e.target === overlay) closeModal();
  };

  const modal = el('div', { className: 'modal' });
  const handle = el('div', { className: 'modal-handle' });
  const { closeModal } = setupModalSwipeToClose(modal, overlay, handle, () => overlay.remove());
  modal.appendChild(handle);
  modal.appendChild(el('h3', {}, 'Expenses Reporting'));

  const content = el('div', { className: 'expenses-content' });
  modal.appendChild(content);

  const renderExpenses = () => {
    content.innerHTML = '';
    const d = getData();
    const expenses = d.expenses || [];

    const list = el('div', { className: 'expenses-list' });
    expenses.sort((a, b) => new Date(b.date) - new Date(a.date)).forEach(exp => {
      const row = el('div', {
        className: 'expense-row',
        style: {
          display: 'flex',
          justifyContent: 'space-between',
          padding: '8px',
          borderBottom: '1px solid var(--border-color)',
          cursor: 'pointer'
        },
        onClick: () => openExpenseEditModal(exp, renderExpenses)
      });
      const left = el('div', {});
      left.appendChild(el('div', { style: { fontWeight: 'bold' } }, exp.title || 'Untitled'));
      left.appendChild(el('div', { style: { fontSize: '0.8rem', color: 'var(--text-muted)' } }, exp.date));
      const right = el('div', { style: { fontWeight: 'bold' } }, formatCurrency(exp.cost));
      
      row.appendChild(left);
      row.appendChild(right);
      list.appendChild(row);
    });

    if (expenses.length === 0) {
      list.appendChild(el('div', { style: { textAlign: 'center', padding: '16px', color: 'var(--text-muted)' } }, 'No expenses yet.'));
    }

    content.appendChild(list);

    const btnRow = el('div', { className: 'btn-group', style: { marginTop: '16px' } });
    btnRow.appendChild(el('button', {
      className: 'btn btn-primary',
      style: { width: '100%' },
      onClick: () => openExpenseEditModal(null, renderExpenses)
    }, icon('add'), 'Add Expense'));
    btnRow.appendChild(el('button', {
      className: 'btn btn-secondary',
      style: { width: '100%' },
      onClick: () => closeModal()
    }, t('close')));
    content.appendChild(btnRow);
  };

  renderExpenses();

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

function openExpenseEditModal(expense, onSave) {
  const overlay = el('div', { className: 'modal-overlay' });
  overlay.onclick = (e) => {
    if (e.target === overlay) closeModal();
  };

  const modal = el('div', { className: 'modal' });
  const handle = el('div', { className: 'modal-handle' });
  const { closeModal } = setupModalSwipeToClose(modal, overlay, handle, () => overlay.remove());
  modal.appendChild(handle);
  modal.appendChild(el('h3', {}, expense ? 'Edit Expense' : 'Add Expense'));

  const titleGroup = el('div', { className: 'form-group' });
  titleGroup.appendChild(el('label', {}, 'Title'));
  const titleInput = el('input', { className: 'form-input', type: 'text', value: expense?.title || '' });
  titleGroup.appendChild(titleInput);
  modal.appendChild(titleGroup);

  const costGroup = el('div', { className: 'form-group' });
  costGroup.appendChild(el('label', {}, 'Cost'));
  const costInput = el('input', { className: 'form-input', type: 'number', step: '0.01', value: String(expense?.cost || '') });
  costGroup.appendChild(costInput);
  modal.appendChild(costGroup);

  const dateGroup = el('div', { className: 'form-group' });
  dateGroup.appendChild(el('label', {}, 'Date'));
  const dateInput = el('input', { className: 'form-input', type: 'date', value: expense?.date || formatDate(new Date()) });
  dateGroup.appendChild(dateInput);
  modal.appendChild(dateGroup);

  const descGroup = el('div', { className: 'form-group' });
  descGroup.appendChild(el('label', {}, 'Description/Comments'));
  const descInput = el('textarea', { className: 'form-input', style: { minHeight: '80px', resize: 'vertical' } });
  descInput.value = expense?.description || '';
  descGroup.appendChild(descInput);
  modal.appendChild(descGroup);

  const btnGroup = el('div', { className: 'btn-group', style: { marginTop: '16px' } });

  btnGroup.appendChild(el('button', {
    className: 'btn btn-primary',
    style: { flex: '1' },
    onClick: () => {
      const data = {
        title: titleInput.value.trim(),
        cost: Number.parseFloat(costInput.value) || 0,
        date: dateInput.value || formatDate(new Date()),
        description: descInput.value.trim()
      };
      if (expense) {
        updateExpense(expense.id, data);
      } else {
        addExpense(data);
      }
      closeModal();
      if (onSave) onSave();
    }
  }, expense ? 'Save' : 'Add'));

  if (expense) {
    btnGroup.appendChild(el('button', {
      className: 'btn btn-danger',
      onClick: () => {
        if (confirm('Delete this expense?')) {
          deleteExpense(expense.id);
          closeModal();
          if (onSave) onSave();
        }
      }
    }, icon('delete')));
  }

  modal.appendChild(btnGroup);

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
        deleteHorse(h);
        render();
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
      if (addHorse(name)) render();
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
            importData(imported);
            render();
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
