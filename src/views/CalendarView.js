import { t } from '../i18n.js';
import { el, icon, formatDate, parseDate, getDaysInMonth, getFirstDayOfMonth, monthName, dayName, isToday, isPast } from '../utils.js';
import { getData, getLessonsForDate, isAdmin, isDateClosed, toggleClosedDate, updateLesson, processPastLessonsForCredits } from '../store.js';
import { render, showToast } from '../main.js';
import { isGroupLessonRecord, getLessonParticipants, getLessonDisplayName } from '../services/LessonService.js';
import { openLessonModal } from '../modals/LessonModal.js';
import { getDayScheduleHours } from './SettingsView.js';

// ── Constants ──────────────────────────────────────────────────────────
const DAY_SCHEDULE_SLOT_HEIGHT = 120;
const MIN_GRID_SCALE = 0.6;
const DAY_SCHEDULE_LABEL_WIDTH = 48;
const DAY_SCHEDULE_CONTENT_RIGHT = 8;

// ── State ──────────────────────────────────────────────────────────────
const now = new Date();
export const calendarState = {
  viewYear: now.getFullYear(),
  viewMonth: now.getMonth(),
  selectedDate: null
};

// ── Settings helper ────────────────────────────────────────────────────
function getSettings() {
  try { return JSON.parse(localStorage.getItem('horsebook_settings')) || {}; } catch { return {}; }
}

function calculateLessonMinHeight(lesson) {
  const padding = 12; // 6px top + 6px bottom
  const titleHeight = 22; // approx height of title row
  if (isGroupLessonRecord(lesson)) {
    const participants = getLessonParticipants(lesson);
    const rowHeight = 18; // approx height per participant row
    return padding + titleHeight + (participants.length * rowHeight) + 4;
  } else {
    return padding + titleHeight + 20; 
  }
}

export function buildMonthView() {
  const container = el('div');
  const header = el('div', { className: 'month-header' },
    el('h2', {}, `${monthName(calendarState.viewMonth)} ${calendarState.viewYear}`),
    el('div', { className: 'month-nav' },
      el('button', { onClick: () => navMonth(-1) }, icon('chevron_left')),
      el('button', { onClick: () => { 
        const now = new Date();
        calendarState.viewYear = now.getFullYear(); 
        calendarState.viewMonth = now.getMonth(); 
        render(); 
      } }, icon('today')),
      el('button', { onClick: () => navMonth(1) }, icon('chevron_right'))
    )
  );
  container.appendChild(header);

  const grid = el('div', { className: 'calendar-grid' });
  for (let i = 0; i < 7; i++) {
    grid.appendChild(el('div', { className: 'calendar-day-label' }, dayName(i)));
  }

  const daysInMonth = getDaysInMonth(calendarState.viewYear, calendarState.viewMonth);
  const firstDay = getFirstDayOfMonth(calendarState.viewYear, calendarState.viewMonth);

  for (let i = 0; i < firstDay; i++) {
    grid.appendChild(el('div', { className: 'calendar-day empty' }));
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = formatDate(new Date(calendarState.viewYear, calendarState.viewMonth, d));
    const lessons = getLessonsForDate(dateStr);
    const closed = isDateClosed(dateStr);
    const classes = ['calendar-day'];
    if (isToday(dateStr)) classes.push('today');
    if (isPast(dateStr)) classes.push('past');
    if (lessons.length > 0) classes.push('has-lessons');
    if (closed) classes.push('closed');

    const dayCell = el('div', {
      className: classes.join(' '),
      onClick: () => {
        if (closed && !isAdmin()) {
          showToast(t('dayClosedToast'), 'lock');
          return;
        }
        calendarState.selectedDate = dateStr;
        render();
      }
    }, String(d));

    if (lessons.length > 0) {
      dayCell.appendChild(el('span', { className: 'lesson-count-badge' }, String(lessons.length)));
    }
    grid.appendChild(dayCell);
  }
  container.appendChild(grid);
  return container;
}

