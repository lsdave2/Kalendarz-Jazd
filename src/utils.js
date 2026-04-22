import { t } from './i18n.js';

// ── Date Utilities ─────────────────────────────────────────────────────

export function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function parseDate(str) {
  const [y, m, d] = str.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function getWeekRange() {
  const now = new Date();
  const day = now.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday);
  return getDatesInRange(formatDate(monday), formatDate(new Date(monday.getTime() + 6 * 24 * 60 * 60 * 1000)));
}

export function getDatesInRange(fromStr, toStr) {
  const start = parseDate(fromStr);
  const end = parseDate(toStr);
  if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime())) return [];
  
  start.setHours(0,0,0,0);
  end.setHours(0,0,0,0);
  
  const dates = [];
  let curr = new Date(start);

  // Safety cap to prevent infinite loops (max 1 year range)
  let safety = 0;
  while (curr <= end && safety < 366) {
    dates.push(formatDate(curr));
    curr.setDate(curr.getDate() + 1);
    safety++;
  }
  return dates;
}

export function getDaysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

export function getFirstDayOfMonth(year, month) {
  // 0=Sunday, adjust to Monday start
  const day = new Date(year, month, 1).getDay();
  return day === 0 ? 6 : day - 1;
}

export function monthName(month) {
  return t(`month_${month}`);
}

export function dayName(dayIdx) {
  return t(`day_${dayIdx}`);
}

export function minutesToTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function isToday(dateStr) {
  return dateStr === formatDate(new Date());
}

export function isPast(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return parseDate(dateStr) < today;
}

// ── DOM Helpers ────────────────────────────────────────────────────────

export function el(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, val] of Object.entries(attrs)) {
    if (key === 'className') element.className = val;
    else if (key === 'style' && typeof val === 'object') {
      Object.assign(element.style, val);
    } else if (key.startsWith('on')) {
      element.addEventListener(key.slice(2).toLowerCase(), val);
    } else {
      element.setAttribute(key, val);
    }
  }
  for (const child of children) {
    if (typeof child === 'string') element.appendChild(document.createTextNode(child));
    else if (child) element.appendChild(child);
  }
  return element;
}

export function icon(name, extraClass = '') {
  const span = document.createElement('span');
  
  if (name === 'horse' || name === 'horseshoe') {
    span.className = `horse-icon ${extraClass}`.trim();
    return span;
  }

  span.className = `material-symbols-rounded ${extraClass}`.trim();
  span.textContent = name;
  return span;
}

export function setupModalSwipeToClose(modal, overlay, handle, onClosed) {
  let isClosing = false;
  let dragStartY = 0;
  let dragCurrentY = 0;
  let isDragging = false;

  const closeModal = () => {
    if (isClosing) return;
    isClosing = true;
    overlay.classList.add('closing');
    setTimeout(() => {
      onClosed();
      window.removeEventListener('mousemove', onDragMove);
      window.removeEventListener('touchmove', onDragMove);
      window.removeEventListener('mouseup', onDragEnd);
      window.removeEventListener('touchend', onDragEnd);
    }, 200);
  };

  const onDragStart = (e) => {
    dragStartY = (e.touches ? e.touches[0].pageY : e.pageY);
    isDragging = true;
    modal.style.transition = 'none';
  };

  const onDragMove = (e) => {
    if (!isDragging) return;
    dragCurrentY = (e.touches ? e.touches[0].pageY : e.pageY);
    const diffY = dragCurrentY - dragStartY;
    if (diffY > 0) {
      modal.style.transform = `translateY(${diffY}px)`;
      modal.style.setProperty('--drag-y', `${diffY}px`);
    }
  };

  const onDragEnd = () => {
    if (!isDragging) return;
    isDragging = false;
    const diffY = dragCurrentY - dragStartY;
    if (diffY > 100) {
      closeModal();
    } else {
      modal.style.transition = 'transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
      modal.style.transform = 'translateY(0)';
      modal.style.setProperty('--drag-y', '0px');
    }
  };

  handle.addEventListener('mousedown', onDragStart);
  handle.addEventListener('touchstart', onDragStart, { passive: true });
  window.addEventListener('mousemove', onDragMove);
  window.addEventListener('touchmove', onDragMove, { passive: false });
  window.addEventListener('mouseup', onDragEnd);
  window.addEventListener('touchend', onDragEnd);

  return { closeModal, isDragging: () => isDragging };
}
