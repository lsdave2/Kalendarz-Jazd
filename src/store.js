import { formatDate, parseDate } from './utils.js';
import { supabase } from './supabase.js';
import { t } from './i18n.js';

// ── Reactive Store (Supabase-backed) ──────────────────────────────

const defaultData = () => ({
  horses: ['Rubin', 'Czempion', 'Cera', 'Muminek', 'Kadet', 'Sakwa', 'Fason', 'Carewicz', 'Grot', 'Siwa', 'Figa'],
  instructors: [
    { name: 'Ania', color: '#FF5722' },
    { name: 'Olga', color: '#4CAF50' }
  ],
  lessons: [],          // { id, title, date, startMinute, durationMinutes, horse, instructor, recurring, groupId, lessonType, participants, instanceOverrides }
  packages: [],         // { id, name, credits, active, hasPackageLessons, history }
  groups: [],           // { id, name, color }
  closedDates: [],      // ['YYYY-MM-DD']
  nextId: 1,
  nextGroupId: 1,
});

let _data = defaultData();
let _isAdmin = false;
let _isLoading = true;
const _listeners = new Set();

// Keep _isAdmin in sync with real Supabase session state at all times
// (handles token refresh, expiry, login, logout)
if (supabase) {
  supabase.auth.onAuthStateChange((event, session) => {
    const wasAdmin = _isAdmin;
    _isAdmin = !!session;
    if (wasAdmin !== _isAdmin) {
      notifyListeners();
    }
  });
}

export function isAdmin() {
  return _isAdmin;
}

export function isLoading() {
  return _isLoading;
}

// Subscribe to Supabase realtime
if (supabase) {
  supabase.channel('public:app_state')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'app_state' }, payload => {
      if (payload.new && payload.new.state) {
        _data = normalizeAppState(payload.new.state);
        notifyListeners();
      }
    })
    .subscribe();
}

export async function login(email, password) {
  if (!supabase) return false;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (!error && data.session) {
    _isAdmin = true;
    notifyListeners();
    return true;
  }
  return false;
}

export async function logout() {
  if (supabase) await supabase.auth.signOut();
  _isAdmin = false;
  notifyListeners();
}

export async function loadData() {
  _isLoading = true;
  notifyListeners();

  if (!supabase) {
    // Fallback to local storage if Supabase is not configured
    const rawLocal = localStorage.getItem('horsebook_data');
    if (rawLocal) {
      try { _data = normalizeAppState(JSON.parse(rawLocal)); } catch (e) {}
    }
    _isLoading = false;
    notifyListeners();
    return;
  }

  try {
    const { data: { session } } = await supabase.auth.getSession();
    _isAdmin = !!session;

    const { data, error } = await supabase.from('app_state').select('state').eq('id', 1).single();
    
    // Check if remote DB is empty
    const remoteEmpty = !data?.state || Object.keys(data.state).length === 0;

    if (remoteEmpty) {
      // Check local storage for legacy data only because supabase state is completely empty
      const rawLocal = localStorage.getItem('horsebook_data');
      if (rawLocal) {
        try { 
          const parsed = JSON.parse(rawLocal);
          // Only use local if it actually has lessons or packages to avoid overwriting remote DB with empty defaults
          if (parsed.lessons?.length > 0 || parsed.packages?.length > 0) {
            _data = normalizeAppState(parsed);
            if (_isAdmin) saveData(); // migrate up
          }
        } catch (e) {}
      }
    } else {
      // Remote has data, prefer remote
      _data = normalizeAppState(data.state);
    }
  } catch (e) {
    console.error("Failed to sync from Supabase", e);
  }
  
  _isLoading = false;
  processPastLessonsForCredits();
  notifyListeners();
  return _data;
}

function notifyListeners() {
  _listeners.forEach(fn => fn(_data));
}

function normalizePackageEntry(pkg) {
  if (!pkg || typeof pkg !== 'object') return null;
  const name = (pkg.name || '').trim();
  if (!name) return null;
  const credits = Number.isFinite(pkg.credits) ? pkg.credits : (parseInt(pkg.credits, 10) || 0);
  const hasHistory = Array.isArray(pkg.history) && pkg.history.length > 0;
  return {
    ...pkg,
    id: pkg.id ?? generateId(),
    name,
    credits,
    active: pkg.active !== false,
    archivedAt: typeof pkg.archivedAt === 'string' && pkg.archivedAt.trim() ? pkg.archivedAt : null,
    history: Array.isArray(pkg.history) ? pkg.history : [],
    hasPackageLessons: pkg.hasPackageLessons === true || hasHistory || credits !== 0,
  };
}

