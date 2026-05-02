import { t, getLang } from '../i18n.js';
import { el, icon, formatDate, setupModalSwipeToClose } from '../utils.js';
import { getData, addExpense, updateExpense, deleteExpense, addIncome, updateIncome, deleteIncome } from '../store.js';
import {
  formatCurrency, formatDuration, parseRate,
  getPaymentReportRates, savePaymentReportRates,
  getRevenueReportRates, saveRevenueReportRates,
  computeRevenueReport, computeInstructorPaymentReport, computeInstructorPaymentAmount,
} from '../services/ReportService.js';

function defaultFrom() {
  const d = new Date(); d.setDate(d.getDate() - 7);
  return formatDate(d);
}

// ── Collapsible Section ─────────────────────────────────────────────
function buildSection(titleText, iconName, contentBuilder, { collapsed = true } = {}) {
  const section = el('div', { className: 'fin-section' });
  const header = el('div', { className: 'fin-section-header', onClick: () => {
    section.classList.toggle('collapsed');
    arrow.textContent = section.classList.contains('collapsed') ? 'expand_more' : 'expand_less';
  }});
  const arrow = el('span', { className: 'material-symbols-rounded fin-section-arrow' },
    collapsed ? 'expand_more' : 'expand_less');
  header.appendChild(el('div', { className: 'fin-section-title' }, icon(iconName), titleText));
  header.appendChild(arrow);
  section.appendChild(header);
  const body = el('div', { className: 'fin-section-body' });
  contentBuilder(body);
  section.appendChild(body);
  if (collapsed) section.classList.add('collapsed');
  return { section, body };
}

