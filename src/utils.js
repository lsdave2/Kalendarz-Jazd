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
  span.className = `material-symbols-rounded ${extraClass}`.trim();
  span.textContent = name;
  return span;
}