function normalizeAppState(state) {
  const def = defaultData();
  const normalizedState = {
    ...def,
    ...(state && typeof state === 'object' ? state : {})
  };

  if (!Array.isArray(normalizedState.closedDates)) {
    normalizedState.closedDates = [];
  }

  normalizedState.lessons = Array.isArray(normalizedState.lessons)
    ? normalizedState.lessons.map(normalizeLesson).filter(Boolean)
    : [];

  normalizedState.packages = Array.isArray(normalizedState.packages)
    ? normalizedState.packages.map(normalizePackageEntry).filter(Boolean)
    : [];

  normalizedState.groups = Array.isArray(normalizedState.groups)
    ? normalizedState.groups
      .filter(group => group && typeof group === 'object')
      .map(group => ({
        ...group,
        name: (group.name || '').trim()
      }))
      .filter(group => group.name)
    : [];

  normalizedState.instructors = (Array.isArray(normalizedState.instructors) ? normalizedState.instructors : [])
    .map(instr => {
      if (typeof instr === 'string') {
        return { name: instr, color: getAutoInstructorColor(normalizedState) };
      }
      return {
        name: (instr?.name || '').trim(),
        color: instr?.color || getAutoInstructorColor(normalizedState)
      };
    })
    .filter(instr => instr.name);

  return normalizedState;
}

function getAutoInstructorColor(state) {
  const colors = GROUP_COLORS;
  const count = (state?.instructors || []).length;
  return colors[count % colors.length];
}

function ensurePackageEntryState(name, { hasPackageLessons = false, reactivate = true } = {}) {
  const d = getData();
  const trimmed = name.trim();
  if (!trimmed) return false;

  let pkg = d.packages.find(p => p.name.toLowerCase() === trimmed.toLowerCase());
  if (!pkg) {
    d.packages.push({
      id: generateId(),
      name: trimmed,
      credits: 0,
      active: true,
      archivedAt: null,
      history: [],
      hasPackageLessons: !!hasPackageLessons
    });
    return true;
  }

  let changed = false;
  if (pkg.name !== trimmed) {
    pkg.name = trimmed;
    changed = true;
  }
  if (!Array.isArray(pkg.history)) {
    pkg.history = [];
    changed = true;
  }
  if (pkg.active === undefined) {
    pkg.active = true;
    changed = true;
  }
  if (reactivate && pkg.active === false) {
    pkg.active = true;
    pkg.archivedAt = null;
    changed = true;
  }
  if (pkg.hasPackageLessons !== true && hasPackageLessons) {
    pkg.hasPackageLessons = true;
    changed = true;
  }
  if (typeof pkg.archivedAt !== 'string' && pkg.active !== false) {
    pkg.archivedAt = null;
  }
  return changed;
}

function syncPackageEntriesFromLessons() {
  const d = getData();
  let changed = false;

  if (!Array.isArray(d.packages)) {
    d.packages = [];
    changed = true;
  }

  const normalizedPackages = [];
  for (const rawPkg of d.packages) {
    const normalized = normalizePackageEntry(rawPkg);
    if (!normalized) {
      changed = true;
      continue;
    }
    if (
      normalized.id !== rawPkg.id ||
      normalized.name !== rawPkg.name ||
      normalized.credits !== rawPkg.credits ||
      normalized.active !== rawPkg.active ||
      normalized.hasPackageLessons !== rawPkg.hasPackageLessons ||
      !Array.isArray(rawPkg.history)
    ) {
      changed = true;
    }
    normalizedPackages.push(normalized);
  }
  d.packages = normalizedPackages;

  const registerClient = (name, hasPackageLessons) => {
    if (ensurePackageEntryState(name, { hasPackageLessons, reactivate: false })) {
      changed = true;
    }
  };

  for (const lesson of d.lessons || []) {
    if (Array.isArray(lesson.participants) && lesson.participants.length > 0) {
      for (const participant of lesson.participants) {
        const participantName = (participant?.packageName || participant?.name || '').trim();
        if (!participantName) continue;
        registerClient(participantName, participant?.packageMode !== false);
      }
      continue;
    }

    const title = (lesson?.title || '').trim();
    if (!title) continue;
    const hasPackageLessons = lesson.packageMode !== undefined
      ? lesson.packageMode !== false
      : !!getPackageByName(title);
    registerClient(title, hasPackageLessons);
  }

  return changed;
}

export function getData() {
  return _data;
}

