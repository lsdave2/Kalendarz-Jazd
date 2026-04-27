import { t } from '../i18n.js';
import { el, icon, formatDate, minutesToTime, setupModalSwipeToClose } from '../utils.js';
import { updatePackageName, addPackageCredits, getLessonsForDate, getData, setPackageActive, updatePackageCustomPaymentRate } from '../store.js';
import { render, showToast } from '../main.js';
import { isGroupLessonRecord } from '../services/LessonService.js';
import { formatDateNice } from '../views/CalendarView.js';

export function openEditClientModal(pkg, { onSaved } = {}) {
  const overlay = el('div', { className: 'modal-overlay' });
  overlay.onclick = (e) => {
    if (e.target === overlay) closeModal();
  };

  const modal = el('div', { className: 'modal', style: { maxWidth: '300px', margin: 'auto' } });
  const handle = el('div', { className: 'modal-handle' });
  const { closeModal } = setupModalSwipeToClose(modal, overlay, handle, () => overlay.remove());
  modal.appendChild(handle);
  modal.appendChild(el('h3', {}, t('editClient') || 'Edit Client Name'));

  const inputWrapper = el('div', { className: 'form-group' });
  const input = el('input', {
    className: 'form-input',
    type: 'text',
    value: pkg.name,
    style: { fontSize: '1rem', padding: '12px' }
  });
  inputWrapper.appendChild(input);
  modal.appendChild(inputWrapper);

  const btnRow = el('div', { className: 'btn-group modal-actions' });
  btnRow.appendChild(el('button', {
    className: 'btn btn-secondary',
    onClick: () => closeModal()
  }, t('cancel')));
  
  btnRow.appendChild(el('button', {
    className: 'btn btn-primary',
    style: { marginLeft: 'auto' },
    onClick: () => {
      const newName = input.value.trim();
      if (newName) {
        const success = updatePackageName(pkg.id, newName);
        if (success) {
           showToast(t('clientUpdated') || 'Client name updated', 'check_circle');
           if (typeof onSaved === 'function') onSaved(newName);
           render();
        } else {
           showToast(t('clientAlreadyExists') || 'Name already exists', 'warning');
        }
      }
      closeModal();
    }
  }, icon('check'), t('saveKey') || 'Save'));
  
  modal.appendChild(btnRow);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  setTimeout(() => {
    input.focus();
    input.select();
  }, 10);
}

export function openAddCreditsModal(pkg) {
  const overlay = el('div', { className: 'modal-overlay' });
  overlay.onclick = (e) => {
    if (e.target === overlay) closeModal();
  };

  const modal = el('div', { className: 'modal', style: { maxWidth: '300px', margin: 'auto' } });
  const handle = el('div', { className: 'modal-handle' });
  const { closeModal } = setupModalSwipeToClose(modal, overlay, handle, () => overlay.remove());
  modal.appendChild(handle);
  modal.appendChild(el('h3', {}, t('addCredits')));
  modal.appendChild(el('p', { style: { marginBottom: '16px', color: 'var(--text-secondary)' } }, t('creditsToAdd')));

  const inputWrapper = el('div', { className: 'form-group' });
  const input = el('input', {
    className: 'form-input',
    type: 'number',
    value: '4',
    style: { fontSize: '1.2rem', padding: '12px', textAlign: 'center' }
  });
  inputWrapper.appendChild(input);
  modal.appendChild(inputWrapper);

  const btnRow = el('div', { className: 'btn-group modal-actions' });
  btnRow.appendChild(el('button', {
    className: 'btn btn-secondary',
    onClick: () => closeModal()
  }, t('cancel')));
  
  btnRow.appendChild(el('button', {
    className: 'btn btn-primary',
    style: { marginLeft: 'auto' },
    onClick: () => {
      const val = parseInt(input.value);
      if (!isNaN(val) && val !== 0) {
        addPackageCredits(pkg.id, val);
        render();
      }
      closeModal();
    }
  }, icon('add'), t('addCredits')));
  
  modal.appendChild(btnRow);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  setTimeout(() => {
    input.focus();
    input.select();
  }, 10);
}

