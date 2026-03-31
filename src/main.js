import './style.css';
import { t, setLang, getLang } from './i18n.js';
import { el, icon, formatDate, parseDate, getDaysInMonth, getFirstDayOfMonth, monthName, dayName, minutesToTime, isToday, isPast } from './utils.js';
import {
  loadData, getData, saveData, subscribe,
  addLesson, updateLesson, deleteLesson, getLessonsForDate,
  updatePackageCredits, togglePackageActive, deletePackage, getPackageByName, deductCredit, ensurePackageEntry, addPackageCredits,
  createGroup, getGroup, deleteGroup, getAllGroups, toggleCancelLessonInstance, processPastLessonsForCredits,
  isAdmin, login, logout, isLoading
} from './store.js';

// ── State ──────────────────────────────────────────────────────────────
let currentTab = 'calendar';
let viewYear, viewMonth;
let selectedDate = null;
let editingLesson = null;
let groupsCollapsed = getSettings().groupsCollapsed || false;

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

// ── Render Engine ──────────────────────────────────────────────────────
const app = document.getElementById('app');

function render() {
  document.title = t('appTitle');
  app.innerHTML = '';
  app.appendChild(buildHeader());

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
    : currentTab === 'packages' ? t('packages') : t('settings');

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
    const classes = ['calendar-day'];
    if (isToday(dateStr)) classes.push('today');
    if (isPast(dateStr)) classes.push('past');
    if (lessons.length > 0) classes.push('has-lessons');

    const dayCell = el('div', {
      className: classes.join(' '),
      onClick: () => { selectedDate = dateStr; render(); }
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

  // Header
  const header = el('div', { className: 'day-header' },
    el('button', { className: 'back-btn', onClick: () => { selectedDate = null; render(); } },
      icon('arrow_back')
    ),
    el('div', {},
      el('h2', {}, `${date.getDate()} ${monthName(date.getMonth())} ${date.getFullYear()}`),
      el('span', { className: 'day-subtitle' }, dayNames[date.getDay()])
    )
  );
  container.appendChild(header);

  // Groups section
  const groups = buildGroupsPanel(dateStr);
  container.appendChild(groups);

  // Schedule
  const schedule = el('div', { className: 'day-schedule', id: 'day-schedule' });
  const lessons = getLessonsForDate(dateStr);

  // Render hours 6..21
  const START_HOUR = 6;
  const END_HOUR = 21;

  for (let h = START_HOUR; h <= END_HOUR; h++) {
    const row = el('div', { className: 'hour-row' });
    row.appendChild(el('div', { className: 'hour-label' }, `${String(h).padStart(2, '0')}:00`));
    row.appendChild(el('div', { className: 'hour-content' }));
    schedule.appendChild(row);

    // Quarter lines
    for (let q = 1; q <= 3; q++) {
      const line = el('div', { className: 'quarter-line' });
      line.style.top = `${(h - START_HOUR) * 80 + q * 20}px`;
      schedule.appendChild(line);
    }
  }

  // Compute layout for overlapping tiles
  const layout = computeOverlapLayout(lessons);

  // Render group containers first (behind tiles)
  const groupContainers = buildGroupContainers(lessons, layout, START_HOUR);
  for (const gc of groupContainers) {
    schedule.appendChild(gc);
  }

  // Place lesson tiles with computed positions
  for (const lesson of lessons) {
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

      const top = ((nowMinutes / 60) - START_HOUR) * 80;
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

      const top = ((minStart / 60) - startHour) * 80;
      const height = ((maxEnd - minStart) / 60) * 80;

      // Calculate left/right based on column positions
      const contentLeft = 52; // matches .lesson-tile left
      const contentRight = 8;
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
  const pkg = getPackageByName(lesson.title);
  const group = lesson.groupId ? getGroup(lesson.groupId) : null;
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

  const top = ((lesson.startMinute / 60) - startHour) * 80;
  const height = Math.max((lesson.durationMinutes / 60) * 80, 24);

  // Compute left/width from column layout
  const col = pos ? pos.col : 0;
  const totalCols = pos ? pos.totalCols : 1;
  const contentLeft = 52;
  const contentRight = 8;

  let leftStyle, widthStyle;
  if (totalCols > 1) {
    leftStyle = `calc(${contentLeft}px + (100% - ${contentLeft + contentRight}px) * ${col} / ${totalCols})`;
    widthStyle = `calc((100% - ${contentLeft + contentRight}px) / ${totalCols} - 2px)`;
  } else {
    leftStyle = `${contentLeft}px`;
    widthStyle = `calc(100% - ${contentLeft + contentRight}px)`;
  }

  const tile = el('div', {
    className: `lesson-tile ${statusClass} ${group ? 'grouped' : ''} ${extraClasses.join(' ')}`.trim(),
    style: {
      top: `${top}px`,
      height: `${height}px`,
      left: leftStyle,
      width: widthStyle,
      right: 'auto',
      borderLeftColor: group ? group.color : undefined,
    },
    onClick: (e) => {
      if (!e.target.closest('.dragging') && isAdmin()) {
        openLessonModal(dateStr, lesson);
      }
    }
  });

  // Store layout info for drag
  tile._layoutPos = pos;

  // Title
  const titleRow = el('div', { className: 'tile-title' });
  if (group) {
    const dot = el('span', { className: 'tile-group-dot', style: { background: group.color } });
    titleRow.appendChild(dot);
  }
  titleRow.appendChild(document.createTextNode(lesson.title));
  if (lesson.recurring) {
    titleRow.appendChild(icon('repeat', 'recurring-icon'));
  }
  tile.appendChild(titleRow);

  // Meta
  const meta = el('div', { className: 'tile-meta' });
  meta.appendChild(el('span', { className: 'tile-time' },
    icon('schedule'),
    `${minutesToTime(lesson.startMinute)} - ${minutesToTime(lesson.startMinute + lesson.durationMinutes)}`
  ));
  if (lesson.horse) {
    meta.appendChild(el('span', { className: 'tile-horse' }, icon('pets'), lesson.horse));
  }
  if (lesson.instructor) {
    meta.appendChild(el('span', { className: 'tile-instructor' }, icon('person'), lesson.instructor));
  }
  if (isPastLesson && !isCancelled) {
    meta.appendChild(el('span', { style: { color: 'var(--green)', display: 'flex', alignItems: 'center' } }, icon('check_circle'), t('past')));
  }
  if (pkg && pkg.active) {
    const isZero = pkg.credits === 0;
    const color = isZero ? 'var(--text-muted)' : (pkg.credits > 0 ? 'var(--green)' : 'var(--red)');
    const creditLabel = el('span', {
      style: { color }
    }, `Package: [${pkg.credits}]`);
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

    // Each pixel ~= 1 minute (80px = 60 min)
    const rawMinutes = dy * (60 / 80);
    offsetMinute = Math.round(rawMinutes / 15) * 15;
    const newStart = Math.max(0, Math.min(startMinute + offsetMinute, 20 * 60)); // Limit to day range
    tileEl.style.top = `${((newStart / 60) - 6) * 80}px`;
  };

  const onEnd = () => {
    clearTimeout(longPressTimer);
    tileEl.classList.remove('long-press-ready');

    if (isDragging) {
      const newStart = Math.max(0, Math.min(startMinute + offsetMinute, 20 * 60));
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

// ── Groups Panel ───────────────────────────────────────────────────────
function buildGroupsPanel(dateStr) {
  const groups = getAllGroups();
  const lessons = getLessonsForDate(dateStr);
  const section = el('div', { className: `groups-section ${groupsCollapsed ? 'collapsed' : ''}` });
  
  const h4 = el('div', { 
    className: 'groups-header',
    onClick: () => {
      groupsCollapsed = !groupsCollapsed;
      const s = getSettings();
      s.groupsCollapsed = groupsCollapsed;
      saveSettings(s);
      render();
    }
  }, 
    el('h4', {}, t('lessonGroups')),
    icon(groupsCollapsed ? 'expand_more' : 'expand_less')
  );
  section.appendChild(h4);

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

  const overlay = el('div', { className: 'modal-overlay', onClick: (e) => {
    if (e.target === overlay) overlay.remove();
  }});

  const modal = el('div', { className: 'modal' });
  modal.appendChild(el('div', { className: 'modal-handle' }));
  modal.appendChild(el('h3', {}, isEdit ? t('editLesson') : t('newLesson')));

  const data = getData();

  // Title
  const titleGroup = el('div', { className: 'form-group' });
  titleGroup.appendChild(el('label', {}, t('clientName')));
  const titleInput = el('input', {
    className: 'form-input',
    type: 'text',
    placeholder: t('enterClientName'),
    value: lesson ? lesson.title : '',
    id: 'lesson-title-input'
  });
  titleGroup.appendChild(titleInput);

  // Suggestions row
  const suggestionsRow = el('div', { className: 'suggestions-row', id: 'client-suggestions' });
  titleGroup.appendChild(suggestionsRow);

  const updateSuggestions = (val) => {
    suggestionsRow.innerHTML = '';
    const query = val.toLowerCase().trim();
    if (!query) {
      suggestionsRow.style.display = 'none';
      return;
    }
    
    // Get unique existing client names from both packages AND all past/future lessons
    const namesFromPackages = data.packages.map(p => p.name);
    const namesFromLessons = data.lessons.map(l => l.title);
    const allUniqueNames = [...new Set([...namesFromPackages, ...namesFromLessons])];

    const matches = allUniqueNames.filter(name => 
      name.toLowerCase().includes(query) && name.toLowerCase() !== query
    ).sort().slice(0, 5); // Sort alphabetically and limit to 5 suggestions

    if (matches.length > 0) {
      suggestionsRow.style.display = 'flex';
      matches.forEach(name => {
        const chip = el('button', {
          className: 'suggestion-chip',
          onClick: () => {
            titleInput.value = name;
            updateSuggestions('');
          }
        }, name);
        suggestionsRow.appendChild(chip);
      });
    } else {
      suggestionsRow.style.display = 'none';
    }
  };

  titleInput.addEventListener('input', (e) => updateSuggestions(e.target.value));

  modal.appendChild(titleGroup);

  // Time row
  const timeRow = el('div', { className: 'form-row' });

  const startGroup = el('div', { className: 'form-group' });
  startGroup.appendChild(el('label', {}, t('startTime')));
  const startSelect = el('select', { className: 'form-input', id: 'lesson-start-select' });
  for (let m = 6 * 60; m < 22 * 60; m += 15) {
    const opt = el('option', { value: String(m) }, minutesToTime(m));
    if (lesson && lesson.startMinute === m) opt.selected = true;
    else if (!lesson && m === 10 * 60) opt.selected = true;
    startSelect.appendChild(opt);
  }
  startGroup.appendChild(startSelect);
  timeRow.appendChild(startGroup);

  const durGroup = el('div', { className: 'form-group' });
  durGroup.appendChild(el('label', {}, t('duration')));
  const durSelect = el('select', { className: 'form-input', id: 'lesson-duration-select' });
  for (const dur of [30, 45, 60, 90, 120]) {
    const opt = el('option', { value: String(dur) }, `${dur} ${t('min')}`);
    if (lesson && lesson.durationMinutes === dur) opt.selected = true;
    else if (!lesson && dur === 60) opt.selected = true;
    durSelect.appendChild(opt);
  }
  durGroup.appendChild(durSelect);
  timeRow.appendChild(durGroup);

  modal.appendChild(timeRow);

  // Horse & Instructor row
  const hiRow = el('div', { className: 'form-row' });

  const horseGroup = el('div', { className: 'form-group' });
  horseGroup.appendChild(el('label', {}, t('horse')));
  const horseSelect = el('select', { className: 'form-input', id: 'lesson-horse-select' });
  horseSelect.appendChild(el('option', { value: '' }, t('noHorse')));
  for (const h of data.horses) {
    const opt = el('option', { value: h }, h);
    if (lesson && lesson.horse === h) opt.selected = true;
    horseSelect.appendChild(opt);
  }
  horseGroup.appendChild(horseSelect);
  hiRow.appendChild(horseGroup);

  const instrGroup = el('div', { className: 'form-group' });
  instrGroup.appendChild(el('label', {}, t('instructor')));
  const instrSelect = el('select', { className: 'form-input', id: 'lesson-instructor-select' });
  instrSelect.appendChild(el('option', { value: '' }, t('noInstructor')));
  for (const i of data.instructors) {
    const opt = el('option', { value: i }, i);
    if (lesson && lesson.instructor === i) opt.selected = true;
    instrSelect.appendChild(opt);
  }
  instrGroup.appendChild(instrSelect);
  hiRow.appendChild(instrGroup);

  modal.appendChild(hiRow);

  // Group
  const groupGroup = el('div', { className: 'form-group' });
  groupGroup.appendChild(el('label', {}, t('groupOptional')));
  const groupSelect = el('select', { className: 'form-input', id: 'lesson-group-select' });
  groupSelect.appendChild(el('option', { value: '' }, t('noGroup')));
  for (const g of data.groups) {
    const opt = el('option', { value: String(g.id) }, g.name);
    if (lesson && lesson.groupId === g.id) opt.selected = true;
    groupSelect.appendChild(opt);
  }
  groupGroup.appendChild(groupSelect);
  modal.appendChild(groupGroup);

  // Recurring toggle
  const recurRow = el('div', { className: 'toggle-row' });
  recurRow.appendChild(el('span', {}, t('repeatWeekly')));
  const recurToggle = el('div', {
    className: `toggle ${lesson && lesson.recurring ? 'active' : ''}`,
    id: 'lesson-recurring-toggle',
    onClick: () => recurToggle.classList.toggle('active')
  });
  recurRow.appendChild(recurToggle);
  modal.appendChild(recurRow);

  // Add to Packages toggle
  const pkgExists = lesson ? !!getPackageByName(lesson.title) : false;
  const pkgRow = el('div', { className: 'toggle-row' });
  pkgRow.appendChild(el('span', {}, t('enablePackages')));
  const pkgToggle = el('div', {
    className: `toggle ${pkgExists ? 'active' : ''}`,
    id: 'lesson-package-toggle',
    onClick: () => pkgToggle.classList.toggle('active')
  });
  pkgRow.appendChild(pkgToggle);
  modal.appendChild(pkgRow);

  // Buttons
  const btnGroup = el('div', { className: 'btn-group' });

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
        processPastLessonsForCredits(); // Process credits immediately
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
      const title = titleInput.value.trim();
      if (!title) { titleInput.focus(); return; }

      const lessonData = {
        title,
        date: dateStr,
        startMinute: parseInt(startSelect.value),
        durationMinutes: parseInt(durSelect.value),
        horse: horseSelect.value || null,
        instructor: instrSelect.value || null,
        groupId: groupSelect.value ? parseInt(groupSelect.value) : null,
        recurring: recurToggle.classList.contains('active'),
      };

      if (isEdit) {
        updateLesson(lesson.id, lessonData);
        showToast(t('lessonUpdated'), 'check_circle');
      } else {
        addLesson(lessonData);
        showToast(t('lessonCreated'), 'check_circle');
      }

      // Add to packages if toggled
      if (pkgToggle.classList.contains('active')) {
        ensurePackageEntry(title);
      }

      overlay.remove();
      render();
    }
  }, icon('check'), isEdit ? t('update') : t('create')));

  modal.appendChild(btnGroup);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Focus title
  setTimeout(() => titleInput.focus(), 300);
}

// ── Packages View ──────────────────────────────────────────────────────
function buildPackagesView() {
  const container = el('div');
  const data = getData();

  // Search
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
        d.packages.push({ id: d.nextId++, name, credits: 0, active: true });
        saveData();
        render();
      }
    }, icon('add'), t('add')));
    container.appendChild(addRow);
  }

  if (data.packages.length === 0) {
    container.appendChild(el('div', { className: 'empty-state' },
      icon('inventory_2'),
      el('p', {}, t('noClientsYet'))
    ));
    return container;
  }

  const sorted = [...data.packages].sort((a, b) => {
    return a.name.localeCompare(b.name);
  });

  const list = el('div', { className: 'package-list' });

  for (const pkg of sorted) {
    const card = el('div', {
      className: 'package-card',
      style: { cursor: 'pointer' },
      'data-name': pkg.name.toLowerCase(),
      onClick: () => openCreditHistoryModal(pkg)
    });

    // Info
    const info = el('div', { className: 'package-info' });
    info.appendChild(el('div', { className: 'package-name' }, pkg.name));
    card.appendChild(info);

    // Credits control
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
        onClick: (e) => {
          e.stopPropagation();
          openAddCreditsModal(pkg);
        }
      }, icon('add'), t('addCredits')));
    }

    card.appendChild(credits);

    if (isAdmin()) {
      const actions = el('div', { className: 'package-actions' });
      actions.appendChild(el('button', {
        className: 'package-action-btn',
        title: t('deleteClient'),
        onClick: (e) => {
          e.stopPropagation();
          // Custom confirm modal
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
    list.appendChild(card);
  }

  container.appendChild(list);
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
      }
      
      leftObj.appendChild(el('div', { style: textStyle }, `${t('before')}: ${record.before}  →  ${t('after')}: ${record.after}${desc}`));
      
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

// ── Settings View ──────────────────────────────────────────────────────
function buildSettingsView() {
  const container = el('div');
  const data = getData();
  const settings = getSettings();

  // ── Auth Section
  const authSection = el('div', { className: 'settings-section' });
  if (isAdmin()) {
    authSection.appendChild(el('h4', {}, 'Admin Role'));
    authSection.appendChild(el('p', { style: { marginBottom: '16px', color: 'var(--text-secondary)' } }, 'You have permission to edit the schedule.'));
    authSection.appendChild(el('button', {
      className: 'btn btn-secondary',
      style: { width: '100%' },
      onClick: async () => {
        await logout();
        render();
      }
    }, 'Logout'));
  } else {
    authSection.appendChild(el('h4', {}, 'Viewer Role'));
    authSection.appendChild(el('p', { style: { marginBottom: '16px', color: 'var(--text-secondary)' } }, 'You have read-only access. Log in to make changes.'));
    
    authSection.appendChild(el('button', {
      className: 'btn btn-primary',
      style: { width: '100%' },
      onClick: () => {
        // Simple login prompt
        const email = prompt('Email:');
        if (!email) return;
        const password = prompt('Password:');
        if (!password) return;
        
        login(email, password).then(success => {
          if (success) {
            showToast('Logged in successfully', 'check_circle');
            render();
          } else {
            showToast('Login failed', 'error');
          }
        });
      }
    }, icon('login'), 'Login as Admin'));
  }
  container.appendChild(authSection);

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
  container.appendChild(displaySection);

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

  if (isAdmin()) {
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
  }
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

  if (isAdmin()) {
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
  }
  container.appendChild(instrSection);

  if (isAdmin()) {
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
  }
  return container;
}

// ── Bottom Nav ─────────────────────────────────────────────────────────
function buildBottomNav() {
  const nav = el('div', { className: 'bottom-nav' });

  const tabs = [
    { id: 'calendar', icon: 'calendar_month', label: t('calendar') },
    { id: 'packages', icon: 'inventory_2', label: t('packages') },
    { id: 'settings', icon: 'settings', label: t('settings') },
  ];

  for (const tab of tabs) {
    const item = el('button', {
      className: `nav-item ${currentTab === tab.id ? 'active' : ''}`,
      id: `nav-${tab.id}`,
      onClick: () => {
        currentTab = tab.id;
        if (tab.id === 'calendar') {
          selectedDate = formatDate(new Date());
        } else {
          selectedDate = null;
        }
        render();
      }
    }, icon(tab.icon), tab.label);
    nav.appendChild(item);
  }

  return nav;
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