export async function saveData() {
  // Always notify local listeners first for UI responsiveness
  notifyListeners();
  
  // Always save to local storage as a reliable fallback
  try {
    localStorage.setItem('horsebook_data', JSON.stringify(_data));
  } catch (e) {
    console.error('[store] LocalStorage save failed', e);
  }

  if (!supabase || !_isAdmin) {
    if (!_isAdmin) console.warn('[store] saveData skipped Supabase sync — no active admin session.');
    return;
  }

  try {
    const clonedObj = JSON.parse(JSON.stringify(_data));
    const { error } = await supabase
      .from('app_state')
      .upsert({ id: 1, state: clonedObj }, { onConflict: 'id' });
    
    if (error) {
      console.error('[store] Supabase upsert error:', error.message);
      window.dispatchEvent(new CustomEvent('store-error', { 
        detail: { message: t('syncFailed', { error: error.message }), type: 'error' } 
      }));
    } else {
      console.log('[store] Supabase sync successful');
    }
  } catch (e) {
    console.error('[store] Failed to save to Supabase', e);
    window.dispatchEvent(new CustomEvent('store-error', { 
      detail: { message: t('syncConnectionError'), type: 'error' } 
    }));
  }
}

export function subscribe(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

// ── Helpers ────────────────────────────────────────────────────────────

export function generateId() {
  const d = getData();
  return d.nextId++;
}

export function generateGroupId() {
  const d = getData();
  return d.nextGroupId++;
}

function normalizeLesson(lesson) {
  const normalizeParticipants = (participants) => {
    if (!Array.isArray(participants)) return [];
    return participants
      .map(participant => {
        const name = (participant?.name || '').trim();
        const horse = participant?.horse || null;
        const packageName = (participant?.packageName || name).trim();
        const packageMode = participant?.packageMode !== false;
        if (!name) return null;
        return { name, horse, packageName, packageMode };
      })
      .filter(Boolean);
  };

  const normalizeDateString = (value) => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
  };

  const normalized = {
    cancelledDates: [],
    deductedDates: [],
    lessonType: 'individual',
    instanceOverrides: {},
    ...lesson
  };

  if (!Array.isArray(normalized.cancelledDates)) normalized.cancelledDates = [];
  if (!Array.isArray(normalized.deductedDates)) normalized.deductedDates = [];
  if (normalized.packageMode === undefined) {
    const legacyPackage =
      !!(normalized.title && getPackageByName(normalized.title)) ||
      normalized.participants?.length > 0;
    normalized.packageMode = legacyPackage;
  } else {
    normalized.packageMode = normalized.packageMode !== false;
  }

  if (Array.isArray(normalized.participants)) {
    normalized.participants = normalizeParticipants(normalized.participants);
  } else {
    normalized.participants = [];
  }

  // Legacy group links should no longer couple lessons together.
  normalized.groupId = null;
  normalized.groupName = (normalized.groupName || normalized.title || '').trim() || null;
  normalized.groupColor = normalized.groupColor || null;

  if (!normalized.lessonType) {
    normalized.lessonType = normalized.participants.length > 0 ? 'group' : 'individual';
  }

  normalized.recurringUntil = normalizeDateString(normalized.recurringUntil);

  if (normalized.instanceOverrides && typeof normalized.instanceOverrides === 'object') {
    const normalizedOverrides = {};
    for (const [dateStr, override] of Object.entries(normalized.instanceOverrides)) {
      if (!override || typeof override !== 'object') continue;
      const cleanOverride = { ...override };
      if (Array.isArray(cleanOverride.participants)) {
        cleanOverride.participants = normalizeParticipants(cleanOverride.participants);
      }
      cleanOverride.groupId = null;
      cleanOverride.groupName = (cleanOverride.groupName || cleanOverride.title || '').trim() || null;
      if (cleanOverride.groupColor !== undefined) {
        cleanOverride.groupColor = cleanOverride.groupColor || null;
      }
      normalizedOverrides[dateStr] = cleanOverride;
    }
    normalized.instanceOverrides = normalizedOverrides;
  } else {
    normalized.instanceOverrides = {};
  }

  return normalized;
}

// ── Lesson CRUD ────────────────────────────────────────────────────────

export function addLesson(lesson, { save = true } = {}) {
  const d = getData();
  const id = generateId();
  const newLesson = normalizeLesson({
    id,
    ...lesson
  });
  d.lessons.push(newLesson);

  if (save) saveData();
  return newLesson;
}

