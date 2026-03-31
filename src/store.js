import { formatDate, parseDate } from './utils.js';
import { supabase } from './supabase.js';
import { t } from './i18n.js';

// ── Reactive Store (Supabase-backed) ──────────────────────────────

const defaultData = () => ({
  horses: ['Rubin', 'Czempion', 'Cera', 'Muminek', 'Kadet', 'Sakwa', 'Fason', 'Carewicz', 'Grot', 'Siwa', 'Figa'],
  instructors: ['Ania', 'Olga'],
  lessons: [],          // { id, title, date, startMinute, durationMinutes, horse, instructor, recurring, groupId }
  packages: [],         // { id, name, credits, active }
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

// ── Lesson CRUD ────────────────────────────────────────────────────────

export function addLesson(lesson) {
  const d = getData();
  const id = generateId();
  const newLesson = { 
    id, 
    cancelledDates: [],
    deductedDates: [],
    ...lesson 
  };
  d.lessons.push(newLesson);

  saveData();
  return newLesson;
}

export function updateLesson(id, updates) {
  const d = getData();
  const idx = d.lessons.findIndex(l => l.id === id);
  if (idx >= 0) {
    d.lessons[idx] = { ...d.lessons[idx], ...updates };
    saveData();
  }
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

  for (const lesson of d.lessons) {
    if (lesson.date === dateStr) {
      results.push(lesson);
    } else if (lesson.recurring) {
      const lessonDate = new Date(lesson.date);
      if (lessonDate.getDay() === targetDay && lessonDate <= targetDate) {
        // Check this recurring lesson falls on this date
        const diffMs = targetDate - lessonDate;
        const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));
        if (diffDays >= 0 && diffDays % 7 === 0) {
          results.push({ ...lesson, _recurringInstance: true, _instanceDate: dateStr });
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
  const now = new Date();
  let changed = false;

  for (const lesson of _data.lessons) {
    if (!lesson.deductedDates) lesson.deductedDates = [];
    if (!lesson.cancelledDates) lesson.cancelledDates = [];

    const pkg = _data.packages.find(p => p.name.toLowerCase() === lesson.title.toLowerCase());
    if (!pkg || !pkg.active) continue;

    const startDate = parseDate(lesson.date);

    const checkInstance = (dStr, startMinute, durationMinutes) => {
      const instanceEnd = parseDate(dStr);
      instanceEnd.setMinutes(instanceEnd.getMinutes() + startMinute + durationMinutes);
      
      const isPast = instanceEnd < now;
      const isCancelled = lesson.cancelledDates.includes(dStr);
      const isDeducted = lesson.deductedDates.includes(dStr);

      if (isPast && !isCancelled && !isDeducted) {
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
      } else if ((!isPast || isCancelled) && isDeducted) {
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
      checkInstance(lesson.date, lesson.startMinute, lesson.durationMinutes);
    } else {
      let currentInstance = parseDate(lesson.date);
      const boundDate = new Date();
      boundDate.setDate(boundDate.getDate() + 7);

      while (currentInstance < boundDate) {
        const dStr = formatDate(currentInstance);
        checkInstance(dStr, lesson.startMinute, lesson.durationMinutes);
        
        const instanceEnd = new Date(currentInstance);
        instanceEnd.setMinutes(instanceEnd.getMinutes() + lesson.startMinute + lesson.durationMinutes);
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

export function ensurePackageEntry(name) {
  const d = getData();
  const trimmed = name.trim();
  if (!trimmed) return;
  const exists = d.packages.find(p => p.name.toLowerCase() === trimmed.toLowerCase());
  if (!exists) {
    d.packages.push({ id: generateId(), name: trimmed, credits: 0, active: true, history: [] });
    saveData();
  }
}

export function updatePackageCredits(id, credits) {
  const d = getData();
  const pkg = d.packages.find(p => p.id === id);
  if (pkg) {
    pkg.credits = credits;
    saveData();
  }
}

export function addPackageCredits(id, amount) {
  const d = getData();
  const pkg = d.packages.find(p => p.id === id);
  if (pkg) {
    if (!pkg.history) pkg.history = [];
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

export function createGroup(name) {
  const d = getData();
  const id = generateGroupId();
  const colorIdx = (d.groups.length) % GROUP_COLORS.length;
  const group = { id, name, color: GROUP_COLORS[colorIdx] };
  d.groups.push(group);
  saveData();
  return group;
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
