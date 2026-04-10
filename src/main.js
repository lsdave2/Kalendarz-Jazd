import './style.css';
import { t, setLang, getLang } from './i18n.js';
import { el, icon, formatDate, parseDate, getDaysInMonth, getFirstDayOfMonth, monthName, dayName, minutesToTime, isToday, isPast, getWeekRange, getDatesInRange } from './utils.js';
import {
  loadData, getData, saveData, subscribe,
  addLesson, updateLesson, deleteLesson, getLessonsForDate,
  updateLessonInstance,
  updatePackageCredits, togglePackageActive, deletePackage, getPackageByName, deductCredit, ensurePackageEntry, addPackageCredits,
  createGroup, getGroup, deleteGroup, getAllGroups, toggleCancelLessonInstance, processPastLessonsForCredits,
  updateGroup,
  isAdmin, login, logout, isLoading,
  isDateClosed, toggleClosedDate
} from './store.js';

// ── State ──────────────────────────────────────────────────────────────
let currentTab = 'calendar';
let viewYear, viewMonth;
let selectedDate = null;
let editingLesson = null;
let horseViewRange = null; // { from, to }

const DEFAULT_DAY_SCHEDULE_START_HOUR = 8;
const DEFAULT_DAY_SCHEDULE_END_HOUR = 21;
const DAY_SCHEDULE_SLOT_HEIGHT = 120;
const DAY_SCHEDULE_LABEL_WIDTH = 48;
const DAY_SCHEDULE_CONTENT_RIGHT = 8;

function isTabVisible(tabId) {
  if (tabId === 'packages') return isAdmin();
  if (tabId === 'horses') return isAdmin();
  return true;
}

function ensureVisibleTab() {
  if (!isTabVisible(currentTab)) {
    currentTab = 'calendar';
    selectedDate = null;
  }
}

// Init date
const now = new Date();
viewYear = now.getFullYear();
viewMonth = now.getMonth();

loadData();

// ── App Settings ───────────────────────────────────────────────────────
const SETTINGS_KEY = 'horsebook_settings';
function getSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}
function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function clampHour(value, min, max, fallback) {
  const hour = Number.parseInt(value, 10);
  if (Number.isNaN(hour)) return fallback;
  return Math.max(min, Math.min(max, hour));
}

function getDayScheduleHours() {
  let startHour = clampHour(getSettings().dayScheduleStartHour, 0, 23, DEFAULT_DAY_SCHEDULE_START_HOUR);
  let endHour = clampHour(getSettings().dayScheduleEndHour, 1, 24, DEFAULT_DAY_SCHEDULE_END_HOUR);

  if (endHour <= startHour) {
    if (startHour >= 23) {
      startHour = 22;
      endHour = 23;
    } else {
      endHour = startHour + 1;
    }
  }

  return { startHour, endHour };
}

function formatHourOption(hour) {
  return `${String(hour).padStart(2, '0')}:00`;
}

// ── Render Engine ──────────────────────────────────────────────────────
const app = document.getElementById('app');

function render() {
  ensureVisibleTab();
  document.title = t('appTitle');
  app.innerHTML = '';
  if (!(currentTab === 'calendar' && selectedDate)) {
    app.appendChild(buildHeader());
  }

  const page = el('div', { className: 'page' });

  switch (currentTab) {
    case 'calendar':
      if (selectedDate) {
        page.appendChild(buildDayView(selectedDate));
      } else {
        page.appendChild(buildMonthView());
      }
      break;
    case 'packages':
      page.appendChild(buildPackagesView());
      break;
    case 'horses':
      page.appendChild(buildHorsesView());
      break;
    case 'settings':
      page.appendChild(buildSettingsView());
      break;
  }

  app.appendChild(page);
  app.appendChild(buildBottomNav());
}

// ── Header ─────────────────────────────────────────────────────────────
function buildHeader() {
  const titleText = currentTab === 'calendar'
    ? (selectedDate ? formatDateNice(selectedDate) : t('appTitle'))
    : currentTab === 'packages' ? t('packages') : currentTab === 'horses' ? t('horsesTab') : t('settings');

  const header = el('header', { className: 'app-header' },
    el('h1', {},
      icon('calendar_month'),
      titleText
    )
  );

  if (selectedDate) {
    const todayBtn = el('button', {
      className: 'header-btn',
      onClick: () => { selectedDate = null; render(); },
      title: t('backToCalendar')
    }, icon('calendar_today'));
    header.querySelector('h1').prepend(todayBtn);
  }

  return header;
}

function formatDateNice(dateStr) {
  const d = parseDate(dateStr);
  const dayNames = [t('fullDay_0'), t('fullDay_1'), t('fullDay_2'), t('fullDay_3'), t('fullDay_4'), t('fullDay_5'), t('fullDay_6')];
  return `${dayNames[d.getDay()]}, ${d.getDate()} ${monthName(d.getMonth())}`;
}

// ── Month View ─────────────────────────────────────────────────────────
function buildMonthView() {
  const container = el('div');

  // Header with nav
  const header = el('div', { className: 'month-header' },
    el('h2', {}, `${monthName(viewMonth)} ${viewYear}`),
    el('div', { className: 'month-nav' },
      el('button', { onClick: () => navMonth(-1) }, icon('chevron_left')),
      el('button', { onClick: () => { viewYear = now.getFullYear(); viewMonth = now.getMonth(); render(); } }, icon('today')),
      el('button', { onClick: () => navMonth(1) }, icon('chevron_right'))
    )
  );
  container.appendChild(header);

  // Grid
  const grid = el('div', { className: 'calendar-grid' });

  // Day labels
  for (let i = 0; i < 7; i++) {
    grid.appendChild(el('div', { className: 'calendar-day-label' }, dayName(i)));
  }

  // Cells
  const daysInMonth = getDaysInMonth(viewYear, viewMonth);
  const firstDay = getFirstDayOfMonth(viewYear, viewMonth);

  // Empty cells before first day
  for (let i = 0; i < firstDay; i++) {
    grid.appendChild(el('div', { className: 'calendar-day empty' }));
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = formatDate(new Date(viewYear, viewMonth, d));
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
        selectedDate = dateStr;
        render();
      }
    }, String(d));

    if (lessons.length > 0) {
      const badge = el('span', { className: 'lesson-count-badge' }, String(lessons.length));
      dayCell.appendChild(badge);
    }

    grid.appendChild(dayCell);
  }

  container.appendChild(grid);
  return container;
}

function navMonth(direction) {
  viewMonth += direction;
  if (viewMonth < 0) { viewMonth = 11; viewYear--; }
  if (viewMonth > 11) { viewMonth = 0; viewYear++; }
  render();
}

