import { t } from '../i18n.js';
import { el, icon } from '../utils.js';
import { getData, saveData, isAdmin, deletePackage, ensurePackageEntry, setPackageActive } from '../store.js';
import { render, showToast } from '../main.js';
import { openAddCreditsModal, openCreditHistoryModal } from '../modals/ClientModals.js';

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
        ensurePackageEntry(name, { save: false, hasPackageLessons: false });
        saveData();
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

  return container;
}