// ── Transaction Edit Modal ──────────────────────────────────────────
function openTransactionEditModal(transaction, onSave) {
  const overlay = el('div', { className: 'modal-overlay' });
  overlay.onclick = (e) => { if (e.target === overlay) closeModal(); };
  const modal = el('div', { className: 'modal' });
  const handle = el('div', { className: 'modal-handle' });
  const { closeModal } = setupModalSwipeToClose(modal, overlay, handle, () => overlay.remove());
  modal.appendChild(handle);
  modal.appendChild(el('h3', {}, transaction ? t('editTransaction') : t('addTransaction')));

  const typeG = el('div', { className: 'form-group' });
  typeG.appendChild(el('label', {}, t('transactionType')));
  const typeRow = el('div', { className: 'fin-cat-picker' }); // Reuse class for layout
  let selectedType = transaction?.type || 'expense';
  const types = [
    { id: 'expense', label: t('expense'), icon: 'remove_circle' },
    { id: 'income', label: t('income'), icon: 'add_circle' }
  ];
  types.forEach(type => {
    const chip = el('button', {
      className: `fin-cat-chip ${type.id === selectedType ? 'active' : ''}`,
      onClick: () => {
        selectedType = type.id;
        typeRow.querySelectorAll('.fin-cat-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
      }
    }, icon(type.icon), type.label);
    typeRow.appendChild(chip);
  });
  typeG.appendChild(typeRow);
  modal.appendChild(typeG);

  const titleG = el('div', { className: 'form-group' });
  titleG.appendChild(el('label', {}, t('transactionTitle')));
  const titleInput = el('input', { className: 'form-input', type: 'text', value: transaction?.title || '' });
  titleG.appendChild(titleInput);
  modal.appendChild(titleG);

  const costG = el('div', { className: 'form-group' });
  costG.appendChild(el('label', {}, t('transactionValue')));
  const costInput = el('input', { className: 'form-input', type: 'number', step: '0.01', value: String(transaction?.cost || '') });
  costG.appendChild(costInput);
  modal.appendChild(costG);

  const dateG = el('div', { className: 'form-group' });
  dateG.appendChild(el('label', {}, t('date')));
  const dateInput = el('input', { className: 'form-input', type: 'date', value: transaction?.date || formatDate(new Date()) });
  dateG.appendChild(dateInput);
  modal.appendChild(dateG);

  const descG = el('div', { className: 'form-group' });
  descG.appendChild(el('label', {}, t('description')));
  const descInput = el('textarea', { className: 'form-input', style: { minHeight: '60px', resize: 'vertical' } });
  descInput.value = transaction?.description || '';
  descG.appendChild(descInput);
  modal.appendChild(descG);

  const btnG = el('div', { className: 'btn-group', style: { marginTop: '16px' } });
  btnG.appendChild(el('button', { className: 'btn btn-primary', style: { flex: '1' }, onClick: () => {
    const data = {
      title: titleInput.value.trim(), cost: Number.parseFloat(costInput.value) || 0,
      date: dateInput.value || formatDate(new Date()), description: descInput.value.trim(),
      type: selectedType,
    };
    if (transaction) {
      if (selectedType === transaction.type) {
        if (selectedType === 'income') updateIncome(transaction.id, data);
        else updateExpense(transaction.id, data);
      } else {
        // Type changed: delete from old, add to new
        if (transaction.type === 'income') deleteIncome(transaction.id);
        else deleteExpense(transaction.id);
        if (selectedType === 'income') addIncome(data);
        else addExpense(data);
      }
    } else {
      if (selectedType === 'income') addIncome(data);
      else addExpense(data);
    }
    closeModal(); if (onSave) onSave();
  }}, transaction ? t('saveKey') : t('add')));
  if (transaction) {
    btnG.appendChild(el('button', { className: 'btn btn-danger', onClick: () => {
      if (confirm(t('deleteTransactionConfirm'))) {
        if (transaction.type === 'income') deleteIncome(transaction.id);
        else deleteExpense(transaction.id);
        closeModal(); if (onSave) onSave();
      }
    }}, icon('delete')));
  }
  btnG.appendChild(el('button', { className: 'btn btn-secondary', onClick: () => closeModal() }, t('cancel')));
  modal.appendChild(btnG);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

// ── Main View ───────────────────────────────────────────────────────
export function buildFinancesView() {
  const container = el('div', { className: 'fin-container' });
  const data = getData();
  const payRates = getPaymentReportRates();
  const revRates = getRevenueReportRates();

  // State
  let fromVal = defaultFrom(), toVal = formatDate(new Date());
  let indRate = revRates.individual, grpRate = revRates.group;
  let indPkgRate = revRates.individualPackage, grpPkgRate = revRates.groupPackage;
  let payIndRate = payRates.individual, payGrpRate = payRates.group;
  let showDetailedRevenue = false;

  const instrStates = (data.instructors || []).map(i => ({
    name: i.name || i, active: true, amount: 0, stats: null, indPay: 0, grpPay: 0, expanded: false
  }));

  // Refs for dynamic update
  let plBody = null, instrBody = null, expBody = null;

  function recalc() {
    const rr = computeRevenueReport({
      from: fromVal, to: toVal,
      rates: { individualRate: indRate, groupRate: grpRate, individualPackageRate: indPkgRate, groupPackageRate: grpPkgRate },
    });
    const gross = rr.totals.individual.revenue + rr.totals.group.revenue
      + rr.totals.individualPackage.revenue + rr.totals.groupPackage.revenue
      + rr.totals.custom.revenue;

    let instrTotal = 0;
    for (const s of instrStates) {
      const rep = computeInstructorPaymentReport({
        instructor: s.name, from: fromVal, to: toVal
      });
      s.stats = rep;
      s.indPay = (rep.individualDurationMinutes / 60) * payIndRate;
      s.grpPay = rep.groupParticipants * payGrpRate;
      s.amount = s.indPay + s.grpPay;
      if (s.active) instrTotal += s.amount;
    }

    const rangeExp = (data.expenses || []).filter(e => e.date >= fromVal && e.date <= toVal);
    const rangeInc = (data.incomes || []).filter(e => e.date >= fromVal && e.date <= toVal);
    const transactions = [
      ...rangeExp.map(e => ({ ...e, type: 'expense' })),
      ...rangeInc.map(i => ({ ...i, type: 'income' }))
    ];
    const expTotal = rangeExp.reduce((s, e) => s + (e.cost || 0), 0);
    const incTotal = rangeInc.reduce((s, i) => s + (i.cost || 0), 0);
    const net = gross + incTotal - instrTotal - expTotal;

    // Update instructor section
    if (instrBody) {
      instrBody.innerHTML = '';
      renderInstructorSection(instrBody, instrStates, recalc);
    }

    // Update P&L & Revenue Combined
    if (plBody) {
      plBody.innerHTML = '';
      
      const revG = el('div', { className: 'report-summary-grid', style: { marginBottom: '16px', paddingBottom: '16px', borderBottom: '1px dashed var(--border)' } });
      revG.appendChild(el('div', { className: 'report-summary-label' }, t('individualLessonRevenue')));
      revG.appendChild(mkStat(rr.totals.individual.count, rr.totals.individual.revenue));
      revG.appendChild(el('div', { className: 'report-summary-label' }, t('groupLessonRevenue')));
      revG.appendChild(mkStat(rr.totals.group.count, rr.totals.group.revenue));
      revG.appendChild(el('div', { className: 'report-summary-label' }, t('individualPackageLessonRevenue')));
      revG.appendChild(mkStat(rr.totals.individualPackage.count, rr.totals.individualPackage.revenue));
      revG.appendChild(el('div', { className: 'report-summary-label' }, t('groupPackageLessonRevenue')));
      revG.appendChild(mkStat(rr.totals.groupPackage.count, rr.totals.groupPackage.revenue));
      revG.appendChild(el('div', { className: 'report-summary-label' }, t('customLessonRevenue')));
      revG.appendChild(mkStat(rr.totals.custom.count, rr.totals.custom.revenue));
      plBody.appendChild(revG);

      const plG = el('div', { className: 'report-summary-grid' });
      plG.appendChild(el('div', { className: 'report-summary-label' }, t('grossRevenue')));
      plG.appendChild(el('div', { className: 'report-summary-value' }, formatCurrency(gross)));
      plG.appendChild(el('div', { className: 'report-summary-label' }, t('incomeTotal') + ':'));
      plG.appendChild(el('div', { className: 'report-summary-value' }, `+ ${formatCurrency(incTotal)}`));
      plG.appendChild(el('div', { className: 'report-summary-label' }, t('instructorDeductions') + ':'));
      plG.appendChild(el('div', { className: 'report-summary-value' }, `− ${formatCurrency(instrTotal)}`));
      plG.appendChild(el('div', { className: 'report-summary-label' }, t('expensesTotal') + ':'));
      plG.appendChild(el('div', { className: 'report-summary-value' }, `− ${formatCurrency(expTotal)}`));
      plG.appendChild(el('div', { className: 'report-summary-label total' }, t('netProfit')));
      plG.appendChild(el('div', { className: 'report-summary-value total' }, formatCurrency(net)));
      plBody.appendChild(plG);

      const detailedG = el('div', { className: 'toggle-row', style: { marginTop: '16px', borderTop: '1px solid var(--border)', paddingTop: '16px' } });
      detailedG.appendChild(el('span', {}, t('detailedReport')));
      const detailedToggle = el('div', {
        className: `toggle ${showDetailedRevenue ? 'active' : ''}`,
        onClick: () => { showDetailedRevenue = !showDetailedRevenue; recalc(); }
      });
      detailedG.appendChild(detailedToggle);
      plBody.appendChild(detailedG);

      if (showDetailedRevenue && rr.days.length > 0) {
        const daysList = el('div', { className: 'report-day-list', style: { display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '12px' } });
        for (const day of rr.days) {
          const dayDiv = el('div', { className: 'report-day-section' });
          const dayHeader = el('div', { className: 'report-day-header' });
          dayHeader.appendChild(el('div', { className: 'report-day-title' }, day.dateStr));
          dayHeader.appendChild(el('div', { className: 'report-day-total' }, formatCurrency(day.total)));
          dayDiv.appendChild(dayHeader);
          
          const entriesList = el('div', { className: 'report-day-entries' });
          for (const entry of day.entries) {
            const entryRow = el('div', { className: 'report-entry-row' });
            const left = el('div', { className: 'report-entry-left' });
            left.appendChild(el('div', { className: 'report-entry-name' }, entry.clientName || t('client')));
            const metaText = entry.lessonType === 'custom' 
              ? t(entry.lessonType) 
              : `${t(entry.lessonType)} - ${formatDuration(entry.durationMultiplier * 60)} × ${formatCurrency(entry.rate)}`;
            left.appendChild(el('div', { className: 'report-entry-meta' }, metaText));
            entryRow.appendChild(left);
            entryRow.appendChild(el('div', { className: 'report-entry-amount' }, formatCurrency(entry.amount)));
            entriesList.appendChild(entryRow);
          }
          dayDiv.appendChild(entriesList);
          daysList.appendChild(dayDiv);
        }
        plBody.appendChild(daysList);
      }
    }

    // Update transactions list
    if (expBody) {
      expBody.innerHTML = '';
      renderTransactionsList(expBody, transactions, recalc);
    }
  }

  function mkStat(count, revenue) {
    return el('div', { className: 'report-summary-stat' },
      el('div', { className: 'report-summary-stat-count' }, `${count}×`),
      el('div', { className: 'report-summary-stat-revenue' }, formatCurrency(revenue)));
  }

  // ── 1. Date Range ─────────────────────────────────────────
  const dateSection = el('div', { className: 'fin-section', style: { padding: '16px' } });
  const dateRow = el('div', { className: 'form-row', style: { marginBottom: '0' } });
  const fromG = el('div', { className: 'form-group', style: { marginBottom: '0' } });
  fromG.appendChild(el('label', {}, t('dateFrom')));
  const fromInput = el('input', { className: 'form-input', type: 'date', value: fromVal, onClick: (e) => { try { e.target.showPicker(); } catch(err){} } });
  fromInput.addEventListener('change', () => { fromVal = fromInput.value; recalc(); });
  fromG.appendChild(fromInput);
  dateRow.appendChild(fromG);

  const toG = el('div', { className: 'form-group', style: { marginBottom: '0' } });
  toG.appendChild(el('label', {}, t('dateTo')));
  const toInput = el('input', { className: 'form-input', type: 'date', value: toVal, onClick: (e) => { try { e.target.showPicker(); } catch(err){} } });
  toInput.addEventListener('change', () => { toVal = toInput.value; recalc(); });
  toG.appendChild(toInput);
  dateRow.appendChild(toG);
  dateSection.appendChild(dateRow);
  container.appendChild(dateSection);

  // ── 2. Instructor Payments ────────────────────────────────
  const instrSec = buildSection(t('instructorPayments'), 'school', (body) => {
    instrBody = body;
    renderInstructorSection(body, instrStates, recalc);
  }, { collapsed: false });
  instrBody = instrSec.body;
  container.appendChild(instrSec.section);

  // ── 3. Summary & Breakdown ───────────────────────────────
  const plSec = buildSection(t('plSummary'), 'analytics', (body) => { plBody = body; });
  plBody = plSec.body;
  container.appendChild(plSec.section);

  // ── 4. Transactions ──────────────────────────────────────
  const expSec = buildSection(t('transactionsSection'), 'receipt_long', (body) => {
    expBody = body;
  }, { collapsed: false });
  expBody = expSec.body;
  container.appendChild(expSec.section);

  // ── 6. Rate Settings ─────────────────────────────────────
  const rateSec = buildSection(t('rateSettings'), 'tune', (body) => {
    body.appendChild(el('div', { className: 'fin-rates-label' }, t('revenueRatesLabel')));
    const rr1 = el('div', { className: 'form-row' });
    rr1.appendChild(mkRateInput(t('individualLessonRate'), indRate, v => { indRate = v; saveRevRates(); recalc(); }));
    rr1.appendChild(mkRateInput(t('groupLessonRate'), grpRate, v => { grpRate = v; saveRevRates(); recalc(); }));
    body.appendChild(rr1);
    const rr2 = el('div', { className: 'form-row' });
    rr2.appendChild(mkRateInput(t('individualPackageLessonRate'), indPkgRate, v => { indPkgRate = v; saveRevRates(); recalc(); }));
    rr2.appendChild(mkRateInput(t('groupPackageLessonRate'), grpPkgRate, v => { grpPkgRate = v; saveRevRates(); recalc(); }));
    body.appendChild(rr2);

    body.appendChild(el('div', { className: 'fin-rates-label', style: { marginTop: '16px' } }, t('paymentRatesLabel')));
    const rr3 = el('div', { className: 'form-row' });
    rr3.appendChild(mkRateInput(t('individualRate'), payIndRate, v => { payIndRate = v; savePayRates(); recalc(); }));
    rr3.appendChild(mkRateInput(t('groupRatePerPerson'), payGrpRate, v => { payGrpRate = v; savePayRates(); recalc(); }));
    body.appendChild(rr3);
  });
  container.appendChild(rateSec.section);

  function saveRevRates() {
    saveRevenueReportRates({ individual: indRate, group: grpRate, individualPackage: indPkgRate, groupPackage: grpPkgRate });
  }
  function savePayRates() { savePaymentReportRates(payIndRate, payGrpRate); }

  recalc();
  return container;
}

function mkRateInput(label, value, onChange) {
  const g = el('div', { className: 'form-group' });
  g.appendChild(el('label', {}, label));
  const inp = el('input', { className: 'form-input', type: 'number', min: '0', step: '1', value: String(value) });
  inp.addEventListener('input', () => onChange(parseRate(inp.value)));
  g.appendChild(inp);
  return g;
}

function renderInstructorSection(body, instrStates, recalc) {
  if (instrStates.length === 0) {
    body.appendChild(el('div', { className: 'report-instructor-empty' }, t('noInstructorsYet')));
    return;
  }
  const list = el('div', { className: 'report-instructor-list' });
  for (const s of instrStates) {
    const row = el('div', { className: 'report-instructor-row' });
    const left = el('div', { className: 'report-instructor-left', style: { flex: '1', cursor: 'pointer', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '8px', justifyContent: 'flex-start' }, onClick: () => { s.expanded = !s.expanded; recalc(); } });
    left.appendChild(el('span', { className: 'material-symbols-rounded', style: { fontSize: '18px', color: 'var(--text-muted)' } }, s.expanded ? 'expand_more' : 'chevron_right'));
    
    const info = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } });
    info.appendChild(el('div', { className: 'report-instructor-name' }, s.name));
    info.appendChild(el('div', { className: 'report-instructor-payment' }, formatCurrency(s.amount)));
    left.appendChild(info);
    
    row.appendChild(left);
    const toggle = el('div', {
      className: `toggle ${s.active ? 'active' : ''}`,
      onClick: () => { s.active = !s.active; toggle.classList.toggle('active', s.active); recalc(); }
    });
    row.appendChild(toggle);
    list.appendChild(row);

    if (s.stats && s.expanded) {
      const details = el('div', { className: 'report-summary-grid', style: { padding: '8px 12px', background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border)', fontSize: '0.8rem', marginBottom: '8px' } });
      details.appendChild(el('div', { className: 'report-summary-label' }, t('individualLessons')));
      details.appendChild(el('div', { className: 'report-summary-value' }, `${s.stats.individualCount} (${formatDuration(s.stats.individualDurationMinutes)})`));
      details.appendChild(el('div', { className: 'report-summary-label' }, t('groupLessons')));
      details.appendChild(el('div', { className: 'report-summary-value' }, `${s.stats.groupLessonsCount} (${s.stats.groupParticipants} ${t('groupParticipants')})`));
      details.appendChild(el('div', { className: 'report-summary-label' }, t('customLesson')));
      details.appendChild(el('div', { className: 'report-summary-value' }, `${s.stats.customCount} (${formatDuration(s.stats.customDurationMinutes)})`));
      details.appendChild(el('div', { className: 'report-summary-label' }, t('individualPay')));
      details.appendChild(el('div', { className: 'report-summary-value' }, formatCurrency(s.indPay)));
      details.appendChild(el('div', { className: 'report-summary-label' }, t('groupPay')));
      details.appendChild(el('div', { className: 'report-summary-value' }, formatCurrency(s.grpPay)));
      list.appendChild(details);
    }
  }
  body.appendChild(list);
}

function renderTransactionsList(body, transactions, recalc) {
  const sorted = [...transactions].sort((a, b) => new Date(b.date) - new Date(a.date));
  
  if (sorted.length > 0) {
    const expTotal = sorted.filter(e => e.type !== 'income').reduce((s, e) => s + (e.cost || 0), 0);
    const incTotal = sorted.filter(e => e.type === 'income').reduce((s, e) => s + (e.cost || 0), 0);
    
    const summary = el('div', { className: 'fin-exp-total', style: { display: 'flex', flexDirection: 'column', gap: '4px', marginBottom: '12px' } });
    
    const incRow = el('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '16px', color: 'var(--success)' } });
    incRow.appendChild(el('span', {}, t('incomeTotal') + ':'));
    incRow.appendChild(el('span', { className: 'fin-exp-total-val' }, formatCurrency(incTotal)));
    summary.appendChild(incRow);
    
    const expRow = el('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '16px', color: 'var(--danger)' } });
    expRow.appendChild(el('span', {}, t('expensesTotal') + ':'));
    expRow.appendChild(el('span', { className: 'fin-exp-total-val' }, formatCurrency(expTotal)));
    summary.appendChild(expRow);
    
    body.appendChild(summary);
  }

  const list = el('div', { className: 'expenses-list' });
  sorted.forEach(tran => {
    const isInc = tran.type === 'income';
    const row = el('div', { className: 'fin-exp-row', onClick: () => openTransactionEditModal(tran, recalc) });
    const left = el('div', { className: 'fin-exp-left' });
    left.appendChild(el('div', { className: 'fin-exp-title' }, tran.title || t('untitled')));
    const meta = el('div', { className: 'fin-exp-meta' });
    meta.appendChild(el('span', {}, tran.date));
    meta.appendChild(el('span', { 
      style: { 
        color: isInc ? 'var(--success)' : 'var(--danger)',
        fontSize: '0.75rem',
        fontWeight: '600',
        textTransform: 'uppercase'
      } 
    }, isInc ? t('income') : t('expense')));
    left.appendChild(meta);
    row.appendChild(left);
    row.appendChild(el('div', { 
      className: 'fin-exp-cost', 
      style: { color: isInc ? 'var(--success)' : 'var(--danger)' } 
    }, (isInc ? '+' : '−') + formatCurrency(tran.cost)));
    list.appendChild(row);
  });

  if (sorted.length === 0) {
    list.appendChild(el('div', { className: 'fin-exp-empty' }, t('noTransactionsInRange')));
  }
  body.appendChild(list);
  body.appendChild(el('button', {
    className: 'btn btn-primary btn-sm', style: { width: '100%', marginTop: '12px' },
    onClick: () => openTransactionEditModal(null, recalc)
  }, icon('add'), t('addTransaction')));
}