export function openCreditHistoryModal(pkg) {
  const overlay = el('div', { className: 'modal-overlay' });
  overlay.onclick = (e) => {
    if (e.target === overlay) closeModal();
  };

  const modal = el('div', { className: 'modal' });
  const handle = el('div', { className: 'modal-handle' });
  const { closeModal } = setupModalSwipeToClose(modal, overlay, handle, () => overlay.remove());
  modal.appendChild(handle);
  const title = el('h3', {}, `${pkg.name} - ${t('creditHistory')}`);
  modal.appendChild(title);

  const statusRow = el('div', {
    className: 'client-modal-status',
    style: { marginBottom: '12px' }
  }, pkg.active === false ? t('archived') : t('active'));
  modal.appendChild(statusRow);

  const actionRow = el('div', { className: 'client-modal-actions' });
  actionRow.appendChild(el('button', {
    className: 'btn btn-secondary btn-sm',
    onClick: () => {
      openEditClientModal(pkg, {
        onSaved: (newName) => {
          title.textContent = `${newName} - ${t('creditHistory')}`;
        }
      });
    }
  }, icon('edit'), t('editClient') || 'Edit Client Name'));

  actionRow.appendChild(el('button', {
    className: 'btn btn-secondary btn-sm',
    onClick: () => {
      const nextActive = pkg.active === false;
      setPackageActive(pkg.id, nextActive);
      showToast(nextActive ? (t('clientRestored') || 'Client restored') : (t('clientArchived') || 'Client archived'), nextActive ? 'restore' : 'archive');
      render();
      closeModal();
    }
  }, icon(pkg.active === false ? 'restore' : 'archive'), pkg.active === false ? (t('restoreClient') || 'Restore client') : (t('archiveClient') || 'Archive client')));
  modal.appendChild(actionRow);

  const customRateValue = Number.isFinite(Number(pkg.customPaymentRate)) ? String(pkg.customPaymentRate) : '';
  const rateGroup = el('div', { className: 'form-group', style: { marginTop: '12px' } });
  rateGroup.appendChild(el('label', {}, t('customPaymentRate')));
  const rateInput = el('input', {
    className: 'form-input',
    type: 'number',
    min: '0',
    step: '0.01',
    placeholder: '140',
    value: customRateValue
  });
  rateGroup.appendChild(rateInput);
  modal.appendChild(rateGroup);

  const rateHint = el('p', {
    style: {
      marginTop: '8px',
      marginBottom: '0',
      color: 'var(--text-secondary)',
      fontSize: '0.8rem'
    }
  }, t('customPaymentRateHint'));
  modal.appendChild(rateHint);

  const historyList = el('div', { className: 'history-list', style: { marginTop: '16px', maxHeight: '60vh', overflowY: 'auto' } });

  const history = pkg.history || [];
  if (history.length === 0) {
    historyList.appendChild(el('p', { style: { color: 'var(--text-secondary)', fontStyle: 'italic' } }, t('noHistory')));
  } else {
    // Sort descending by date
    const filteredHistory = history.filter(record => {
      // If it's not a lesson record (manual add/deduct), show it
      if (!record.lessonDate || (record.reason !== 'lesson' && record.reason !== 'lesson_cancel')) return true;
      
      // If it's a lesson record, check if a matching lesson exists in the calendar
      const lessonsOnDay = getLessonsForDate(record.lessonDate);
      return lessonsOnDay.some(l => {
        // Match by lessonId if available
        if (record.lessonId && l.id === record.lessonId) return true;
        
        // Match by title/participants and start time
        const isSameTime = l.startMinute === record.lessonStartMinute;
        if (!isSameTime) return false;
        
        // Match individual lesson title
        if (!isGroupLessonRecord(l)) {
          return (l.title || '').toLowerCase() === pkg.name.toLowerCase();
        }
        
        // Match group lesson participants
        return l.participants.some(p => (p.packageName || p.name).toLowerCase() === pkg.name.toLowerCase());
      });
    });

    // Sort descending by date
    const sortedHistory = [...filteredHistory].sort((a, b) => new Date(b.date) - new Date(a.date));
    
    for (const record of sortedHistory) {
      const row = el('div', { 
        style: { 
          display: 'flex', 
          justifyContent: 'space-between', 
          padding: '12px 0', 
          borderBottom: '1px solid var(--border-color)' 
        } 
      });
      
      const d = new Date(record.date);
      const dateStr = `${formatDate(d)} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
      
      const leftObj = el('div');
      leftObj.appendChild(el('div', { style: { fontWeight: '600' } }, dateStr));
      const textStyle = { fontSize: '0.8rem', color: 'var(--text-secondary)' };
      
      let desc = '';
      if (record.lessonDate && (record.reason === 'lesson' || record.reason === 'lesson_cancel' || record.reason === 'manual_deduct')) {
        let timeStr = '';
        if (record.lessonStartMinute !== undefined) {
          timeStr = ` ${minutesToTime(record.lessonStartMinute)}`;
        }
        desc = ` (${t('lessonOn')} ${formatDateNice(record.lessonDate)}${timeStr})`;
      }      leftObj.appendChild(el('div', { style: textStyle }, `${t('before')}: ${record.before} → ${t('after')}: ${record.after}${desc}`));
      
      const rightObj = el('div', { 
        style: { 
          fontWeight: '700', 
          fontSize: '1.1rem',
          color: record.amount > 0 ? 'var(--green)' : 'var(--red)'
        } 
      });
      rightObj.textContent = (record.amount > 0 ? '+' : '') + record.amount;
      
      row.appendChild(leftObj);
      row.appendChild(rightObj);
      historyList.appendChild(row);
    }
  }

  modal.appendChild(historyList);
  
  const btnRow = el('div', { className: 'btn-group modal-actions', style: { marginTop: '16px' } });
  btnRow.appendChild(el('button', {
    className: 'btn btn-secondary',
    onClick: () => closeModal()
  }, t('close')));
  btnRow.appendChild(el('button', {
    className: 'btn btn-primary',
    style: { marginLeft: 'auto' },
    onClick: () => {
      const raw = rateInput.value.trim();
      const nextValue = raw === '' ? null : Number.parseFloat(raw);
      if (updatePackageCustomPaymentRate(pkg.id, Number.isFinite(nextValue) ? nextValue : null)) {
        showToast(t('customPaymentRateSaved'), 'check_circle');
        render();
      }
      closeModal();
    }
  }, icon('check'), t('saveKey')));
  modal.appendChild(btnRow);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}