export function navMonth(direction) {
  calendarState.viewMonth += direction;
  if (calendarState.viewMonth < 0) { calendarState.viewMonth = 11; calendarState.viewYear--; }
  if (calendarState.viewMonth > 11) { calendarState.viewMonth = 0; calendarState.viewYear++; }
  render();
}

export function navDay(direction) {
  if (!calendarState.selectedDate) return;
  const d = parseDate(calendarState.selectedDate);
  d.setDate(d.getDate() + direction);
  const newDate = formatDate(d);
  const d2 = parseDate(newDate);
  calendarState.viewMonth = d2.getMonth();
  calendarState.viewYear = d2.getFullYear();
  calendarState.selectedDate = newDate;
  render();
}

export function buildDayView(dateStr) {
  const container = el('div');
  const date = parseDate(dateStr);
  const dayNames = [t('fullDay_0'), t('fullDay_1'), t('fullDay_2'), t('fullDay_3'), t('fullDay_4'), t('fullDay_5'), t('fullDay_6')];
  const closed = isDateClosed(dateStr);

  const headerMain = el('div', { className: 'day-header-main' },
    el('button', { className: 'back-btn', onClick: () => { calendarState.selectedDate = null; render(); } }, icon('arrow_back')),
    el('div', { className: 'day-header-text' },
      el('h2', {}, `${date.getDate()} ${monthName(date.getMonth())} ${date.getFullYear()}`),
      el('span', { className: 'day-subtitle' }, dayNames[date.getDay()])
    )
  );

  const headerActions = el('div', { className: 'day-header-actions' });
  if (isAdmin()) {
    headerActions.appendChild(el('div', {
      className: `toggle toggle-day-status ${closed ? 'active' : ''}`,
      title: closed ? t('markDayOpen') : t('markDayClosed'),
      onClick: () => { toggleClosedDate(dateStr); render(); }
    }, el('span', { className: 'toggle-text' }, closed ? t('closed') : t('open'))));
  } else if (closed) {
    headerActions.appendChild(el('span', { className: `closed-badge active` }, t('closed')));
  } else {
    headerActions.style.display = 'none';
  }

  container.appendChild(el('div', { className: 'day-header' }, headerMain, headerActions));

  const schedule = el('div', { className: 'day-schedule', id: 'day-schedule' });
  const lessons = getLessonsForDate(dateStr);
  const { startHour: START_HOUR, endHour: END_HOUR } = getDayScheduleHours();
  const visibleLessons = lessons.filter(l => (l.startMinute >= START_HOUR * 60 && l.startMinute < END_HOUR * 60));
  const scheduleEndHour = END_HOUR;

  const navHeight = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nav-h')) || 60;
  const viewportHeight = document.documentElement.clientHeight || window.innerHeight || 0;
  const visibleScheduleHours = Math.max(1, scheduleEndHour - START_HOUR);
  const viewportFitScale = viewportHeight > 0
    ? Math.max(MIN_GRID_SCALE, (viewportHeight - navHeight - 24) / (visibleScheduleHours * DAY_SCHEDULE_SLOT_HEIGHT))
    : MIN_GRID_SCALE;

  let dayScale = viewportFitScale;
  for (const l of visibleLessons) {
    const scale = calculateLessonMinHeight(l) / ((l.durationMinutes / 60) * DAY_SCHEDULE_SLOT_HEIGHT);
    if (scale > dayScale) dayScale = scale;
  }
  const slotH = DAY_SCHEDULE_SLOT_HEIGHT * dayScale;
  schedule.style.minHeight = `${(scheduleEndHour - START_HOUR) * slotH}px`;

  for (let h = START_HOUR; h < scheduleEndHour; h++) {
    const row = el('div', { className: 'hour-row' });
    row.appendChild(el('div', { className: 'hour-content' }));
    schedule.appendChild(row);

    const lbl = el('div', { className: 'hour-label' }, `${String(h).padStart(2, '0')}:00`);
    lbl.style.top = `${(h - START_HOUR) * slotH}px`;
    schedule.appendChild(lbl);

    const line = el('div', { className: 'hour-line' });
    line.style.top = `${(h - START_HOUR) * slotH}px`;
    schedule.appendChild(line);

    if (h < scheduleEndHour) {
      const hlbl = el('div', { className: 'hour-label' }, `${String(h).padStart(2, '0')}:30`);
      hlbl.style.top = `${(h - START_HOUR) * slotH + (slotH / 2)}px`;
      schedule.appendChild(hlbl);
      const hline = el('div', { className: 'hour-line half-hour' });
      hline.style.top = `${(h - START_HOUR) * slotH + (slotH / 2)}px`;
      schedule.appendChild(hline);
    }
    [0.25, 0.75].forEach(o => {
      const qline = el('div', { className: 'quarter-line' });
      qline.style.top = `${(h - START_HOUR) * slotH + o * slotH}px`;
      schedule.appendChild(qline);
    });
  }

  const endLine = el('div', { className: 'hour-line terminal-line' });
  endLine.style.top = `${(scheduleEndHour - START_HOUR) * slotH}px`;
  schedule.appendChild(endLine);

  const endLabel = el('div', { className: 'hour-label terminal-label' }, `${String(END_HOUR).padStart(2, '0')}:00`);
  endLabel.style.top = `${(scheduleEndHour - START_HOUR) * slotH}px`;
  schedule.appendChild(endLabel);

  const layout = computeOverlapLayout(visibleLessons);
  for (const l of visibleLessons) {
    schedule.appendChild(buildLessonTile(l, dateStr, START_HOUR, layout.get(l.id), dayScale));
  }
  container.appendChild(schedule);

  const settings = getSettings();
  if (settings.showTimeLine !== false && isToday(dateStr)) {
    const updateTimeLine = () => {
      const existing = schedule.querySelector('.time-indicator');
      if (existing) existing.remove();
      const n = new Date();
      const mins = n.getHours() * 60 + n.getMinutes();
      if (mins < START_HOUR * 60 || mins >= END_HOUR * 60) return;
      const tline = el('div', { className: 'time-indicator' });
      tline.style.top = `${((mins / 60) - START_HOUR) * slotH}px`;
      tline.appendChild(el('div', { className: 'time-indicator-dot' }));
      schedule.appendChild(tline);
    };
    updateTimeLine();
    const tid = setInterval(updateTimeLine, 30000);
    const obs = new MutationObserver(() => { if (!document.contains(schedule)) { clearInterval(tid); obs.disconnect(); } });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  if (isAdmin()) container.appendChild(el('button', { className: 'fab', id: 'fab-add-lesson', onClick: () => openLessonModal(dateStr) }, icon('add')));

  // Swipe logic
  let x = null, y = null;
  container.addEventListener('touchstart', e => { if (e.touches.length === 1 && (!e.target.closest || !e.target.closest('.fab'))) { x = e.touches[0].clientX; y = e.touches[0].clientY; } }, { passive: true });
  container.addEventListener('touchend', e => {
    if (x === null || y === null) return;
    let dx = x - e.changedTouches[0].clientX, dy = Math.abs(y - e.changedTouches[0].clientY);
    if (Math.abs(dx) > 50 && dy < 50) { if (dx > 0) navDay(1); else navDay(-1); }
    x = null; y = null;
  });

  return container;
}

function computeOverlapLayout(lessons) {
  if (lessons.length === 0) return new Map();
  const sorted = [...lessons].sort((a, b) => (a.startMinute !== b.startMinute) ? a.startMinute - b.startMinute : b.durationMinutes - a.durationMinutes);
  const clusters = [];
  let cur = [sorted[0]], end = sorted[0].startMinute + sorted[0].durationMinutes;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startMinute < end) { cur.push(sorted[i]); end = Math.max(end, sorted[i].startMinute + sorted[i].durationMinutes); }
    else { clusters.push(cur); cur = [sorted[i]]; end = sorted[i].startMinute + sorted[i].durationMinutes; }
  }
  clusters.push(cur);
  const map = new Map();
  for (const cluster of clusters) {
    const cols = [];
    for (const l of cluster) {
      let placed = false;
      for (let c = 0; c < cols.length; c++) {
        if (l.startMinute >= (cols[c][cols[c].length - 1].startMinute + cols[c][cols[c].length - 1].durationMinutes)) {
          cols[c].push(l); placed = true; map.set(l.id, { col: c, totalCols: 0 }); break;
        }
      }
      if (!placed) { cols.push([l]); map.set(l.id, { col: cols.length - 1, totalCols: 0 }); }
    }
    for (const l of cluster) map.get(l.id).totalCols = cols.length;
  }
  return map;
}

