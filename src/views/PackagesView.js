import { t } from '../i18n.js';
import { el, icon, setupModalSwipeToClose } from '../utils.js';
import { getData, isAdmin, deletePackage, ensurePackageEntry, setPackageActive } from '../store.js';
import { render, showToast } from '../main.js';
import { openAddCreditsModal, openCreditHistoryModal } from '../modals/ClientModals.js';

function openPackageTransactionsAuditModal() {
  const data = getData();
  const packageNameById = new Map((data.packages || []).map(pkg => [pkg.id, pkg.name]));
  const transactions = [...(data.packageTransactions || [])].sort((a, b) => new Date(b.date) - new Date(a.date));

  const overlay = el('div', { className: 'modal-overlay' });
  overlay.onclick = (e) => {
    if (e.target === overlay) closeModal();
  };

  const modal = el('div', { className: 'modal', style: { maxWidth: '720px' } });
  const handle = el('div', { className: 'modal-handle' });
  const { closeModal } = setupModalSwipeToClose(modal, overlay, handle, () => overlay.remove());
  modal.appendChild(handle);
  modal.appendChild(el('h3', {}, 'Package Transactions Audit'));
  modal.appendChild(el('p', {
    style: { marginTop: '0', marginBottom: '16px', color: 'var(--text-secondary)' }
  }, `${transactions.length} transaction${transactions.length === 1 ? '' : 's'} loaded from DB`));

  const list = el('div', {
    className: 'history-list',
    style: {
      maxHeight: '65vh',
      overflowY: 'auto',
      paddingRight: '8px',
      background: 'var(--bg-secondary)',
      borderRadius: '12px',
      padding: '8px 12px'
    }
  });

  if (transactions.length === 0) {
    list.appendChild(el('p', {
      style: { color: 'var(--text-secondary)', fontStyle: 'italic', margin: '8px 0' }
    }, 'No package transactions found.'));
  } else {
    for (const tx of transactions) {
      const packageName = packageNameById.get(tx.packageId) || tx.packageId || 'Unknown package';
      const row = el('div', {
        style: {
          display: 'flex',
          justifyContent: 'space-between',
          gap: '12px',
          padding: '12px 0',
          borderBottom: '1px solid var(--border-color)'
        }
      });

      const left = el('div', { style: { minWidth: '0', flex: '1 1 auto' } });
      left.appendChild(el('div', { style: { fontWeight: '700' } }, packageName));
      left.appendChild(el('div', {
        style: { fontSize: '0.8rem', color: 'var(--text-secondary)', wordBreak: 'break-word' }
      }, `${tx.type} | ${new Date(tx.date).toLocaleString()}${tx.lessonDate ? ` | lesson ${tx.lessonDate}${tx.lessonStartMinute !== null && tx.lessonStartMinute !== undefined ? ` @ ${String(Math.floor(tx.lessonStartMinute / 60)).padStart(2, '0')}:${String(tx.lessonStartMinute % 60).padStart(2, '0')}` : ''}` : ''}`));
      left.appendChild(el('div', {
        style: { fontSize: '0.75rem', color: 'var(--text-muted)', wordBreak: 'break-word' }
      }, `source_key: ${tx.sourceKey || 'none'}`));
      if (tx.note) {
        left.appendChild(el('div', {
          style: { fontSize: '0.75rem', color: 'var(--text-secondary)', wordBreak: 'break-word' }
        }, tx.note));
      }

      const right = el('div', {
        style: {
          fontWeight: '700',
          fontSize: '1rem',
          color: Number(tx.amount) > 0 ? 'var(--green)' : 'var(--red)',
          flex: '0 0 auto',
          alignSelf: 'center'
        }
      }, `${Number(tx.amount) > 0 ? '+' : ''}${tx.amount}`);

      row.appendChild(left);
      row.appendChild(right);
      list.appendChild(row);
    }

    if (list.lastChild) {
      list.lastChild.style.borderBottom = 'none';
    }
  }

  modal.appendChild(list);

  const btnRow = el('div', { className: 'btn-group modal-actions', style: { marginTop: '16px' } });
  btnRow.appendChild(el('button', {
    className: 'btn btn-secondary',
    onClick: () => closeModal()
  }, t('close') || 'Close'));
  modal.appendChild(btnRow);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

function buildPackageCard(pkg) {
  const card = el('div', {
    className: `package-card ${pkg.active === false ? 'inactive' : ''}`.trim(),
    style: { cursor: 'pointer' },
    'data-name': pkg.name.toLowerCase(),
    onClick: () => openCreditHistoryModal(pkg)
  });

  const info = el('div', { className: 'package-info' });
  info.appendChild(el('div', { className: 'package-name' }, pkg.name));
  if (!pkg.hasPackageLessons) {
    info.appendChild(el('div', { className: 'package-status' }, t('noPackageLessons')));
  }
  card.appendChild(info);

  const credits = el('div', { className: 'package-credits', style: { display: 'flex', gap: '8px', alignItems: 'center' } });
  const creditClass = pkg.credits > 0 ? 'positive' : pkg.credits < 0 ? 'negative' : 'zero';
  const badge = el('div', {
    className: `credit-badge ${creditClass}`,
    onClick: (e) => e.stopPropagation()
  }, String(pkg.credits));
  credits.appendChild(badge);

  if (isAdmin()) {
    credits.appendChild(el('button', {
      className: 'btn btn-primary btn-sm',
      title: t('addCredits'),
      'aria-label': t('addCredits'),
      onClick: (e) => {
        e.stopPropagation();
        openAddCreditsModal(pkg);
      }
    }, icon('add')));
  }

  card.appendChild(credits);

  if (isAdmin()) {
    const actions = el('div', { className: 'package-actions' });
    actions.appendChild(el('button', {
      className: 'package-action-btn',
      title: t('deleteClient'),
      onClick: (e) => {
        e.stopPropagation();
        const overlay = el('div', { className: 'modal-overlay' });
        const dialog = el('div', { className: 'modal', style: { maxWidth: '300px', margin: 'auto' } });
        dialog.appendChild(el('h3', { style: { marginTop: '10px' } }, t('deletePackageTitle')));
        dialog.appendChild(el('p', { style: { marginBottom: '20px', color: 'var(--text-secondary)' } }, t('deletePackageConfirm', { name: pkg.name })));

        const btnRow = el('div', { className: 'btn-group' });
        btnRow.appendChild(el('button', {
          className: 'btn btn-secondary',
          onClick: () => overlay.remove()
        }, t('cancel')));
        btnRow.appendChild(el('button', {
          className: 'btn btn-danger',
          style: { marginLeft: 'auto' },
          onClick: () => {
            deletePackage(pkg.id);
            overlay.remove();
            showToast(t('packageDeleted'), 'delete');
            render();
          }
        }, icon('delete'), t('deleteKey')));

        dialog.appendChild(btnRow);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
      }
    }, icon('delete')));
    card.appendChild(actions);
  }

  return card;
}

function buildPackageSection(title, packages, emptyText) {
  const section = el('div', { className: 'package-section' });
  section.appendChild(el('div', { className: 'package-section-header' },
    el('h3', {}, title),
    el('span', { className: 'package-section-count' }, String(packages.length))
  ));

  const list = el('div', { className: 'package-list' });
  if (packages.length === 0) {
    list.appendChild(el('div', { className: 'package-section-empty' }, emptyText));
  } else {
    for (const pkg of packages) {
      list.appendChild(buildPackageCard(pkg));
    }
  }

  section.appendChild(list);
  return section;
}

export function buildPackagesView() {
  const container = el('div');
  const data = getData();

  const searchBar = el('div', { className: 'search-bar' });
  searchBar.appendChild(icon('search'));
  const searchInput = el('input', {
    className: 'form-input',
    type: 'text',
    placeholder: t('searchClients'),
    id: 'package-search-input',
    onInput: (e) => {
      const q = e.target.value.toLowerCase();
      container.querySelectorAll('.package-card').forEach(card => {
        const name = card.dataset.name;
        card.style.display = name.includes(q) ? '' : 'none';
      });
    }
  });
  searchBar.appendChild(searchInput);
  container.appendChild(searchBar);

  if (isAdmin()) {
    const addRow = el('div', { className: 'add-item-row', style: { marginBottom: '16px' } });
    const addInput = el('input', {
      className: 'form-input',
      type: 'text',
      placeholder: t('addClientName'),
      id: 'add-package-input'
    });
    addRow.appendChild(addInput);
    addRow.appendChild(el('button', {
      className: 'btn btn-primary btn-sm',
      onClick: () => {
        const name = addInput.value.trim();
        if (!name) return;
        const d = getData();
        const exists = d.packages.find(p => p.name.toLowerCase() === name.toLowerCase());
        if (exists) {
          if (exists.active === false) {
            setPackageActive(exists.id, true);
            showToast(t('clientRestored') || 'Client restored', 'restore');
            render();
          } else {
            showToast(t('clientAlreadyExists'), 'warning');
          }
          return;
        }
        ensurePackageEntry(name, { save: true, hasPackageLessons: false });
        render();
      }
    }, icon('add'), t('add')));
    container.appendChild(addRow);
  }

  const sorted = [...(data.packages || [])].sort((a, b) => a.name.localeCompare(b.name));
  const packageClients = sorted.filter(pkg => pkg.hasPackageLessons && pkg.active !== false);
  const noPackageClients = sorted.filter(pkg => !pkg.hasPackageLessons && pkg.active !== false);
  const archivedClients = sorted.filter(pkg => pkg.active === false);

  container.appendChild(buildPackageSection(t('packageClients'), packageClients, t('noPackageClientsYet')));
  container.appendChild(buildPackageSection(t('noPackageLessons'), noPackageClients, t('noPackageLessonsYet')));
  container.appendChild(buildPackageSection(t('archivedClients') || 'Archived', archivedClients, t('noArchivedClientsYet') || 'No archived clients yet.'));

  if (isAdmin()) {
    container.appendChild(el('button', {
      className: 'btn btn-secondary',
      style: { width: '100%', marginTop: '20px', marginBottom: '8px' },
      onClick: () => openPackageTransactionsAuditModal()
    }, icon('receipt_long'), 'Package Transactions Audit'));
  }

  return container;
}
