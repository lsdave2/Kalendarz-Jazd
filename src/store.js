import { formatDate, parseDate } from './utils.js';
import { supabase } from './supabase.js';
import { t } from './i18n.js';

// ── Reactive Store (Supabase-backed) ──────────────────────────────

const defaultData = () => ({
  horses: ['Rubin', 'Czempion', 'Cera', 'Muminek', 'Kadet', 'Sakwa', 'Fason', 'Carewicz', 'Grot', 'Siwa', 'Figa'],
  instructors: ['Ania', 'Olga'],
  lessons: [],          // { id, title, date, startMinute, durationMinutes, horse, instructor, recurring, groupId, lessonType, participants, instanceOverrides }
  packages: [],         // { id, name, credits, active, hasPackageLessons, history }
  groups: [],           // { id, name, color }
  nextId: 1,
  nextGroupId: 1,
});

let _data = defaultData();
let _isAdmin = false;
let _isLoading = true;
const _listeners = new Set();

// Keep _isAdmin in sync with real Supabase session state at all times
// (handles token refresh, expiry, login, logout)
supabase.auth.onAuthStateChange((event, session) => {
  const wasAdmin = _isAdmin;
  _isAdmin = !!session;
  if (wasAdmin !== _isAdmin) {
    notifyListeners();
  }
});

export function isAdmin() {
  return _isAdmin;
}

export function isLoading() {
  return _isLoading;
}

// Subscribe to Supabase realtime
supabase.channel('public:app_state')
  .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'app_state' }, payload => {
    if (payload.new && payload.new.state) {
      _data = payload.new.state;
      notifyListeners();
    }
  })
  .subscribe();

export async function login(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (!error && data.session) {
    _isAdmin = true;
    notifyListeners();
    return true;
  }
  return false;
}

export async function logout() {
  await supabase.auth.signOut();
  _isAdmin = false;
  notifyListeners();
}

export async function loadData() {
  _isLoading = true;
  notifyListeners();

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
            _data = parsed;
            if (_isAdmin) saveData(); // migrate up
          }
        } catch (e) {}
      }
    } else {
      // Remote has data, prefer remote
      _data = data.state;
    }
    
    const def = defaultData();
    for (const k of Object.keys(def)) {
      if (_data[k] === undefined) _data[k] = def[k];
    }
    if (Array.isArray(_data.packages)) {
      _data.packages = _data.packages
        .map(normalizePackageEntry)
        .filter(Boolean);
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
    history: Array.isArray(pkg.history) ? pkg.history : [],
    hasPackageLessons: pkg.hasPackageLessons === true || hasHistory || credits !== 0,
  };
}

function ensurePackageEntryState(name, { hasPackageLessons = false } = {}) {
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
  if (pkg.hasPackageLessons !== true && hasPackageLessons) {
    pkg.hasPackageLessons = true;
    changed = true;
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
    if (ensurePackageEntryState(name, { hasPackageLessons })) {
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

  if (!_isAdmin) {
    console.warn('[store] saveData skipped Supabase sync — no active admin session.');
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

  if (!normalized.lessonType) {
    normalized.lessonType = normalized.participants.length > 0 ? 'group' : 'individual';
  }

  if (normalized.instanceOverrides && typeof normalized.instanceOverrides === 'object') {
    const normalizedOverrides = {};
    for (const [dateStr, override] of Object.entries(normalized.instanceOverrides)) {
      if (!override || typeof override !== 'object') continue;
      const cleanOverride = { ...override };
      if (Array.isArray(cleanOverride.participants)) {
        cleanOverride.participants = normalizeParticipants(cleanOverride.participants);
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
    if (['id', 'cancelledDates', 'deductedDates', 'instanceOverrides', '_recurringInstance', '_instanceDate'].includes(key)) continue;
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
  d.lessons = d.lessons.filter(l => l.id !== id);
  saveData();
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
  const now = new Date();
  let changed = packageSyncChanged;

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
              lessonStartMinute: startMinute
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
              lessonStartMinute: startMinute
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
          lessonStartMinute: startMinute
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
          lessonStartMinute: startMinute
        });
        lesson.deductedDates = lesson.deductedDates.filter(d => d !== dStr);
        changed = true;
      }
    };

    if (!lesson.recurring) {
      checkInstance(lesson.date, lesson);
    } else {
      let currentInstance = parseDate(lesson.date);
      const boundDate = new Date();
      boundDate.setDate(boundDate.getDate() + 7);

      while (currentInstance < boundDate) {
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
  const changed = ensurePackageEntryState(name, { hasPackageLessons });
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
    pkg.active = !pkg.active;
    saveData();
  }
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

// ── Group Management ───────────────────────────────────────────────────

const GROUP_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f59e0b',
  '#10b981', '#06b6d4', '#f97316', '#14b8a6',
];

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