export function updateLesson(id, updates, { save = true } = {}) {
  const d = getData();
  const idx = d.lessons.findIndex(l => l.id === id);
  if (idx >= 0) {
    d.lessons[idx] = normalizeLesson({ ...d.lessons[idx], ...updates });
    if (save) saveData();
  }
}

export function updateLessonInstance(id, dateStr, updates, { save = true } = {}) {
  const d = getData();
  const idx = d.lessons.findIndex(l => l.id === id);
  if (idx < 0) return;

  const lesson = d.lessons[idx];
  if (!lesson.instanceOverrides || typeof lesson.instanceOverrides !== 'object') {
    lesson.instanceOverrides = {};
  }

  const override = {};
  for (const [key, value] of Object.entries(updates || {})) {
    if ([
      'id',
      'date',
      'recurring',
      'recurringUntil',
      'cancelledDates',
      'deductedDates',
      'instanceOverrides',
      '_recurringInstance',
      '_instanceDate'
    ].includes(key)) continue;
    if (JSON.stringify(lesson[key]) !== JSON.stringify(value)) {
      override[key] = value;
    }
  }

  if (Object.keys(override).length === 0) {
    delete lesson.instanceOverrides[dateStr];
  } else {
    const existing = lesson.instanceOverrides[dateStr] || {};
    const merged = { ...existing, ...override };
    if (Array.isArray(merged.participants)) {
      merged.participants = merged.participants
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
    lesson.instanceOverrides[dateStr] = merged;
  }

  if (save) saveData();
}

export function deleteLesson(id) {
  const d = getData();
  const lesson = d.lessons.find(l => l.id === id);
  if (!lesson) return;

  // Cleanup history and restore credits for any clients affected by this lesson
  const affectedClientNames = [];
  if (Array.isArray(lesson.participants) && lesson.participants.length > 0) {
    lesson.participants.forEach(p => {
      const name = (p.packageName || p.name || '').trim();
      if (name) affectedClientNames.push(name.toLowerCase());
    });
  } else if (lesson.title) {
    affectedClientNames.push(lesson.title.trim().toLowerCase());
  }

  const uniqueClients = [...new Set(affectedClientNames)];
  for (const clientName of uniqueClients) {
    const pkg = d.packages.find(p => p.name.toLowerCase() === clientName);
    if (pkg && pkg.history) {
      let creditDelta = 0;
      const originalHistoryLength = pkg.history.length;
      
      pkg.history = pkg.history.filter(record => {
        // Match by lessonId (preferred) or by date/time (legacy)
        const isLessonRecord = record.reason === 'lesson' || record.reason === 'lesson_cancel';
        if (!isLessonReason(record)) return true;

        const isIdMatch = record.lessonId === id;
        
        // For legacy records without lessonId, check if the date/time matches this lesson
        // For recurring lessons, we check if the record date was one of the deducted dates
        const isLegacyMatch = !record.lessonId && 
                             record.lessonDate && 
                             (lesson.date === record.lessonDate || (lesson.deductedDates && lesson.deductedDates.includes(record.lessonDate))) && 
                             record.lessonStartMinute === lesson.startMinute;

        if (isIdMatch || isLegacyMatch) {
          creditDelta -= record.amount; // Remove deduction (-1) -> +1 credit, remove cancel (+1) -> -1 credit
          return false;
        }
        return true;
      });

      if (pkg.history.length !== originalHistoryLength) {
        pkg.credits += creditDelta;
      }
    }
  }

  d.lessons = d.lessons.filter(l => l.id !== id);
  saveData();
}

function isLessonReason(record) {
  return record.reason === 'lesson' || record.reason === 'lesson_cancel';
}

function getLessonClientNames(lesson) {
  const names = new Set();

  if (Array.isArray(lesson.participants) && lesson.participants.length > 0) {
    for (const participant of lesson.participants) {
      const name = (participant?.packageName || participant?.name || '').trim();
      if (name) names.add(name.toLowerCase());
    }
  } else {
    const title = (lesson?.title || '').trim();
    if (title) names.add(title.toLowerCase());
  }

  return [...names];
}

function getRecurringInstanceLesson(lesson, dateStr) {
  const override = lesson.instanceOverrides?.[dateStr];
  return override ? { ...lesson, ...override } : lesson;
}

function buildClientLessonStats() {
  const stats = new Map();
  const now = new Date();
  const futureHorizon = new Date(now);
  futureHorizon.setFullYear(futureHorizon.getFullYear() + 2);

  const ensureStats = (name) => {
    const key = name.toLowerCase();
    if (!stats.has(key)) {
      stats.set(key, {
        completed: 0,
        future: 0,
        latestCompletedAt: null
      });
    }
    return stats.get(key);
  };

  for (const lesson of _data.lessons || []) {
    const clientNames = getLessonClientNames(lesson);
    if (clientNames.length === 0) continue;

    const durationMinutes = lesson.durationMinutes || 0;
    if (!lesson.recurring) {
      const start = parseDate(lesson.date);
      start.setMinutes(start.getMinutes() + (lesson.startMinute || 0));
      const end = new Date(start);
      end.setMinutes(end.getMinutes() + durationMinutes);
      const isCancelled = Array.isArray(lesson.cancelledDates) && lesson.cancelledDates.includes(lesson.date);
      for (const name of clientNames) {
        const entry = ensureStats(name);
        if (isCancelled) continue;
        if (end < now) {
          entry.completed += 1;
          if (!entry.latestCompletedAt || end > entry.latestCompletedAt) {
            entry.latestCompletedAt = new Date(end);
          }
        } else if (start > now) {
          entry.future += 1;
        }
      }
      continue;
    }

    const recurrenceEnd = lesson.recurringUntil ? parseDate(lesson.recurringUntil) : futureHorizon;
    const loopEnd = recurrenceEnd < futureHorizon ? recurrenceEnd : futureHorizon;
    let current = parseDate(lesson.date);

    while (current <= loopEnd) {
      const dStr = formatDate(current);
      const instanceLesson = getRecurringInstanceLesson(lesson, dStr);
      const instanceDuration = instanceLesson.durationMinutes || durationMinutes;
      const instanceStartMinute = instanceLesson.startMinute || 0;
      const clientNamesForInstance = getLessonClientNames(instanceLesson);
      const start = new Date(current);
      start.setMinutes(start.getMinutes() + instanceStartMinute);
      const end = new Date(start);
      end.setMinutes(end.getMinutes() + instanceDuration);
      const isCancelled = Array.isArray(lesson.cancelledDates) && lesson.cancelledDates.includes(dStr);

      for (const name of clientNamesForInstance) {
        const entry = ensureStats(name);
        if (isCancelled) continue;
        if (end < now) {
          entry.completed += 1;
          if (!entry.latestCompletedAt || end > entry.latestCompletedAt) {
            entry.latestCompletedAt = new Date(end);
          }
        } else if (start > now) {
          entry.future += 1;
        }
      }

      current.setDate(current.getDate() + 7);
    }
  }

  return stats;
}

function autoArchiveDormantClients() {
  const d = getData();
  if (!Array.isArray(d.packages) || d.packages.length === 0) return false;

  const stats = buildClientLessonStats();
  const now = new Date();
  let changed = false;

  for (const pkg of d.packages) {
    if (!pkg || pkg.active === false || pkg.hasPackageLessons) continue;

    const clientStats = stats.get((pkg.name || '').trim().toLowerCase());
    if (!clientStats || clientStats.completed !== 1 || clientStats.future > 0 || !clientStats.latestCompletedAt) {
      continue;
    }

    const graceDeadline = new Date(clientStats.latestCompletedAt);
    graceDeadline.setMonth(graceDeadline.getMonth() + 1);
    if (now < graceDeadline) continue;

    pkg.active = false;
    pkg.archivedAt = now.toISOString();
    changed = true;
  }

  return changed;
}

export function getLessonsForDate(dateStr) {
  const d = getData();
  const results = [];
  const targetDate = new Date(dateStr);
  const targetDay = targetDate.getDay();

  const getInstanceLesson = (lesson, instanceDate) => {
    const override = lesson.instanceOverrides?.[instanceDate];
    if (!override) {
      return { ...lesson, _recurringInstance: !!lesson.recurring, _instanceDate: instanceDate };
    }

    return {
      ...lesson,
      ...override,
      _recurringInstance: !!lesson.recurring,
      _instanceDate: instanceDate,
    };
  };

  for (const lesson of d.lessons) {
    if (lesson.recurring && lesson.recurringUntil && dateStr > lesson.recurringUntil) {
      continue;
    }
    if (lesson.date === dateStr) {
      results.push(getInstanceLesson(lesson, dateStr));
    } else if (lesson.recurring) {
      const lessonDate = new Date(lesson.date);
      if (lessonDate.getDay() === targetDay && lessonDate <= targetDate) {
        // Check this recurring lesson falls on this date
        const diffMs = targetDate - lessonDate;
        const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
        if (diffDays >= 0 && diffDays % 7 === 0) {
          results.push(getInstanceLesson(lesson, dateStr));
        }
      }
    }
  }
  return results;
}

export function toggleCancelLessonInstance(id, dateStr) {
  const d = getData();
  const lesson = d.lessons.find(l => l.id === id);
  if (!lesson) return;
  
  if (!lesson.cancelledDates) lesson.cancelledDates = [];
  
  if (lesson.cancelledDates.includes(dateStr)) {
    lesson.cancelledDates = lesson.cancelledDates.filter(d => d !== dateStr);
  } else {
    lesson.cancelledDates.push(dateStr);
  }
  saveData();
}

// ── Automatic Credit Deduction ─────────────────────────────────────────

export function processPastLessonsForCredits() {
  if (!_data) return;
  const packageSyncChanged = syncPackageEntriesFromLessons();
  const archiveChanged = autoArchiveDormantClients();
  const now = new Date();
  let changed = packageSyncChanged || archiveChanged;

  const getInstanceLesson = (lesson, instanceDate) => {
    const override = lesson.instanceOverrides?.[instanceDate];
    return override ? { ...lesson, ...override } : lesson;
  };

  for (const lesson of _data.lessons) {
    if (!lesson.deductedDates) lesson.deductedDates = [];
    if (!lesson.cancelledDates) lesson.cancelledDates = [];

    const checkInstance = (dStr, instanceLesson) => {
      const startMinute = instanceLesson.startMinute;
      const durationMinutes = instanceLesson.durationMinutes;
      const instanceEnd = parseDate(dStr);
      instanceEnd.setMinutes(instanceEnd.getMinutes() + startMinute + durationMinutes);
      
      const isPast = instanceEnd < now;
      const isCancelled = lesson.cancelledDates.includes(dStr);

      if (Array.isArray(instanceLesson.participants) && instanceLesson.participants.length > 0) {
        const isDeducted = lesson.deductedDates.includes(dStr);
        const uniqueNames = [...new Set(
          instanceLesson.participants
            .filter(participant => participant?.packageMode !== false)
            .map(p => (p?.packageName || p?.name || '').trim())
            .filter(Boolean)
        )];
        if (uniqueNames.length === 0) return;
        if (isPast && !isCancelled && !isDeducted) {
          for (const name of uniqueNames) {
            const pkg = _data.packages.find(p => p.name.toLowerCase() === name.toLowerCase());
            if (!pkg || !pkg.active) continue;
            if (!pkg.history) pkg.history = [];
            const before = pkg.credits;
            pkg.credits -= 1;
            pkg.history.push({
              date: new Date().toISOString(),
              amount: -1,
              before,
              after: pkg.credits,
              reason: 'lesson',
              lessonDate: dStr,
              lessonStartMinute: startMinute,
              lessonId: lesson.id
            });
          }
          lesson.deductedDates.push(dStr);
          changed = true;
        } else if ((!isPast || isCancelled) && isDeducted) {
          for (const name of uniqueNames) {
            const pkg = _data.packages.find(p => p.name.toLowerCase() === name.toLowerCase());
            if (!pkg || !pkg.active) continue;
            if (!pkg.history) pkg.history = [];
            const before = pkg.credits;
            pkg.credits += 1;
            pkg.history.push({
              date: new Date().toISOString(),
              amount: 1,
              before,
              after: pkg.credits,
              reason: 'lesson_cancel',
              lessonDate: dStr,
              lessonStartMinute: startMinute,
              lessonId: lesson.id
            });
          }
          lesson.deductedDates = lesson.deductedDates.filter(d => d !== dStr);
          changed = true;
        }
        return;
      }

      if (instanceLesson.packageMode === false) {
        return;
      }

      const pkg = _data.packages.find(p => p.name.toLowerCase() === lesson.title.toLowerCase());
      if (!pkg || !pkg.active) return;

      if (isPast && !isCancelled && !lesson.deductedDates.includes(dStr)) {
        if (!pkg.history) pkg.history = [];
        const before = pkg.credits;
        pkg.credits -= 1;
        pkg.history.push({
          date: new Date().toISOString(),
          amount: -1,
          before,
          after: pkg.credits,
          reason: 'lesson',
          lessonDate: dStr,
          lessonStartMinute: startMinute,
          lessonId: lesson.id
        });
        lesson.deductedDates.push(dStr);
        changed = true;
      } else if ((!isPast || isCancelled) && lesson.deductedDates.includes(dStr)) {
        if (!pkg.history) pkg.history = [];
        const before = pkg.credits;
        pkg.credits += 1;
        pkg.history.push({
          date: new Date().toISOString(),
          amount: 1,
          before,
          after: pkg.credits,
          reason: 'lesson_cancel',
          lessonDate: dStr,
          lessonStartMinute: startMinute,
          lessonId: lesson.id
        });
        lesson.deductedDates = lesson.deductedDates.filter(d => d !== dStr);
        changed = true;
      }
    };

    if (!lesson.recurring) {
      checkInstance(lesson.date, lesson);
    } else {
      if (lesson.recurringUntil && lesson.date > lesson.recurringUntil) {
        continue;
      }
      let currentInstance = parseDate(lesson.date);
      const boundDate = new Date();
      boundDate.setDate(boundDate.getDate() + 7);
      const recurringUntil = lesson.recurringUntil ? parseDate(lesson.recurringUntil) : null;

      while (currentInstance < boundDate) {
        if (recurringUntil && currentInstance > recurringUntil) break;
        const dStr = formatDate(currentInstance);
        const instanceLesson = getInstanceLesson(lesson, dStr);
        checkInstance(dStr, instanceLesson);
        
        const instanceEnd = new Date(currentInstance);
        instanceEnd.setMinutes(instanceEnd.getMinutes() + instanceLesson.startMinute + instanceLesson.durationMinutes);
        if (instanceEnd >= now) break; 

        currentInstance.setDate(currentInstance.getDate() + 7);
      }
    }
  }

  if (changed) {
    saveData();
  }
}

// ── Package Management ─────────────────────────────────────────────────

export function ensurePackageEntry(name, { save = true, hasPackageLessons = false } = {}) {
  const changed = ensurePackageEntryState(name, { hasPackageLessons, reactivate: true });
  if (changed && save) saveData();
}

export function updatePackageCredits(id, credits) {
  const d = getData();
  const pkg = d.packages.find(p => p.id === id);
  if (pkg) {
    pkg.credits = credits;
    pkg.hasPackageLessons = true;
    saveData();
  }
}

export function addPackageCredits(id, amount) {
  const d = getData();
  const pkg = d.packages.find(p => p.id === id);
  if (pkg) {
    if (!pkg.history) pkg.history = [];
    pkg.hasPackageLessons = true;
    const before = pkg.credits;
    const after = before + amount;
    pkg.credits = after;
    pkg.history.push({
      date: new Date().toISOString(),
      amount,
      before,
      after
    });
    saveData();
  }
}

export function togglePackageActive(id) {
  const d = getData();
  const pkg = d.packages.find(p => p.id === id);
  if (pkg) {
    setPackageActive(id, !pkg.active);
  }
}

export function setPackageActive(id, active) {
  const d = getData();
  const pkg = d.packages.find(p => p.id === id);
  if (pkg) {
    pkg.active = !!active;
    pkg.archivedAt = pkg.active ? null : new Date().toISOString();
    saveData();
  }
}

export function updatePackageName(id, newName) {
  const d = getData();
  const pkg = d.packages.find(p => p.id === id);
  if (!pkg) return false;
  
  const oldName = pkg.name;
  const trimmedNew = newName.trim();
  if (oldName === trimmedNew) return false;
  
  // Check if target name already exists
  if (d.packages.some(p => p.id !== id && p.name.toLowerCase() === trimmedNew.toLowerCase())) {
     return false; // Already exists
  }
  
  pkg.name = trimmedNew;
  
  // Update all lessons
  for (const lesson of d.lessons) {
    if (lesson.title && lesson.title.toLowerCase() === oldName.toLowerCase()) {
       lesson.title = pkg.name;
    }
    if (Array.isArray(lesson.participants)) {
       for (const participant of lesson.participants) {
          const pName = participant.packageName || participant.name || '';
          if (pName.toLowerCase() === oldName.toLowerCase()) {
             if (participant.packageName) {
                participant.packageName = pkg.name;
             }
             if (participant.name.toLowerCase() === oldName.toLowerCase()) {
                participant.name = pkg.name;
             }
          }
       }
    }
    
    // Also check instanceOverrides
    if (lesson.instanceOverrides) {
       for (const override of Object.values(lesson.instanceOverrides)) {
          if (override.title && override.title.toLowerCase() === oldName.toLowerCase()) {
             override.title = pkg.name;
          }
          if (Array.isArray(override.participants)) {
             for (const participant of override.participants) {
                const pName = participant.packageName || participant.name || '';
                if (pName.toLowerCase() === oldName.toLowerCase()) {
                   if (participant.packageName) {
                      participant.packageName = pkg.name;
                   }
                   if (participant.name && participant.name.toLowerCase() === oldName.toLowerCase()) {
                      participant.name = pkg.name;
                   }
                }
             }
          }
       }
    }
  }
  
  saveData();
  return true;
}

export function deletePackage(id) {
  const d = getData();
  d.packages = d.packages.filter(p => p.id !== id);
  saveData();
}

export function getPackageByName(name) {
  const d = getData();
  return d.packages.find(p => p.name.toLowerCase() === name.trim().toLowerCase());
}

export function deductCredit(name, dateStr, startMinute) {
  const d = getData();
  const pkg = d.packages.find(p => p.name.toLowerCase() === name.trim().toLowerCase());
  if (pkg && pkg.active) {
    if (!pkg.history) pkg.history = [];
    pkg.hasPackageLessons = true;
    const before = pkg.credits;
    pkg.credits -= 1;
    pkg.history.push({
      date: new Date().toISOString(),
      amount: -1,
      before,
      after: pkg.credits,
      reason: 'manual_deduct',
      lessonDate: dateStr,
      lessonStartMinute: startMinute
    });
    saveData();
  }
}

// ── Instructor Management ─────────────────────────────────────────────

export function addInstructor(name) {
  const d = getData();
  const trimmed = name.trim();
  if (trimmed && !d.instructors.find(i => i.name.toLowerCase() === trimmed.toLowerCase())) {
    const state = getData();
    const colors = GROUP_COLORS;
    const count = (state?.instructors || []).length;
    const color = colors[count % colors.length];

    d.instructors.push({ name: trimmed, color });
    saveData();
    return true;
  }
  return false;
}

export function updateInstructorColor(name, color) {
  const d = getData();
  const instr = d.instructors.find(i => i.name === name);
  if (instr) {
    instr.color = color;
    saveData();
  }
}

export function deleteInstructor(name) {
  const d = getData();
  d.instructors = d.instructors.filter(i => i.name !== name);
  saveData();
}

// ── Group Management ───────────────────────────────────────────────────

export const GROUP_COLORS = [
  '#FF1744', // Red
  '#F57C00', // Orange
  '#FFD600', // Yellow
  '#76FF03', // Lime
  '#00E676', // Green
  '#00E5FF', // Cyan
  '#2979FF', // Blue
  '#651FFF', // Deep Purple
  '#D500F9', // Magenta
  '#F50057'  // Rose
];

export function getAutoGroupColor() {
  const d = getData();
  const groupLessonCount = (d.lessons || [])
    .filter(lesson => Array.isArray(lesson?.participants) && lesson.participants.length > 0)
    .length;
  return GROUP_COLORS[groupLessonCount % GROUP_COLORS.length];
}

export function createGroup(name, color = null, { save = true } = {}) {
  const d = getData();
  const id = generateGroupId();
  const colorIdx = (d.groups.length) % GROUP_COLORS.length;
  const group = {
    id,
    name: name.trim(),
    color: color || GROUP_COLORS[colorIdx]
  };
  d.groups.push(group);
  if (save) saveData();
  return group;
}

export function updateGroup(id, updates, { save = true } = {}) {
  const d = getData();
  const idx = d.groups.findIndex(g => g.id === id);
  if (idx >= 0) {
    d.groups[idx] = {
      ...d.groups[idx],
      ...updates,
      name: updates.name ? updates.name.trim() : d.groups[idx].name,
      color: updates.color || d.groups[idx].color,
    };
    if (save) saveData();
  }
}

export function getGroup(id) {
  return getData().groups.find(g => g.id === id);
}

export function deleteGroup(id) {
  const d = getData();
  d.groups = d.groups.filter(g => g.id !== id);
  // Ungroup any lessons
  d.lessons.forEach(l => {
    if (l.groupId === id) l.groupId = null;
  });
  saveData();
}

export function getAllGroups() {
  return getData().groups;
}

export function isDateClosed(dateStr) {
  const d = getData();
  return Array.isArray(d.closedDates) && d.closedDates.includes(dateStr);
}

export function toggleClosedDate(dateStr) {
  const d = getData();
  if (!Array.isArray(d.closedDates)) d.closedDates = [];

  if (d.closedDates.includes(dateStr)) {
    d.closedDates = d.closedDates.filter(dStr => dStr !== dateStr);
  } else {
    d.closedDates.push(dateStr);
  }

  saveData();
}