function buildLessonTile(lesson, dateStr, startHour, pos, dayScale) {
  const isGroup = isGroupLessonRecord(lesson);
  const pkg = isGroup ? null : (getData().packages || []).find(p => p.name.toLowerCase() === (lesson.title || '').toLowerCase());
  const ps = getLessonParticipants(lesson);
  const cancelled = lesson.cancelledDates && lesson.cancelledDates.includes(dateStr);
  const color = lesson?.groupColor || null;
  const lEnd = parseDate(dateStr);
  lEnd.setMinutes(lEnd.getMinutes() + lesson.startMinute + lesson.durationMinutes);
  const past = lEnd < new Date();
  const slotH = DAY_SCHEDULE_SLOT_HEIGHT * dayScale;
  const top = ((lesson.startMinute / 60) - startHour) * slotH;
  const h = Math.max((lesson.durationMinutes / 60) * slotH, 24);
  const col = pos ? pos.col : 0, tot = pos ? pos.totalCols : 1;
  const L = DAY_SCHEDULE_LABEL_WIDTH, R = DAY_SCHEDULE_CONTENT_RIGHT;

  const tile = el('div', {
    className: `lesson-tile ${cancelled || (pkg && !pkg.active) ? 'status-inactive' : 'status-neutral'} ${isGroup ? 'group-session' : ''} ${past ? 'past' : ''} ${cancelled ? 'cancelled' : ''}`.trim(),
    style: {
      top: `${top}px`, height: `${h}px`, right: 'auto', overflow: 'hidden',
      left: tot > 1 ? `calc(${L}px + (100% - ${L + R}px) * ${col} / ${tot})` : `${L}px`,
      width: tot > 1 ? `calc((100% - ${L + R}px) / ${tot} - 2px)` : `calc(100% - ${L + R}px)`,
      borderColor: color ? `${color}66` : undefined,
      background: color ? `linear-gradient(135deg, ${color}26, ${color}0c)` : undefined
    },
    onClick: e => { if (!e.target.closest('.dragging') && isAdmin()) openLessonModal(dateStr, lesson); }
  });
  tile._layoutPos = pos;

  const instr = (getData().instructors || []).find(i => i.name === lesson.instructor);
  const titleRow = el('div', { className: 'tile-title' });
  if (color) titleRow.appendChild(el('span', { className: 'tile-group-dot', style: { background: color } }));
  titleRow.appendChild(el('span', { className: 'tile-title-text' }, getLessonDisplayName(lesson)));
  if (!isGroup && lesson.recurring) titleRow.appendChild(icon('repeat', 'recurring-icon'));
  if (lesson.instructor) titleRow.appendChild(el('span', { className: 'tile-instructor tile-instructor-badge', style: instr?.color ? { color: instr.color } : {} }, icon('person'), lesson.instructor));
  tile.appendChild(titleRow);

  const meta = el('div', { className: 'tile-meta' });
  if (isGroup) {
    const wrap = el('div', { className: 'tile-participants' });
    for (const p of ps) {
      const row = el('div', { className: 'tile-participant' });
      row.appendChild(el('span', { className: 'tile-participant-name' }, p.name));
      if (p.horse) row.appendChild(el('span', { className: 'tile-participant-horse' }, icon('horse'), p.horse));
      const pPkg = p.packageMode !== false ? (getData().packages || []).find(x => x.name.toLowerCase() === (p.packageName || p.name).toLowerCase()) : null;
      if (isAdmin() && pPkg) {
        const c = !pPkg.active ? 'var(--text-muted)' : (pPkg.credits === 0 ? 'var(--text-muted)' : (pPkg.credits > 0 ? 'var(--green)' : 'var(--red)'));
        row.appendChild(el('span', { className: 'tile-participant-package', style: { color: c } }, t('packageLabelShort', { count: pPkg.credits })));
      }
      wrap.appendChild(row);
    }
    meta.appendChild(wrap);
  } else {
    const crew = el('span', { className: 'tile-crew' });
    if (lesson.horse) crew.appendChild(el('span', { className: 'tile-horse' }, icon('horse'), lesson.horse));
    if (lesson.horse) meta.appendChild(crew);
  }
  if (isAdmin() && !isGroup && lesson.packageMode !== false && pkg && pkg.active) {
    const c = pkg.credits === 0 ? 'var(--text-muted)' : (pkg.credits > 0 ? 'var(--green)' : 'var(--red)');
    meta.appendChild(el('span', { style: { color: c } }, t('packageLabel', { count: pkg.credits })));
  }
  tile.appendChild(meta);
  if (cancelled) { tile.style.opacity = '0.6'; tile.style.textDecoration = 'line-through'; }
  if (!cancelled && isAdmin()) makeDraggable(tile, lesson, dateStr, dayScale);
  return tile;
}