// ── Day View ───────────────────────────────────────────────────────────
function buildDayView(dateStr) {
  const container = el('div');
  const date = parseDate(dateStr);
  const dayNames = [t('fullDay_0'), t('fullDay_1'), t('fullDay_2'), t('fullDay_3'), t('fullDay_4'), t('fullDay_5'), t('fullDay_6')];
  const closed = isDateClosed(dateStr);

  // Header
  const headerMain = el('div', { className: 'day-header-main' },
    el('button', { className: 'back-btn', onClick: () => { selectedDate = null; render(); } },
      icon('arrow_back')
    ),
    el('div', { className: 'day-header-text' },
      el('h2', {}, `${date.getDate()} ${monthName(date.getMonth())} ${date.getFullYear()}`),
      el('span', { className: 'day-subtitle' }, dayNames[date.getDay()])
    )
  );

  const headerActions = el('div', { className: 'day-header-actions' });
  const closedBadge = el('span', {
    className: `closed-badge ${closed ? 'active' : ''}`
  }, t('closed'));
  headerActions.appendChild(closedBadge);

  if (isAdmin()) {
    const closedToggle = el('div', {
      className: `toggle ${closed ? 'active' : ''}`,
      title: closed ? t('markDayOpen') : t('markDayClosed'),
      onClick: () => {
        toggleClosedDate(dateStr);
        render();
      }
    });
    headerActions.appendChild(closedToggle);
  } else if (!closed) {
    headerActions.style.display = 'none';
  }

  const header = el('div', { className: 'day-header' }, headerMain, headerActions);
  container.appendChild(header);

  // Schedule
  const schedule = el('div', { className: 'day-schedule', id: 'day-schedule' });
  const lessons = getLessonsForDate(dateStr);

  const { startHour: START_HOUR, endHour: END_HOUR } = getDayScheduleHours();
  const visibleLessons = lessons.filter(lesson => (
    lesson.startMinute >= START_HOUR * 60 &&
    lesson.startMinute < (END_HOUR + 1) * 60
  ));
  schedule.style.minHeight = `${(END_HOUR - START_HOUR + 1) * DAY_SCHEDULE_SLOT_HEIGHT}px`;

  for (let h = START_HOUR; h <= END_HOUR; h++) {
    const row = el('div', { className: 'hour-row' });
    row.appendChild(el('div', { className: 'hour-label' }, `${String(h).padStart(2, '0')}:00`));
    row.appendChild(el('div', { className: 'hour-content' }));
    schedule.appendChild(row);

    const hourLine = el('div', { className: 'hour-line' });
    hourLine.style.top = `${(h - START_HOUR) * DAY_SCHEDULE_SLOT_HEIGHT}px`;
    schedule.appendChild(hourLine);

    // Quarter lines
    for (let q = 1; q <= 3; q++) {
      const line = el('div', { className: 'quarter-line' });
      line.style.top = `${(h - START_HOUR) * DAY_SCHEDULE_SLOT_HEIGHT + q * (DAY_SCHEDULE_SLOT_HEIGHT / 4)}px`;
      schedule.appendChild(line);
    }
  }

  // Compute layout for overlapping tiles
  const layout = computeOverlapLayout(visibleLessons);

  // Render group containers first (behind tiles)
  const groupContainers = buildGroupContainers(visibleLessons, layout, START_HOUR);
  for (const gc of groupContainers) {
    schedule.appendChild(gc);
  }

  // Place lesson tiles with computed positions
  for (const lesson of visibleLessons) {
    const pos = layout.get(lesson.id);
    const tile = buildLessonTile(lesson, dateStr, START_HOUR, pos);
    schedule.appendChild(tile);
  }

  container.appendChild(schedule);

  // Current time indicator (only on today's view)
  const settings = getSettings();
  if (settings.showTimeLine !== false && isToday(dateStr)) {
    const updateTimeLine = () => {
      const existing = schedule.querySelector('.time-indicator');
      if (existing) existing.remove();

      const now = new Date();
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      if (nowMinutes < START_HOUR * 60 || nowMinutes > END_HOUR * 60) return;

      const top = ((nowMinutes / 60) - START_HOUR) * DAY_SCHEDULE_SLOT_HEIGHT;
      const line = el('div', { className: 'time-indicator' });
      line.style.top = `${top}px`;

      const dot = el('div', { className: 'time-indicator-dot' });
      line.appendChild(dot);
      schedule.appendChild(line);
    };

    updateTimeLine();
    const timerId = setInterval(updateTimeLine, 30000);
    // Clean up when day view is replaced
    const obs = new MutationObserver(() => {
      if (!document.contains(schedule)) {
        clearInterval(timerId);
        obs.disconnect();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // FAB to add lesson
  if (isAdmin()) {
    const fab = el('button', {
      className: 'fab',
      id: 'fab-add-lesson',
      onClick: () => openLessonModal(dateStr)
    }, icon('add'));
    container.appendChild(fab);
  }

  return container;
}

// ── Overlap Layout Algorithm ───────────────────────────────────────────
// Assigns each lesson a column index and total column count so tiles
// can be placed side-by-side when they overlap in time.
function computeOverlapLayout(lessons) {
  if (lessons.length === 0) return new Map();

  // Sort by start time, then by duration (longer first)
  const sorted = [...lessons].sort((a, b) => {
    if (a.startMinute !== b.startMinute) return a.startMinute - b.startMinute;
    return b.durationMinutes - a.durationMinutes;
  });

  // Build overlap clusters: groups of lessons that mutually overlap
  const clusters = [];
  let currentCluster = [sorted[0]];
  let clusterEnd = sorted[0].startMinute + sorted[0].durationMinutes;

  for (let i = 1; i < sorted.length; i++) {
    const lesson = sorted[i];
    if (lesson.startMinute < clusterEnd) {
      // Overlaps with current cluster
      currentCluster.push(lesson);
      clusterEnd = Math.max(clusterEnd, lesson.startMinute + lesson.durationMinutes);
    } else {
      clusters.push(currentCluster);
      currentCluster = [lesson];
      clusterEnd = lesson.startMinute + lesson.durationMinutes;
    }
  }
  clusters.push(currentCluster);

  // For each cluster, assign columns using a greedy algorithm
  const layoutMap = new Map(); // lessonId -> { col, totalCols }

  for (const cluster of clusters) {
    const columns = []; // Each column is a list of lessons in that column

    for (const lesson of cluster) {
      const end = lesson.startMinute + lesson.durationMinutes;
      let placed = false;

      // Try to fit in an existing column
      for (let c = 0; c < columns.length; c++) {
        const lastInCol = columns[c][columns[c].length - 1];
        const lastEnd = lastInCol.startMinute + lastInCol.durationMinutes;
        if (lesson.startMinute >= lastEnd) {
          columns[c].push(lesson);
          placed = true;
          layoutMap.set(lesson.id, { col: c, totalCols: 0 }); // totalCols set later
          break;
        }
      }

      if (!placed) {
        columns.push([lesson]);
        layoutMap.set(lesson.id, { col: columns.length - 1, totalCols: 0 });
      }
    }

    // Set totalCols for all lessons in this cluster
    const totalCols = columns.length;
    for (const lesson of cluster) {
      const entry = layoutMap.get(lesson.id);
      entry.totalCols = totalCols;
    }
  }

  return layoutMap;
}

// ── Group Containers ───────────────────────────────────────────────────
// When grouped lessons overlap in time, render a shared container behind them.
function buildGroupContainers(lessons, layoutMap, startHour) {
  const containers = [];
  const groupedLessons = lessons.filter(l => l.groupId);
  if (groupedLessons.length === 0) return containers;

  // Group by groupId
  const byGroup = new Map();
  for (const lesson of groupedLessons) {
    if (!byGroup.has(lesson.groupId)) byGroup.set(lesson.groupId, []);
    byGroup.get(lesson.groupId).push(lesson);
  }

  for (const [groupId, members] of byGroup) {
    if (members.length < 2) continue; // Need at least 2 to show a container
    const group = getGroup(groupId);
    if (!group) continue;

    // Find overlapping sub-clusters within this group
    const sortedMembers = [...members].sort((a, b) => a.startMinute - b.startMinute);
    const subClusters = [];
    let sc = [sortedMembers[0]];
    let scEnd = sortedMembers[0].startMinute + sortedMembers[0].durationMinutes;

    for (let i = 1; i < sortedMembers.length; i++) {
      const m = sortedMembers[i];
      if (m.startMinute < scEnd) {
        sc.push(m);
        scEnd = Math.max(scEnd, m.startMinute + m.durationMinutes);
      } else {
        subClusters.push(sc);
        sc = [m];
        scEnd = m.startMinute + m.durationMinutes;
      }
    }
    subClusters.push(sc);

    // For each overlapping sub-cluster with 2+ members, create a container
    for (const cluster of subClusters) {
      if (cluster.length < 2) continue;

      const minStart = Math.min(...cluster.map(l => l.startMinute));
      const maxEnd = Math.max(...cluster.map(l => l.startMinute + l.durationMinutes));

      // Find the leftmost and rightmost columns among cluster members
      let minCol = Infinity, maxCol = -1, totalCols = 1;
      for (const l of cluster) {
        const pos = layoutMap.get(l.id);
        if (pos) {
          minCol = Math.min(minCol, pos.col);
          maxCol = Math.max(maxCol, pos.col);
          totalCols = pos.totalCols;
        }
      }

      const top = ((minStart / 60) - startHour) * DAY_SCHEDULE_SLOT_HEIGHT;
      const height = ((maxEnd - minStart) / 60) * DAY_SCHEDULE_SLOT_HEIGHT;

      // Calculate left/right based on column positions
      const contentLeft = DAY_SCHEDULE_LABEL_WIDTH;
      const contentRight = DAY_SCHEDULE_CONTENT_RIGHT;
      const availableWidth = `calc(100% - ${contentLeft + contentRight}px)`;
      const colWidthCalc = `calc(${availableWidth} / ${totalCols})`;
      const leftCalc = `calc(${contentLeft}px + ${colWidthCalc} * ${minCol})`;
      const widthCalc = `calc(${colWidthCalc} * ${maxCol - minCol + 1})`;

      const container = el('div', {
        className: 'group-container',
        style: {
          position: 'absolute',
          top: `${top}px`,
          height: `${height}px`,
          left: leftCalc,
          width: widthCalc,
          background: group.color + '12',
          border: `2px solid ${group.color}44`,
          borderRadius: 'var(--radius-sm)',
          zIndex: '1',
          pointerEvents: 'none',
        }
      });

      // Group label at the top of the container
      const label = el('div', {
        className: 'group-container-label',
        style: {
          position: 'absolute',
          top: '-10px',
          left: '8px',
          background: group.color,
          color: 'white',
          fontSize: '0.6rem',
          fontWeight: '700',
          padding: '1px 8px',
          borderRadius: '10px',
          letterSpacing: '0.03em',
          textTransform: 'uppercase',
          whiteSpace: 'nowrap',
          pointerEvents: 'none',
        }
      }, group.name);
      container.appendChild(label);

      containers.push(container);
    }
  }

  return containers;
}

function buildLessonTile(lesson, dateStr, startHour, pos) {
  const isGroupLesson = isGroupLessonRecord(lesson);
  const pkg = isGroupLesson ? null : getPackageByName(lesson.title);
  const group = lesson.groupId ? getGroup(lesson.groupId) : null;
  const participants = getLessonParticipants(lesson);
  const isCancelled = lesson.cancelledDates && lesson.cancelledDates.includes(dateStr);

  // Check if it happened in the past
  const lessonEnd = new Date(dateStr);
  lessonEnd.setMinutes(lessonEnd.getMinutes() + lesson.startMinute + lesson.durationMinutes);
  const isPastLesson = lessonEnd < new Date();

  let statusClass = 'status-neutral';
  if (isCancelled || (pkg && !pkg.active)) {
    statusClass = 'status-inactive';
  }

  const extraClasses = [];
  if (isPastLesson) extraClasses.push('past');
  if (isCancelled) extraClasses.push('cancelled');

  const top = ((lesson.startMinute / 60) - startHour) * DAY_SCHEDULE_SLOT_HEIGHT;
  const height = Math.max((lesson.durationMinutes / 60) * DAY_SCHEDULE_SLOT_HEIGHT, 24);

  // Compute left/width from column layout
  const col = pos ? pos.col : 0;
  const totalCols = pos ? pos.totalCols : 1;
  const contentLeft = DAY_SCHEDULE_LABEL_WIDTH;
  const contentRight = DAY_SCHEDULE_CONTENT_RIGHT;

  let leftStyle, widthStyle;
  if (totalCols > 1) {
    leftStyle = `calc(${contentLeft}px + (100% - ${contentLeft + contentRight}px) * ${col} / ${totalCols})`;
    widthStyle = `calc((100% - ${contentLeft + contentRight}px) / ${totalCols} - 2px)`;
  } else {
    leftStyle = `${contentLeft}px`;
    widthStyle = `calc(100% - ${contentLeft + contentRight}px)`;
  }

  const tile = el('div', {
    className: `lesson-tile ${statusClass} ${group ? 'grouped' : ''} ${isGroupLesson ? 'group-session' : ''} ${extraClasses.join(' ')}`.trim(),
    style: {
      top: `${top}px`,
      height: `${height}px`,
      left: leftStyle,
      width: widthStyle,
      right: 'auto',
      borderLeftColor: group ? group.color : undefined,
      borderColor: group ? `${group.color}66` : undefined,
      background: group ? `linear-gradient(135deg, ${group.color}26, ${group.color}0c)` : undefined,
      overflow: 'hidden',
    },
    onClick: (e) => {
      if (!e.target.closest('.dragging') && isAdmin()) {
        openLessonModal(dateStr, lesson);
      }
    }
  });
  // Store layout info for drag
  tile._layoutPos = pos;

  const instructorBadge = lesson.instructor
    ? el('span', { className: 'tile-instructor tile-instructor-badge' }, icon('person'), lesson.instructor)
    : null;

  const meta = el('div', { className: 'tile-meta' });
  const showPackageCredits = isAdmin();
  const titleRow = el('div', { className: 'tile-title' });

  if (group) {
    const dot = el('span', { className: 'tile-group-dot', style: { background: group.color } });
    titleRow.appendChild(dot);
  }

  const titleText = el('span', { className: 'tile-title-text' }, getLessonDisplayName(lesson));
  titleRow.appendChild(titleText);

  if (!isGroupLesson && lesson.recurring) {
    titleRow.appendChild(icon('repeat', 'recurring-icon'));
  }

  if (instructorBadge) {
    titleRow.appendChild(instructorBadge);
  }

  tile.appendChild(titleRow);

  if (isGroupLesson) {
    const participantsWrap = el('div', { className: 'tile-participants' });
    for (const participant of participants) {
      const participantRow = el('div', { className: 'tile-participant' });
      participantRow.appendChild(el('span', { className: 'tile-participant-name' }, participant.name));

      if (participant.horse) {
        participantRow.appendChild(el('span', { className: 'tile-participant-horse' }, icon('horse'), participant.horse));
      }

      const participantPkg = participant.packageMode !== false
        ? getPackageByName(participant.packageName || participant.name)
        : null;
      if (showPackageCredits && participantPkg) {
        const isZero = participantPkg.credits === 0;
        const color = !participantPkg.active
          ? 'var(--text-muted)'
          : (isZero ? 'var(--text-muted)' : (participantPkg.credits > 0 ? 'var(--green)' : 'var(--red)'));
        participantRow.appendChild(el('span', {
          className: 'tile-participant-package',
          style: { color }
        }, t('packageLabel', { count: participantPkg.credits })));
      }

      participantsWrap.appendChild(participantRow);
    }
    meta.appendChild(participantsWrap);
  } else {
    const crew = el('span', { className: 'tile-crew' });
    let hasCrew = false;
    if (lesson.horse) {
      crew.appendChild(el('span', { className: 'tile-horse' }, icon('horse'), lesson.horse));
      hasCrew = true;
    }
    if (hasCrew) {
      meta.appendChild(crew);
    }
  }
  if (showPackageCredits && !isGroupLesson && lesson.packageMode !== false && pkg && pkg.active) {
    const isZero = pkg.credits === 0;
    const color = isZero ? 'var(--text-muted)' : (pkg.credits > 0 ? 'var(--green)' : 'var(--red)');
    const creditLabel = el('span', {
      style: { color }
    }, t('packageLabel', { count: pkg.credits }));
    meta.appendChild(creditLabel);
  }
  tile.appendChild(meta);

  if (isCancelled) {
    tile.style.opacity = '0.6';
    tile.style.textDecoration = 'line-through';
  }

  // Drag to move (15 min increments)
  if (!isCancelled && isAdmin()) {
    makeDraggable(tile, lesson, dateStr);
  }

  return tile;
}

// ── Drag & Drop ────────────────────────────────────────────────────────
function makeDraggable(tileEl, lesson, dateStr) {
  const { startHour, endHour } = getDayScheduleHours();
  let startY = 0;
  let startMinute = lesson.startMinute;
  let isDragging = false;
  let isLongPress = false;
  let offsetMinute = 0;
  let longPressTimer = null;

  const onStart = (clientY, isTouch) => {
    startY = clientY;
    startMinute = lesson.startMinute;
    isDragging = false;
    isLongPress = false;

    if (isTouch) {
      // For mobile: require long press to start dragging
      longPressTimer = setTimeout(() => {
        isLongPress = true;
        // Don't set isDragging=true yet, only on move
        tileEl.classList.add('long-press-ready');
        if (navigator.vibrate) navigator.vibrate(50);
      }, 500);
    } else {
      // For desktop: normal drag behavior
      isLongPress = true;
    }
  };

  const onMove = (clientY, isTouch, e = null) => {
    const dy = clientY - startY;

    if (isTouch && !isLongPress) {
      // If user moves too much while waiting for long press, cancel it (scrolling)
      if (Math.abs(dy) > 10) {
        clearTimeout(longPressTimer);
      }
      return;
    }

    if (!isDragging && Math.abs(dy) > 5) {
      isDragging = true;
      if (isTouch && e) e.preventDefault();
    }

    if (!isDragging) return;

    if (isTouch && e && e.cancelable) e.preventDefault();

    tileEl.classList.add('dragging');
    tileEl.classList.remove('long-press-ready');

    // Each pixel ~= 1 minute, scaled to the current hour height.
    const rawMinutes = dy * (60 / DAY_SCHEDULE_SLOT_HEIGHT);
    offsetMinute = Math.round(rawMinutes / 15) * 15;
    const newStart = Math.max(0, Math.min(startMinute + offsetMinute, (endHour - 1) * 60)); // Limit to day range
    tileEl.style.top = `${((newStart / 60) - startHour) * DAY_SCHEDULE_SLOT_HEIGHT}px`;
  };

  const onEnd = () => {
    clearTimeout(longPressTimer);
    tileEl.classList.remove('long-press-ready');

    if (isDragging) {
      const newStart = Math.max(0, Math.min(startMinute + offsetMinute, (endHour - 1) * 60));
      const snapped = Math.round(newStart / 15) * 15;

      if (snapped !== startMinute) {
        updateLesson(lesson.id, { startMinute: snapped });
        processPastLessonsForCredits();
        render();
      }
    }
    tileEl.classList.remove('dragging');
    isDragging = false;
    isLongPress = false;
  };

  // Mouse
  tileEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // Only left click
    onStart(e.clientY, false);
    const moveHandler = (e2) => onMove(e2.clientY, false);
    const upHandler = () => {
      document.removeEventListener('mousemove', moveHandler);
      document.removeEventListener('mouseup', upHandler);
      onEnd();
    };
    document.addEventListener('mousemove', moveHandler);
    document.addEventListener('mouseup', upHandler);
  });

  // Touch
  tileEl.addEventListener('touchstart', (e) => {
    onStart(e.touches[0].clientY, true);
  }, { passive: true });

  tileEl.addEventListener('touchmove', (e) => {
    // We only preventDefault if we are actually dragging
    onMove(e.touches[0].clientY, true, e);
  }, { passive: false });

  tileEl.addEventListener('touchend', (e) => {
    onEnd();
  });
  tileEl.addEventListener('touchcancel', () => {
    onEnd();
  });
  tileEl.addEventListener('contextmenu', (e) => {
    if (isTouchDevice()) e.preventDefault();
    else if (isLongPress || isDragging) e.preventDefault();
  });
}

function isTouchDevice() {
  return 'ontouchstart' in window || navigator.maxTouchPoints > 0;
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

function isGroupLessonRecord(lesson) {
  return !!lesson && Array.isArray(lesson.participants) && lesson.participants.length > 0;
}

function getLessonParticipants(lesson) {
  if (!isGroupLessonRecord(lesson)) return [];
  return lesson.participants
    .map(participant => {
      const name = (participant?.name || '').trim();
      const horse = participant?.horse || null;
      const packageName = (participant?.packageName || name).trim();
      const packageMode = participant?.packageMode !== false;
      if (!name) return null;
      return { name, horse, packageName, packageMode };
    })
    .filter(Boolean);
}

function getKnownClientNames(data) {
  const names = [];
  for (const pkg of data.packages || []) {
    if (pkg?.name) names.push(pkg.name);
  }
  return [...new Set(names.map(name => name.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function getLessonDisplayName(lesson) {
  if (!lesson) return '';
  if (isGroupLessonRecord(lesson)) {
    const group = lesson.groupId ? getGroup(lesson.groupId) : null;
    return group?.name || lesson.groupName || lesson.title || t('groupLesson');
  }
  return lesson.title || '';
}

function getDefaultGroupName() {
  const data = getData();
  let maxGroupNumber = 0;
  for (const group of data.groups || []) {
    const name = (group?.name || '').trim();
    const match = name.match(/^Group\s+(\d+)$/i);
    if (!match) continue;
    maxGroupNumber = Math.max(maxGroupNumber, parseInt(match[1], 10));
  }
  return `Group ${maxGroupNumber + 1}`;
}

// ── Groups Panel ───────────────────────────────────────────────────────
function buildGroupsPanel(lessons = getData().lessons || []) {
  const groups = getAllGroups();
  const section = el('div', { className: 'settings-section groups-section' });
  section.appendChild(el('h4', {}, t('lessonGroups')));

  const chips = el('div', { className: 'group-chips' });

  for (const group of groups) {
    const groupLessons = lessons.filter(l => l.groupId === group.id);
    const chip = el('div', {
      className: 'group-chip',
      style: { background: group.color + '22', color: group.color, borderColor: group.color + '44' },
    },
      el('span', { className: 'tile-group-dot', style: { background: group.color } }),
      `${group.name} (${groupLessons.length})`,
      isAdmin() ? el('button', {
        onClick: (e) => { e.stopPropagation(); deleteGroup(group.id); render(); },
      }, icon('close')) : ''
    );
    chips.appendChild(chip);
  }

  // Add group inline input
  if (isAdmin()) {
    let addingGroup = false;
    const addChip = el('button', {
      className: 'group-chip add-group-chip',
      id: 'add-group-btn',
      onClick: () => {
        if (addingGroup) return;
        addingGroup = true;
        // Replace the button with an input
        const inputWrap = el('div', {
          className: 'group-chip add-group-chip',
          style: { padding: '2px 4px', gap: '4px' }
        });

        const submitGroup = () => {
          if (!addingGroup) return;
          addingGroup = false;
          const name = nameInput.value.trim();
          if (name) {
            createGroup(name);
            render();
          } else {
            inputWrap.replaceWith(addChip);
          }
        };

        const nameInput = el('input', {
          className: 'form-input',
          type: 'text',
          placeholder: t('groupName'),
          id: 'new-group-name-input',
          style: {
            width: '100px',
            padding: '4px 8px',
            fontSize: '0.72rem',
            background: 'var(--bg-input)',
            border: '1px solid var(--border-accent)',
            borderRadius: '12px',
          },
          onKeydown: (e) => {
            if (e.key === 'Enter') submitGroup();
            if (e.key === 'Escape') {
              addingGroup = false;
              inputWrap.replaceWith(addChip);
            }
          },
          onBlur: () => submitGroup()
        });

        const confirmBtn = el('button', {
          style: { display: 'flex', alignItems: 'center' },
          onMousedown: (e) => e.preventDefault(), // Prevent input blur from firing before click
          onClick: (e) => {
            e.stopPropagation();
            submitGroup();
          }
        }, icon('check'));

        inputWrap.appendChild(nameInput);
        inputWrap.appendChild(confirmBtn);
        addChip.replaceWith(inputWrap);
        setTimeout(() => nameInput.focus(), 50);
      }
    }, icon('add'), t('newGroup'));
    chips.appendChild(addChip);
  }

  section.appendChild(chips);
  return section;
}

// ── Lesson Modal ───────────────────────────────────────────────────────
function openLessonModal(dateStr, lesson = null) {
  editingLesson = lesson;
  const isEdit = !!lesson;
  const isGroupEdit = isGroupLessonRecord(lesson);
  const data = getData();
  const clientNames = getKnownClientNames(data);
  const initialType = isEdit && isGroupEdit ? 'group' : 'individual';

  const overlay = el('div', { className: 'modal-overlay', onClick: (e) => {
    if (e.target === overlay) overlay.remove();
  }});

  const modal = el('div', { className: 'modal', tabIndex: -1 });
  modal.appendChild(el('div', { className: 'modal-handle' }));
  modal.appendChild(el('h3', {}, isEdit ? t('editLesson') : t('newLesson')));

  const content = el('div');
  modal.appendChild(content);

  const modeRow = el('div', { className: 'lesson-type-switch' });
  const individualModeBtn = el('button', { className: 'lesson-type-btn', type: 'button' }, t('individualLesson'));
  const groupModeBtn = el('button', { className: 'lesson-type-btn', type: 'button' }, t('groupLesson'));
  modeRow.appendChild(individualModeBtn);
  modeRow.appendChild(groupModeBtn);
  content.appendChild(modeRow);

  const formHost = el('div');
  content.appendChild(formHost);

  const commonSection = el('div');
  const individualSection = el('div');
  const groupSection = el('div');

  const knownClientsDatalist = el('datalist', { id: 'lesson-client-list' });
  for (const name of clientNames) {
    knownClientsDatalist.appendChild(el('option', { value: name }));
  }
  modal.appendChild(knownClientsDatalist);

  const knownGroupsDatalist = el('datalist', { id: 'lesson-group-list' });
  const knownGroupNames = [...new Map(
    getAllGroups()
      .map(group => (group?.name || '').trim())
      .filter(Boolean)
      .map(name => [name.toLowerCase(), name])
  ).values()].sort((a, b) => a.localeCompare(b));
  for (const name of knownGroupNames) {
    knownGroupsDatalist.appendChild(el('option', { value: name }));
  }
  modal.appendChild(knownGroupsDatalist);

  let currentType = initialType;

  const startMinuteDefault = lesson ? lesson.startMinute : 10 * 60;
  const durationDefault = lesson ? lesson.durationMinutes : 60;
  const recurringDefault = !!(
    lesson &&
    lesson.recurring &&
    (!lesson.recurringUntil || lesson._instanceDate !== lesson.recurringUntil)
  );

  const startSelect = el('select', { className: 'form-input', id: 'lesson-start-select' });
  for (let m = 6 * 60; m < 22 * 60; m += 15) {
    const opt = el('option', { value: String(m) }, minutesToTime(m));
    if (startMinuteDefault === m) opt.selected = true;
    startSelect.appendChild(opt);
  }

  const durSelect = el('select', { className: 'form-input', id: 'lesson-duration-select' });
  for (const dur of [30, 45, 60, 90, 120]) {
    const opt = el('option', { value: String(dur) }, `${dur} ${t('min')}`);
    if (durationDefault === dur) opt.selected = true;
    durSelect.appendChild(opt);
  }

  const instrSelect = el('select', { className: 'form-input', id: 'lesson-instructor-select' });
  instrSelect.appendChild(el('option', { value: '' }, t('noInstructor')));
  for (const i of data.instructors) {
    const opt = el('option', { value: i }, i);
    if (lesson && lesson.instructor === i) opt.selected = true;
    instrSelect.appendChild(opt);
  }

  const recurToggle = el('div', {
    className: `toggle ${recurringDefault ? 'active' : ''}`,
    id: 'lesson-recurring-toggle',
    onClick: () => recurToggle.classList.toggle('active')
  });

  const titleInput = el('input', {
    className: 'form-input',
    type: 'text',
    placeholder: t('enterClientName'),
    value: lesson && !isGroupEdit ? lesson.title : '',
    id: 'lesson-title-input',
    list: 'lesson-client-list'
  });

  const horseSelect = el('select', { className: 'form-input', id: 'lesson-horse-select' });
  horseSelect.appendChild(el('option', { value: '' }, t('selectHorse')));
  for (const h of data.horses) {
    const opt = el('option', { value: h }, h);
    if (lesson && lesson.horse === h) opt.selected = true;
    horseSelect.appendChild(opt);
  }

  const packageModeDefault = lesson
    ? (lesson.packageMode !== undefined
      ? lesson.packageMode
      : (isGroupEdit || (Array.isArray(lesson.participants) && lesson.participants.length > 0)
        ? true
        : !!(lesson.title && getPackageByName(lesson.title))))
    : false;
  const packageModeToggle = el('div', {
    className: `toggle ${packageModeDefault ? 'active' : ''}`,
    id: 'lesson-package-toggle',
    onClick: () => packageModeToggle.classList.toggle('active')
  });

  const groupNameInput = el('input', {
    className: 'form-input',
    type: 'text',
    placeholder: t('groupName'),
    value: (() => {
      if (isGroupEdit) return getLessonDisplayName(lesson);
      if (lesson && !isGroupEdit) return lesson.title || '';
      return '';
    })(),
    list: 'lesson-group-list'
  });
  const groupNameSuggestions = el('div', { className: 'group-name-suggestions' });
  const groupNamePicker = el('div', { className: 'group-name-picker is-hidden' }, groupNameSuggestions);

  const renderGroupNameSuggestions = () => {
    groupNameSuggestions.innerHTML = '';
    const query = groupNameInput.value.trim().toLowerCase();
    const groups = getAllGroups()
      .map(group => ({ ...group, name: (group?.name || '').trim() }))
      .filter(group => group.name)
      .sort((a, b) => a.name.localeCompare(b.name))
      .filter(group => !query || group.name.toLowerCase().includes(query));

    if (groups.length === 0) {
      groupNameSuggestions.appendChild(el('div', { className: 'group-name-empty' }, 'No groups in memory'));
      return;
    }

    for (const group of groups) {
      groupNameSuggestions.appendChild(el('button', {
        className: 'group-name-option',
        type: 'button',
        onMouseDown: (e) => {
          e.preventDefault();
          groupNameInput.value = group.name;
          groupNamePicker.classList.add('is-hidden');
          groupNameInput.focus();
        }
      },
      el('span', {
        className: 'group-name-swatch',
        style: { backgroundColor: group.color || '#6366f1' }
      }),
      el('span', { className: 'group-name-text' }, group.name)));
    }
  };

  const openGroupNamePicker = () => {
    renderGroupNameSuggestions();
    groupNamePicker.classList.remove('is-hidden');
  };

  const closeGroupNamePicker = () => {
    groupNamePicker.classList.add('is-hidden');
  };

  groupNameInput.addEventListener('focus', openGroupNamePicker);
  groupNameInput.addEventListener('click', openGroupNamePicker);
  groupNameInput.addEventListener('input', renderGroupNameSuggestions);
  groupNameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeGroupNamePicker();
  });
  groupNameInput.addEventListener('blur', () => {
    window.setTimeout(closeGroupNamePicker, 120);
  });

  const groupColorEnabled = {
    value: !!isGroupEdit
  };
  const groupColorInput = el('input', {
    className: 'form-input',
    type: 'color',
    value: (() => {
      if (isGroupEdit) {
        const group = lesson?.groupId ? getGroup(lesson.groupId) : null;
        return group?.color || '#6366f1';
      }
      return '#6366f1';
    })(),
    style: {
      width: '72px',
      height: '44px',
      padding: '4px',
    }
  });
  groupColorInput.disabled = !groupColorEnabled.value;

  const groupColorToggle = el('div', {
    className: `toggle ${groupColorEnabled.value ? 'active' : ''}`,
    onClick: () => {
      groupColorEnabled.value = !groupColorEnabled.value;
      groupColorToggle.classList.toggle('active', groupColorEnabled.value);
      groupColorInput.disabled = !groupColorEnabled.value;
      groupColorModeLabel.textContent = groupColorEnabled.value ? t('customColor') : t('autoColor');
    }
  });
  const groupColorModeLabel = el('span', {}, groupColorEnabled.value ? t('customColor') : t('autoColor'));

  const participantList = el('div', { className: 'group-participants' });
  const participantRows = [];
  const horseWidthCanvas = document.createElement('canvas');
  const horseWidthContext = horseWidthCanvas.getContext('2d');
  const measureHorseSelectWidth = () => {
    const selectedHorseNames = participantRows
      .map(({ horseSelect }) => (horseSelect?.value || '').trim())
      .filter(Boolean);
    const longestSelected = selectedHorseNames.reduce((max, name) => Math.max(max, name.length), 0);
    let widthPx = 160;
    if (horseWidthContext && longestSelected > 0) {
      const sampleSelect = participantRows.find(({ horseSelect }) => horseSelect)?.horseSelect;
      const computedStyle = sampleSelect ? window.getComputedStyle(sampleSelect) : null;
      const font = computedStyle?.font || `${computedStyle?.fontWeight || '400'} ${computedStyle?.fontSize || '14px'} ${computedStyle?.fontFamily || 'sans-serif'}`;
      horseWidthContext.font = font;
      widthPx = Math.ceil(horseWidthContext.measureText(longestSelected).width + 56);
    }
    participantList.style.setProperty('--participant-horse-width', `${Math.max(widthPx, 140)}px`);
  };

  const addParticipantRow = (participant = {}) => {
    const row = el('div', { className: 'participant-row' });
    const topRow = el('div', { className: 'participant-row-main' });
    const nameInput = el('input', {
      className: 'form-input',
      type: 'text',
      placeholder: t('enterClientName'),
      value: participant.name || '',
      list: 'lesson-client-list'
    });
    const rowHorseSelect = el('select', {
      className: 'form-input participant-horse-select',
      style: {
        width: 'clamp(92px, var(--participant-horse-width, 160px), var(--participant-horse-max-width, 180px))',
        minWidth: 'clamp(92px, var(--participant-horse-width, 160px), var(--participant-horse-max-width, 180px))',
        flex: '0 0 clamp(92px, var(--participant-horse-width, 160px), var(--participant-horse-max-width, 180px))'
      }
    });
    rowHorseSelect.appendChild(el('option', { value: '' }, t('noHorse')));
    for (const h of data.horses) {
      const opt = el('option', { value: h }, h);
      if (participant.horse === h) opt.selected = true;
      rowHorseSelect.appendChild(opt);
    }
    rowHorseSelect.addEventListener('change', measureHorseSelectWidth);

    const removeBtn = el('button', {
      className: 'btn btn-secondary btn-sm participant-remove-btn',
      type: 'button',
      onClick: () => {
        if (participantRows.length <= 1) return;
        const index = participantRows.findIndex(entry => entry.row === row);
        if (index >= 0) participantRows.splice(index, 1);
        row.remove();
        measureHorseSelectWidth();
      }
    }, icon('close'));

    topRow.appendChild(nameInput);
    topRow.appendChild(rowHorseSelect);
    topRow.appendChild(removeBtn);

    const packageMode = { value: participant.packageMode !== false };
    const packageToggle = el('div', {
      className: `toggle ${packageMode.value ? 'active' : ''}`,
      title: t('packageLessonMode'),
      onClick: () => {
        packageMode.value = !packageMode.value;
        packageToggle.classList.toggle('active', packageMode.value);
      }
    });
    const packageControl = el('div', { className: 'participant-package-control' },
      el('span', { className: 'participant-package-label' }, t('packageShort')),
      packageToggle
    );

    row.appendChild(topRow);
    row.appendChild(packageControl);
    participantRows.push({ row, nameInput, horseSelect: rowHorseSelect, packageMode });
    participantList.appendChild(row);
    measureHorseSelectWidth();
  };

  const initialGroupParticipants = isGroupEdit && Array.isArray(lesson?.participants) && lesson.participants.length > 0
    ? lesson.participants
    : (lesson && !isGroupEdit ? [{ name: lesson.title || '', horse: lesson.horse || '' }] : [{ name: '', horse: '' }]);
  for (const participant of initialGroupParticipants) {
    addParticipantRow(participant);
  }
  measureHorseSelectWidth();

  const addParticipantButton = el('button', {
    className: 'btn btn-secondary btn-sm',
    type: 'button',
    onClick: () => addParticipantRow()
  }, icon('add'), t('addParticipant'));

  const renderForm = () => {
    formHost.innerHTML = '';

    individualSection.innerHTML = '';
    groupSection.innerHTML = '';
    commonSection.innerHTML = '';

    const modeLabelRow = el('div', { className: 'form-group' },
      el('label', {}, t('lessonType')),
      el('div', { className: 'lesson-type-label' }, currentType === 'group' ? t('groupLesson') : t('individualLesson'))
    );
    commonSection.appendChild(modeLabelRow);

    const scheduleRow = el('div', { className: 'form-row' });
    const startGroup = el('div', { className: 'form-group' }, el('label', {}, t('startTime')), startSelect);
    const durGroup = el('div', { className: 'form-group' }, el('label', {}, t('duration')), durSelect);
    scheduleRow.appendChild(startGroup);
    scheduleRow.appendChild(durGroup);
    commonSection.appendChild(scheduleRow);

    const instrGroup = el('div', { className: 'form-group' }, el('label', {}, t('instructor')), instrSelect);
    commonSection.appendChild(instrGroup);

    const recurRow = el('div', { className: 'toggle-row' });
    recurRow.appendChild(el('span', {}, t('repeatWeekly')));
    recurRow.appendChild(recurToggle);
    commonSection.appendChild(recurRow);

    individualSection.appendChild(el('div', { className: 'form-group' }, el('label', {}, t('clientName')), titleInput));
    individualSection.appendChild(el('div', { className: 'form-group' }, el('label', {}, t('horse')), horseSelect));
    const packageRow = el('div', { className: 'toggle-row' });
    packageRow.appendChild(el('span', {}, t('packageLessonMode')));
    packageRow.appendChild(packageModeToggle);
    individualSection.appendChild(packageRow);

    const groupNameBlock = el('div', { className: 'form-group group-name-field' });
    groupNameBlock.appendChild(el('label', {}, t('groupNameLabel')));
    groupNameBlock.appendChild(groupNameInput);
    groupNameBlock.appendChild(groupNamePicker);
    groupSection.appendChild(groupNameBlock);

    const groupColorBlock = el('div', { className: 'form-group' });
    groupColorBlock.appendChild(el('label', {}, t('groupColor')));
    const groupColorRow = el('div', { className: 'group-color-row' });
    const groupColorToggleRow = el('div', { className: 'toggle-row group-color-toggle-row' },
      groupColorModeLabel,
      groupColorToggle
    );
    groupColorRow.appendChild(groupColorToggleRow);
    groupColorRow.appendChild(groupColorInput);
    groupColorBlock.appendChild(groupColorRow);
    groupSection.appendChild(groupColorBlock);

    const participantBlock = el('div', { className: 'form-group' });
    participantBlock.appendChild(el('label', {}, t('groupClients')));
    participantBlock.appendChild(participantList);
    participantBlock.appendChild(addParticipantButton);
    groupSection.appendChild(participantBlock);

    formHost.appendChild(commonSection);
    formHost.appendChild(individualSection);
    formHost.appendChild(groupSection);

    individualSection.classList.toggle('is-hidden', currentType !== 'individual');
    groupSection.classList.toggle('is-hidden', currentType !== 'group');
    individualModeBtn.classList.toggle('active', currentType === 'individual');
    groupModeBtn.classList.toggle('active', currentType === 'group');
  };

  const setMode = (mode) => {
    currentType = mode;
    renderForm();
  };

  individualModeBtn.addEventListener('click', () => setMode('individual'));
  groupModeBtn.addEventListener('click', () => setMode('group'));

  renderForm();

  // Buttons
  const btnGroup = el('div', { className: 'btn-group' });
  const baseLesson = isEdit ? (data.lessons.find(l => l.id === lesson.id) || lesson) : null;
  const isRecurringInstance = !!(isEdit && lesson._recurringInstance && baseLesson?.recurring);

  const getLessonPayload = () => {
    const startMinute = parseInt(startSelect.value);
    const durationMinutes = parseInt(durSelect.value);
    const instructor = instrSelect.value || null;
    const recurring = recurToggle.classList.contains('active');
    const packageMode = packageModeToggle.classList.contains('active');

    if (currentType === 'individual') {
      const title = titleInput.value.trim();
      if (!title) {
        titleInput.focus();
        return null;
      }

      return {
        lessonData: {
          lessonType: 'individual',
          title,
          date: dateStr,
          startMinute,
          durationMinutes,
          horse: horseSelect.value || null,
          instructor,
          packageMode,
          groupId: null,
          groupName: null,
          groupColor: null,
          participants: [],
          recurring,
        },
        title,
      };
    }

    const groupName = groupNameInput.value.trim() || getDefaultGroupName();
    if (!groupNameInput.value.trim()) {
      groupNameInput.value = groupName;
    }

    const participants = participantRows.map(({ nameInput, horseSelect, packageMode }) => ({
      name: nameInput.value.trim(),
      horse: horseSelect.value || null,
      packageMode: packageMode.value,
    })).filter(participant => participant.name);

    if (participants.length === 0) {
      participantRows[0]?.nameInput.focus();
      return null;
    }

    return {
      lessonData: {
        lessonType: 'group',
        title: groupName,
        groupName,
        groupId: null,
        groupColor: null,
        date: dateStr,
        startMinute,
        durationMinutes,
        instructor,
        packageMode: true,
        participants,
        recurring,
        horse: null,
      },
      groupName,
      participants,
    };
  };

  const saveLesson = () => {
    const payload = getLessonPayload();
    if (!payload) return null;

    const lessonData = payload.lessonData;
    let mutated = false;
    const recurringDisabled = isRecurringInstance && !lessonData.recurring;
    const recurringReenabled = isRecurringInstance && lessonData.recurring && !!baseLesson?.recurringUntil;

    if (currentType === 'individual') {
      if (isRecurringInstance) {
        const instanceLessonData = { ...lessonData };
        if (recurringDisabled) {
          instanceLessonData.recurring = false;
          updateLesson(baseLesson.id, { recurringUntil: lesson._instanceDate }, { save: false });
        } else if (recurringReenabled) {
          updateLesson(baseLesson.id, { recurringUntil: null }, { save: false });
        }
        updateLessonInstance(baseLesson.id, lesson._instanceDate, instanceLessonData, { save: false });
      } else if (isEdit) {
        updateLesson(lesson.id, lessonData, { save: false });
      } else {
        addLesson(lessonData, { save: false });
      }
      mutated = true;

      if (lessonData.title) {
        ensurePackageEntry(lessonData.title, {
          save: false,
          hasPackageLessons: lessonData.packageMode
        });
        mutated = true;
      }
      if (mutated) saveData();
      return isEdit ? 'updated' : 'created';
    }

    const manualColor = groupColorEnabled.value ? groupColorInput.value : null;
    const currentSeriesGroup = baseLesson?.groupId ? getGroup(baseLesson.groupId) : null;

    if (isRecurringInstance) {
      const instanceGroup = currentSeriesGroup || (baseLesson?.groupId ? getGroup(baseLesson.groupId) : null);
      const instanceGroupId = instanceGroup?.id || baseLesson?.groupId || null;
      const instanceGroupName = instanceGroup?.name || lessonData.groupName;
      const instanceGroupColor = instanceGroup?.color || baseLesson?.groupColor || null;
      const instanceLessonData = {
        ...lessonData,
        title: instanceGroupName,
        groupName: instanceGroupName,
        groupId: instanceGroupId,
        groupColor: instanceGroupColor,
        recurring: recurringDisabled ? false : lessonData.recurring,
      };
      if (recurringDisabled) {
        updateLesson(baseLesson.id, { recurringUntil: lesson._instanceDate }, { save: false });
      } else if (recurringReenabled) {
        updateLesson(baseLesson.id, { recurringUntil: null }, { save: false });
      }
      updateLessonInstance(baseLesson.id, lesson._instanceDate, instanceLessonData, { save: false });
      for (const participant of payload.participants || []) {
        ensurePackageEntry(participant.name, {
          save: false,
          hasPackageLessons: participant.packageMode !== false
        });
      }
      saveData();
      return 'updated';
    }

    let group = null;
    if (isEdit && lesson.groupId) {
      group = getGroup(lesson.groupId);
    }
    if (!group) {
      group = data.groups.find(g => g.name.toLowerCase() === payload.groupName.toLowerCase()) || null;
    }

    if (group) {
      updateGroup(group.id, {
        name: payload.groupName,
        ...(manualColor ? { color: manualColor } : {})
      }, { save: false });
      group = getGroup(group.id);
    } else {
      group = createGroup(payload.groupName, manualColor, { save: false });
    }
    mutated = true;

    const seriesLessonData = {
      ...lessonData,
      title: group.name,
      groupName: payload.groupName,
      groupId: group.id,
      groupColor: group.color,
      recurring: isRecurringInstance ? true : lessonData.recurring,
    };

    if (recurringDisabled && isRecurringInstance) {
      updateLesson(lesson.id, { recurringUntil: lesson._instanceDate }, { save: false });
      updateLessonInstance(lesson.id, lesson._instanceDate, { recurring: false }, { save: false });
    } else if (recurringReenabled && isRecurringInstance) {
      updateLesson(lesson.id, { recurringUntil: null }, { save: false });
    }

    if (isEdit) {
      updateLesson(lesson.id, seriesLessonData, { save: false });
    } else {
      addLesson(seriesLessonData, { save: false });
    }
    mutated = true;

    for (const participant of payload.participants || []) {
      ensurePackageEntry(participant.name, {
        save: false,
        hasPackageLessons: participant.packageMode !== false
      });
      mutated = true;
    }

    if (mutated) saveData();

    return isEdit ? 'updated' : 'created';
  };

  if (isEdit) {
    btnGroup.appendChild(el('button', {
      className: 'btn btn-danger btn-sm',
      onClick: () => {
        deleteLesson(lesson.id);
        overlay.remove();
        showToast(t('lessonDeleted'), 'delete');
        render();
      }
    }, icon('delete'), t('deleteKey')));

    const isCancelled = lesson.cancelledDates && lesson.cancelledDates.includes(dateStr);
    btnGroup.appendChild(el('button', {
      className: 'btn btn-secondary btn-sm',
      onClick: () => {
        toggleCancelLessonInstance(lesson.id, dateStr);
        processPastLessonsForCredits();
        overlay.remove();
        showToast(isCancelled ? t('lessonRestored') : t('lessonCancelled'), isCancelled ? 'restore' : 'cancel');
        render();
      }
    }, icon(isCancelled ? 'restore' : 'cancel'), isCancelled ? t('restore') : t('cancel')));
  }

  btnGroup.appendChild(el('button', {
    className: 'btn btn-primary btn-sm',
    style: { marginLeft: 'auto' },
    onClick: () => {
      const result = saveLesson();
      if (!result) return;
      showToast(result === 'created' ? t('lessonCreated') : t('lessonUpdated'), 'check_circle');
      overlay.remove();
      render();
    }
  }, icon('check'), isRecurringInstance ? t('saveOccurrence') : (isEdit ? t('update') : t('create'))));

  modal.appendChild(btnGroup);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  setTimeout(() => modal.focus(), 300);
}

// ── Packages View ──────────────────────────────────────────────────────
function buildPackageCard(pkg) {
  const card = el('div', {
    className: 'package-card',
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

function buildPackagesView() {
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
          showToast(t('clientAlreadyExists'), 'warning');
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
  const packageClients = sorted.filter(pkg => pkg.hasPackageLessons);
  const noPackageClients = sorted.filter(pkg => !pkg.hasPackageLessons);

  container.appendChild(buildPackageSection(t('packageClients'), packageClients, t('noPackageClientsYet')));
  container.appendChild(buildPackageSection(t('noPackageLessons'), noPackageClients, t('noPackageLessonsYet')));

  return container;
}

function openAddCreditsModal(pkg) {
  const overlay = el('div', { className: 'modal-overlay', onClick: (e) => {
    if (e.target === overlay) overlay.remove();
  }});

  const modal = el('div', { className: 'modal', style: { maxWidth: '300px', margin: 'auto' } });
  modal.appendChild(el('div', { className: 'modal-handle' }));
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

  const btnRow = el('div', { className: 'btn-group' });
  btnRow.appendChild(el('button', {
    className: 'btn btn-secondary',
    onClick: () => overlay.remove()
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
      overlay.remove();
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

function openCreditHistoryModal(pkg) {
  const overlay = el('div', { className: 'modal-overlay', onClick: (e) => {
    if (e.target === overlay) overlay.remove();
  }});

  const modal = el('div', { className: 'modal' });
  modal.appendChild(el('div', { className: 'modal-handle' }));
  modal.appendChild(el('h3', {}, `${pkg.name} - ${t('creditHistory')}`));

  const historyList = el('div', { className: 'history-list', style: { marginTop: '16px', maxHeight: '60vh', overflowY: 'auto' } });

  const history = pkg.history || [];
  if (history.length === 0) {
    historyList.appendChild(el('p', { style: { color: 'var(--text-secondary)', fontStyle: 'italic' } }, t('noHistory')));
  } else {
    // Sort descending by date
    const sortedHistory = [...history].sort((a, b) => new Date(b.date) - new Date(a.date));
    
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
      }      leftObj.appendChild(el('div', { style: textStyle }, `${t('before')}: ${record.before} → ${t('after')}: ${record.after}${desc}`));
      
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


function formatCurrency(amount) {
  if (Number.isNaN(amount)) return '0 z\u0142';
  const fixed = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return `${fixed} z\u0142`;
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
    instructorSelect.appendChild(el('option', { value: instr }, instr));
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

// Settings View
function buildSettingsView() {
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
      onClick: async () => {
        await logout();
        render();
      }
    }, t('logout')));
  } else {
    authSection.appendChild(el('button', {
      className: 'btn btn-primary',
      style: { width: '100%' },
      onClick: promptAdminLogin
    }, icon('login'), t('loginAsAdmin')));
  }
  container.appendChild(authSection);
  if (!isAdmin()) return container;

  if (isAdmin()) {
    // ── Display section
    const displaySection = el('div', { className: 'settings-section' });
    displaySection.appendChild(el('h4', {}, t('language')));

    // Language Switcher
    const langRow = el('div', { className: 'add-item-row', style: { marginBottom: '16px' } });
    const langSelect = el('select', { className: 'form-input', id: 'setting-lang-select' });
    const langs = [{ code: 'en', name: 'English' }, { code: 'pl', name: 'Polski' }];
    for (const l of langs) {
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
    container.appendChild(displaySection);

    container.appendChild(buildGroupsPanel());

    // Horses
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
        if (name && !data.horses.includes(name)) {
          data.horses.push(name);
          saveData(); render();
        }
      }
    }, icon('add')));
    horsesSection.appendChild(addHorseRow);
    container.appendChild(horsesSection);

    // Instructors
    const instrSection = el('div', { className: 'settings-section' });
    instrSection.appendChild(el('h4', {}, t('instructors')));
    const instrList = el('div', { className: 'settings-list' });
    for (const i of data.instructors) {
      const chip = el('div', { className: 'settings-chip' },
        i,
        isAdmin() ? el('button', { className: 'remove-chip', onClick: () => {
          data.instructors = data.instructors.filter(x => x !== i);
          saveData(); render();
        }}, icon('close')) : ''
      );
      instrList.appendChild(chip);
    }
    instrSection.appendChild(instrList);

    const addInstrRow = el('div', { className: 'add-item-row' });
    const instrInput = el('input', { className: 'form-input', type: 'text', placeholder: t('addInstructor'), id: 'add-instructor-input' });
    addInstrRow.appendChild(instrInput);
    addInstrRow.appendChild(el('button', {
      className: 'btn btn-primary btn-sm',
      onClick: () => {
        const name = instrInput.value.trim();
        if (name && !data.instructors.includes(name)) {
          data.instructors.push(name);
          saveData(); render();
        }
      }
    }, icon('add')));
    instrSection.appendChild(addInstrRow);
    container.appendChild(instrSection);

    const reportSection = el('div', { className: 'settings-section' });
    reportSection.appendChild(el('h4', {}, t('reports')));
    reportSection.appendChild(el('button', {
      className: 'btn btn-primary btn-sm',
      style: { width: '100%' },
      onClick: () => openInstructorPaymentModal()
    }, icon('payments'), t('generatePaymentReport')));
    container.appendChild(reportSection);

    // Data management
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
              // Migrate JSON import structure directly to Supabase saving
              Object.assign(data, imported);
              saveData();
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
    return container;
  }

  // ── Minimal non-admin settings
  const displaySection = el('div', { className: 'settings-section' });
  displaySection.appendChild(el('h4', {}, t('language')));

  // Language Switcher
  const langRow = el('div', { className: 'add-item-row', style: { marginBottom: '16px' } });
  const langSelect = el('select', { className: 'form-input', id: 'setting-lang-select' });
  const langs = [{ code: 'en', name: 'English' }, { code: 'pl', name: 'Polski' }];
  for (const l of langs) {
    const opt = el('option', { value: l.code }, l.name);
    if (getLang() === l.code) opt.selected = true;
    langSelect.appendChild(opt);
  }
  langSelect.onchange = (e) => setLang(e.target.value);
  langRow.appendChild(langSelect);
  displaySection.appendChild(langRow);
  displaySection.appendChild(el('h4', {}, t('display')));
  displaySection.appendChild(buildDayScheduleSettings());
  container.appendChild(displaySection);
  return container;
}

// ── Bottom Nav ─────────────────────────────────────────────────────────
function buildBottomNav() {
  const nav = el('div', { className: 'bottom-nav' });
  const admin = isAdmin();

  const tabs = [
    { id: 'calendar', icon: 'calendar_month', label: t('calendar') },
  ];

  if (admin) {
    tabs.push({ id: 'packages', icon: 'inventory_2', label: t('packages') });
    tabs.push({ id: 'horses', icon: 'horse', label: t('horsesTab') });
  }

  tabs.push({ id: 'settings', icon: 'settings', label: t('settings') });

  for (const tab of tabs) {
    const item = el('button', {
      className: `nav-item ${currentTab === tab.id ? 'active' : ''}`,
      id: `nav-${tab.id}`,
      onClick: () => {
        if (tab.id === 'calendar') {
          if (currentTab === 'calendar' && selectedDate) {
            selectedDate = null;
          } else {
            currentTab = 'calendar';
            selectedDate = formatDate(new Date());
          }
        } else {
          currentTab = tab.id;
          selectedDate = null;
        }
        render();
      }
    }, icon(tab.icon), tab.label);
    nav.appendChild(item);
  }

  return nav;
}

// ── Horses View ────────────────────────────────────────────────────────
function buildHorsesView() {
  console.log('[horses] rendering Horses view');
  const container = el('div', { id: 'horses-view-container' });
  try {
    const data = getData();
    if (!data) throw new Error('No data available');
    
    // Range setup
    if (!horseViewRange) {
      console.log('[horses] initializing default week range');
      const dates = getWeekRange();
      if (!dates || dates.length < 7) throw new Error('Week range generation failed');
      horseViewRange = { from: dates[0], to: dates[6] };
    }

  const rangeHeader = el('div', { 
    style: { padding: '16px', background: 'var(--bg-card)', borderBottom: '1px solid var(--border)', marginBottom: '4px' } 
  });
  
  const fromInput = el('input', { type: 'date', className: 'form-input', value: horseViewRange.from || '', style: { width: 'auto', display: 'inline-block' } });
  const toInput = el('input', { type: 'date', className: 'form-input', value: horseViewRange.to || '', style: { width: 'auto', display: 'inline-block' } });
  const applyBtn = el('button', { 
    className: 'btn btn-primary btn-sm',
    onClick: () => {
      if (fromInput.value && toInput.value) {
        horseViewRange = { from: fromInput.value, to: toInput.value };
      }
      render();
    }
  }, t('apply'));

  const inputsRow = el('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
    el('label', { style: { fontSize: '0.8rem' } }, t('dateFrom')),
    fromInput,
    el('label', { style: { fontSize: '0.8rem' } }, t('dateTo')),
    toInput,
    applyBtn
  );
  
  rangeHeader.appendChild(inputsRow);
  container.appendChild(rangeHeader);

    // Group lessons by horse for this week
    const dateList = getDatesInRange(horseViewRange.from, horseViewRange.to);
    const workload = {};
    const horses = data.horses || [];
    horses.forEach(h => { workload[h] = 0; });

    data.lessons.forEach(lesson => {
      // Basic validation for lesson data
      if (!lesson || !lesson.date || !lesson.title) return;
      if (lesson.recurring && lesson.recurringUntil && lesson.date > lesson.recurringUntil) return;
      const participantHorses = isGroupLessonRecord(lesson)
        ? getLessonParticipants(lesson).map(participant => participant.horse).filter(Boolean)
        : (lesson.horse ? [lesson.horse] : []);

      if (participantHorses.length === 0) return;

      // 1. Check all specific dates in the range
      dateList.forEach(dateStr => {
        if (lesson.recurring && lesson.recurringUntil && dateStr > lesson.recurringUntil) return;
        const lessonDate = lesson.date === dateStr;
        const recurringMatch = lesson.recurring && (() => {
          const date = parseDate(dateStr);
          const start = parseDate(lesson.date);
          return date > start && date.getDay() === start.getDay();
        })();

        if (!lessonDate && !recurringMatch) return;

        const isCancelled = lesson.cancelledDates && lesson.cancelledDates.includes(dateStr);
        if (isCancelled) return;

        for (const horse of participantHorses) {
          if (workload.hasOwnProperty(horse)) {
            workload[horse] += lesson.durationMinutes;
          }
        }
      });
  });

  const list = el('div', { className: 'horse-workload-list' });
  
  // Sort horses by workload (descending)
    const sortedHorses = [...horses].sort((a, b) => (workload[b] || 0) - (workload[a] || 0));

    if (sortedHorses.length === 0) {
    list.appendChild(el('div', { style: { padding: '24px', textAlign: 'center', color: 'var(--text-secondary)' } }, t('noHistory')));
  } else {
    for (const horse of sortedHorses) {
      const mins = workload[horse] || 0;
      const hours = Math.floor(mins / 60);
      const remMins = mins % 60;

      const row = el('div', { 
        style: { 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center', 
          padding: '14px 16px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-card)'
        } 
      });
      
      row.appendChild(el('div', { style: { fontWeight: '600' } }, horse));

      const color = mins > 600 ? 'var(--red)' : 'var(--text-secondary)';
      const timeText = hours > 0 ? `${hours}${t('h')} ${remMins}${t('m')}` : `${remMins}${t('m')}`;
      row.appendChild(el('div', { 
        style: { fontWeight: '700', color: color } 
      }, timeText));
      
      list.appendChild(row);
    }
  }

  container.appendChild(list);
  } catch (e) {
    console.error('[horses] error building view:', e);
    container.appendChild(el('div', { style: { padding: '24px', color: 'var(--red)' } }, 'View Error: ' + e.message));
  }
  return container;
}

// ── Toast ──────────────────────────────────────────────────────────────
function showToast(message, iconName = 'info') {
  // Remove existing
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

// Show toast for store errors (sync failures, etc.)
window.addEventListener('store-error', (e) => {
  if (e.detail && e.detail.message) {
    showToast(e.detail.message, 'warning');
  }
});

// Background Refresh (every 1 minute)
// This ensures that as time passes, past lessons are processed for credits
// and visual "past/today" indicators in the UI stay accurate.
setInterval(() => {
  if (isAdmin()) {
    processPastLessonsForCredits();
  }
  render();
}, 60000);