function makeDraggable(tileEl, lesson, dateStr, dayScale) {
  const { startHour, endHour } = getDayScheduleHours();
  let sy = 0, sm = lesson.startMinute, drag = false, lp = false, off = 0, lpt = null;
  const onStart = (cy, isT) => { sy = cy; sm = lesson.startMinute; drag = false; lp = !isT; if (isT) lpt = setTimeout(() => { lp = true; tileEl.classList.add('long-press-ready'); if (navigator.vibrate) navigator.vibrate(50); }, 500); };
  const onMove = (cy, isT, e) => {
    const dy = cy - sy;
    if (isT && !lp) { if (Math.abs(dy) > 10) clearTimeout(lpt); return; }
    if (!drag && Math.abs(dy) > 5) { drag = true; if (isT && e) e.preventDefault(); }
    if (!drag) return;
    if (isT && e && e.cancelable) e.preventDefault();
    tileEl.classList.add('dragging'); tileEl.classList.remove('long-press-ready');
    const slotH = DAY_SCHEDULE_SLOT_HEIGHT * dayScale;
    off = Math.round((dy * (60 / slotH)) / 15) * 15;
    const n = Math.max(0, Math.min(sm + off, (endHour - 1) * 60));
    tileEl.style.top = `${((n / 60) - startHour) * slotH}px`;
  };
  const onEnd = () => {
    clearTimeout(lpt); tileEl.classList.remove('long-press-ready');
    if (drag) {
      const snapped = Math.round(Math.max(0, Math.min(sm + off, (endHour - 1) * 60)) / 15) * 15;
      if (snapped !== sm) { updateLesson(lesson.id, { startMinute: snapped }); processPastLessonsForCredits(); render(); }
    }
    tileEl.classList.remove('dragging'); drag = false; lp = false;
  };
  tileEl.addEventListener('mousedown', e => { if (e.button !== 0) return; onStart(e.clientY, false); const mv = e2 => onMove(e2.clientY, false); const up = () => { document.removeEventListener('mouseup', up); document.removeEventListener('mousemove', mv); onEnd(); }; document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up); });
  tileEl.addEventListener('touchstart', e => onStart(e.touches[0].clientY, true), { passive: true });
  tileEl.addEventListener('touchmove', e => onMove(e.touches[0].clientY, true, e), { passive: false });
  tileEl.addEventListener('touchend', onEnd); tileEl.addEventListener('touchcancel', onEnd);
  tileEl.addEventListener('contextmenu', e => { if (lp || drag || ('ontouchstart' in window || navigator.maxTouchPoints > 0)) e.preventDefault(); });
}

export function formatDateNice(dateStr) {
  const d = parseDate(dateStr);
  const dayNames = [t('fullDay_0'), t('fullDay_1'), t('fullDay_2'), t('fullDay_3'), t('fullDay_4'), t('fullDay_5'), t('fullDay_6')];
  return `${dayNames[d.getDay()]}, ${d.getDate()} ${monthName(d.getMonth())}`;
}
