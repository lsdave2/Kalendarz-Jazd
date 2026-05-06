import { formatDate, parseDate } from './utils.js';
import { supabase } from './supabase.js';
import { t } from './i18n.js';
import { logAction } from './services/AuditService.js';

const LOCAL_DATA_KEY = 'horsebook_data';
const LOCAL_PENDING_KEY = 'horsebook_pending_sync';
const REMOTE_TABLES = ['lessons', 'packages', 'instructors', 'horses', 'groups', 'settings', 'expenses', 'incomes'];

const defaultData = () => ({
  horses: ['Rubin', 'Czempion', 'Cera', 'Muminek', 'Kadet', 'Sakwa', 'Fason', 'Carewicz', 'Grot', 'Siwa', 'Figa'],
  instructors: [
    { name: 'Ania', color: '#FF5722' },
    { name: 'Olga', color: '#4CAF50' }
  ],
  lessons: [],
  packages: [],
  groups: [],
  closedDates: [],
  expenses: [],
  incomes: [],
  nextId: 1,
  nextGroupId: 1,
});

function createEmptyPersistedState() {
  return {
    horses: [],
    instructors: [],
    lessons: [],
    packages: [],
    groups: [],
    closedDates: [],
    expenses: [],
    incomes: [],
    nextId: 1,
    nextGroupId: 1,
  };
}

let _data = defaultData();
let _persistedData = defaultData();
let _isAdmin = false;
let _isLoading = true;
let _isSaving = false;
let _hasPendingLocalChanges = false;
let _saveChain = Promise.resolve();
let _realtimeChannel = null;
let _realtimeInitialized = false;
let _needsRemoteRefresh = false;
const _listeners = new Set();

const _meta = {
  horses: new Map(),
  instructors: new Map(),
  settings: new Map(),
};

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (_hasPendingLocalChanges) {
      saveData();
    } else if (supabase) {
      refreshFromRemote();
    }
  });
}

if (supabase) {
  supabase.auth.onAuthStateChange((event, session) => {
    const wasAdmin = _isAdmin;
    _isAdmin = !!session;
    if (_isAdmin && _hasPendingLocalChanges) {
      saveData();
    }
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

export function isSaving() {
  return _isSaving;
}

export function hasPendingChanges() {
  return _hasPendingLocalChanges;
}

export function subscribe(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function getData() {
  return _data;
}

export function generateId() {
  return createUuid();
}

export function generateGroupId() {
  return createUuid();
}

function createUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function notifyListeners() {
  _listeners.forEach(fn => fn(_data));
}

function dispatchStoreError(message) {
  window.dispatchEvent(new CustomEvent('store-error', {
    detail: { message, type: 'error' }
  }));
}

function readLocalState() {
  try {
    const raw = localStorage.getItem(LOCAL_DATA_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function persistLocalState({ pending = _hasPendingLocalChanges } = {}) {
  try {
    localStorage.setItem(LOCAL_DATA_KEY, JSON.stringify(_data));
    localStorage.setItem(LOCAL_PENDING_KEY, pending ? '1' : '0');
  } catch (e) {
    console.error('[store] LocalStorage save failed', e);
  }
}

function readPendingFlag() {
  try {
    return localStorage.getItem(LOCAL_PENDING_KEY) === '1';
  } catch {
    return false;
  }
}

function normalizeHorseList(horses) {
  if (!Array.isArray(horses)) return [];
  return horses
    .map(horse => (typeof horse === 'string' ? horse.trim() : ''))
    .filter(Boolean);
}

function normalizeParticipants(participants) {
  if (!Array.isArray(participants)) return [];
  return participants
    .map(participant => {
      const name = (participant?.name || '').trim();
      const horse = participant?.horse || null;
      const packageName = (participant?.packageName || name).trim();
      const packageMode = participant?.packageMode !== false;
      const instructor = participant?.instructor || null;
      const customCost = participant?.customCost;
      if (!name) return null;
      return { name, horse, packageName, packageMode, instructor, customCost };
    })
    .filter(Boolean);
}

function normalizeDateString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null;
}

function getLessonHistoryKey(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.reason !== 'lesson' && entry.reason !== 'lesson_cancel') return null;
  if (!entry.lessonDate || entry.lessonStartMinute === undefined || entry.lessonStartMinute === null) {
    return null;
  }
  return [
    entry.reason,
    entry.lessonId || '',
    entry.lessonDate,
    entry.lessonStartMinute
  ].join('|');
}

function normalizeHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const nextEntry = { ...entry };
  const lessonHistoryKey = getLessonHistoryKey(nextEntry);
  if (lessonHistoryKey) {
    nextEntry.historyKey = lessonHistoryKey;
  }
  return nextEntry;
}

function getHistoryEntrySignature(entry) {
  const normalizedEntry = normalizeHistoryEntry(entry);
  if (!normalizedEntry) return null;
  return normalizedEntry.historyKey || JSON.stringify(normalizedEntry);
}

function dedupeHistoryEntries(history = []) {
  const dedupedHistory = [];
  let duplicateAmountTotal = 0;
  let previousSignature = null;

  for (const entry of history) {
    const normalizedEntry = normalizeHistoryEntry(entry);
    if (!normalizedEntry) continue;
    const signature = getHistoryEntrySignature(normalizedEntry);
    if (!signature) continue;
    // Only collapse immediately repeated entries. Lesson credits can legitimately
    // alternate between the same occurrence being deducted, refunded, and deducted
    // again after a cancel/restore cycle, so non-consecutive matches are real history.
    if (signature === previousSignature) {
      duplicateAmountTotal += Number(normalizedEntry.amount) || 0;
      continue;
    }
    previousSignature = signature;
    dedupedHistory.push(normalizedEntry);
  }

  return { history: dedupedHistory, duplicateAmountTotal };
}

function sumHistoryAmounts(history = []) {
  return history.reduce((sum, entry) => sum + (Number(entry?.amount) || 0), 0);
}

function getPackageManualHistory(pkg, lessonIdMap = new Map()) {
  const sourceHistory = Array.isArray(pkg?.manualHistory)
    ? pkg.manualHistory
    : (Array.isArray(pkg?.history) ? pkg.history.filter(entry => !isLessonReason(entry)) : []);

  return sourceHistory.map(entry => {
    if (!entry || typeof entry !== 'object') return null;
    const nextEntry = { ...entry };
    if (nextEntry.lessonId !== undefined && lessonIdMap.has(String(nextEntry.lessonId))) {
      nextEntry.lessonId = lessonIdMap.get(String(nextEntry.lessonId));
    }
    return nextEntry;
  }).filter(Boolean);
}

function normalizePackageEntry(pkg, lessonIdMap = new Map()) {
  if (!pkg || typeof pkg !== 'object') return null;
  const name = (pkg.name || '').trim();
  if (!name) return null;
  const rawCredits = Number.isFinite(pkg.credits) ? pkg.credits : (parseInt(pkg.credits, 10) || 0);
  const rawHistory = Array.isArray(pkg.history) ? pkg.history.map(entry => {
    if (!entry || typeof entry !== 'object') return null;
    const nextEntry = { ...entry };
    if (nextEntry.lessonId !== undefined && lessonIdMap.has(String(nextEntry.lessonId))) {
      nextEntry.lessonId = lessonIdMap.get(String(nextEntry.lessonId));
    }
    return nextEntry;
  }).filter(Boolean) : [];
  const { history: rawNormalizedHistory } = dedupeHistoryEntries(rawHistory);
  const manualHistorySource = getPackageManualHistory({ ...pkg, history: rawNormalizedHistory }, lessonIdMap);
  const { history: manualHistory } = dedupeHistoryEntries(manualHistorySource);
  const openingCredits = Number.isFinite(Number(pkg.openingCredits))
    ? Number(pkg.openingCredits)
    : rawCredits - sumHistoryAmounts(rawNormalizedHistory);
  const credits = openingCredits + sumHistoryAmounts(manualHistory);
  const rawCustomPaymentRate = pkg.customPaymentRate;
  const customPaymentRate = rawCustomPaymentRate === null
    || rawCustomPaymentRate === undefined
    || rawCustomPaymentRate === ''
    ? null
    : Number(rawCustomPaymentRate);
  return {
    ...pkg,
    id: isUuid(pkg.id) ? pkg.id : createUuid(),
    name,
    credits,
    active: pkg.active !== false,
    archivedAt: typeof pkg.archivedAt === 'string' && pkg.archivedAt.trim() ? pkg.archivedAt : null,
    openingCredits,
    manualHistory,
    history: manualHistory,
    customPaymentRate: Number.isFinite(customPaymentRate) ? customPaymentRate : null,
    hasPackageLessons: pkg.hasPackageLessons === true || rawNormalizedHistory.length > 0 || credits !== 0,
  };
}

function normalizeLesson(lesson, lessonIdMap = new Map(), groupMetadataById = new Map()) {
  const normalized = {
    cancelledDates: [],
    deductedDates: [],
    lessonType: 'individual',
    instanceOverrides: {},
    ...lesson
  };

  const oldId = normalized.id;
  normalized.id = isUuid(normalized.id) ? normalized.id : createUuid();
  if (oldId !== undefined && String(oldId) !== normalized.id) {
    lessonIdMap.set(String(oldId), normalized.id);
  }

  if (!Array.isArray(normalized.cancelledDates)) normalized.cancelledDates = [];
  if (!Array.isArray(normalized.deductedDates)) normalized.deductedDates = [];
  normalized.cancelledDates = normalized.cancelledDates.filter(date => typeof date === 'string');
  normalized.deductedDates = normalized.deductedDates.filter(date => typeof date === 'string');

  if (normalized.packageMode === undefined) {
    normalized.packageMode = !!(normalized.participants?.length > 0);
  } else {
    normalized.packageMode = normalized.packageMode !== false;
  }

  const legacyGroup = normalized.groupId ? groupMetadataById.get(String(normalized.groupId)) : null;
  normalized.participants = normalizeParticipants(normalized.participants);
  normalized.groupId = null;
  normalized.groupName = (normalized.groupName || legacyGroup?.name || normalized.title || '').trim() || null;
  normalized.groupColor = normalized.groupColor || legacyGroup?.color || null;
  normalized.lessonType = normalized.lessonType || (normalized.participants.length > 0 ? 'group' : 'individual');
  normalized.recurringUntil = normalizeDateString(normalized.recurringUntil);
  normalized.horse = normalized.horse || null;
  normalized.instructor = normalized.instructor || null;

  if (normalized.instanceOverrides && typeof normalized.instanceOverrides === 'object') {
    const cleanedOverrides = {};
    for (const [dateStr, override] of Object.entries(normalized.instanceOverrides)) {
      if (!override || typeof override !== 'object') continue;
      const cleanOverride = { ...override };
      const overrideLegacyGroup = cleanOverride.groupId ? groupMetadataById.get(String(cleanOverride.groupId)) : legacyGroup;
      if (Array.isArray(cleanOverride.participants)) {
        cleanOverride.participants = normalizeParticipants(cleanOverride.participants);
      }
      cleanOverride.groupId = null;
      cleanOverride.groupName = (cleanOverride.groupName || overrideLegacyGroup?.name || cleanOverride.title || '').trim() || null;
      cleanOverride.groupColor = cleanOverride.groupColor || overrideLegacyGroup?.color || normalized.groupColor || null;
      cleanedOverrides[dateStr] = cleanOverride;
    }
    normalized.instanceOverrides = cleanedOverrides;
  } else {
    normalized.instanceOverrides = {};
  }

  return normalized;
}

function normalizeAppState(state) {
  const def = defaultData();
  const source = state && typeof state === 'object' ? state : {};
  const lessonIdMap = new Map();
  const rawGroups = Array.isArray(source.groups) ? source.groups : [];
  const groupMetadataById = new Map(
    rawGroups
      .filter(group => group && typeof group === 'object' && group.id !== undefined)
      .map(group => [String(group.id), {
        name: (group.name || '').trim(),
        color: group.color || null,
      }])
  );
  const normalizedState = {
    ...def,
    ...source
  };

  normalizedState.horses = normalizeHorseList(normalizedState.horses);
  normalizedState.lessons = Array.isArray(normalizedState.lessons)
    ? normalizedState.lessons.map(lesson => normalizeLesson(lesson, lessonIdMap, groupMetadataById)).filter(Boolean)
    : [];
  normalizedState.packages = Array.isArray(normalizedState.packages)
    ? normalizedState.packages.map(pkg => normalizePackageEntry(pkg, lessonIdMap)).filter(Boolean)
    : [];
  normalizedState.groups = Array.isArray(normalizedState.groups)
    ? normalizedState.groups
      .filter(group => group && typeof group === 'object')
      .map(group => ({
        ...group,
        id: isUuid(group.id) ? group.id : createUuid(),
        name: (group.name || '').trim(),
        color: group.color || getAutoGroupColor(),
      }))
      .filter(group => group.name)
    : [];
  normalizedState.instructors = (Array.isArray(normalizedState.instructors) ? normalizedState.instructors : [])
    .map(instr => {
      if (typeof instr === 'string') {
        return { name: instr.trim(), color: getAutoInstructorColor(normalizedState) };
      }
      return {
        name: (instr?.name || '').trim(),
        color: instr?.color || getAutoInstructorColor(normalizedState)
      };
    })
    .filter(instr => instr.name);
  normalizedState.closedDates = Array.isArray(normalizedState.closedDates)
    ? normalizedState.closedDates.filter(date => typeof date === 'string')
    : [];
  normalizedState.expenses = Array.isArray(normalizedState.expenses)
    ? normalizedState.expenses.map(expense => ({
        id: isUuid(expense.id) ? expense.id : createUuid(),
        title: expense.title || '',
        cost: Number(expense.cost) || 0,
        date: expense.date || formatDate(new Date()),
        description: expense.description || '',
      }))
    : [];
  normalizedState.incomes = Array.isArray(normalizedState.incomes)
    ? normalizedState.incomes.map(income => ({
        id: isUuid(income.id) ? income.id : createUuid(),
        title: income.title || '',
        cost: Number(income.cost || income.amount) || 0,
        date: income.date || formatDate(new Date()),
        description: income.description || '',
      }))
    : [];

  syncReferenceEntriesFromLessons(normalizedState);
  recomputePackageCreditState(normalizedState);

  return normalizedState;
}

function buildDerivedLessonHistoryByPackage(state, now = new Date()) {
  const historyByPackage = new Map();

  const pushEntry = (packageName, entry) => {
    const key = (packageName || '').trim().toLowerCase();
    if (!key) return;
    if (!historyByPackage.has(key)) historyByPackage.set(key, []);
    historyByPackage.get(key).push(entry);
  };

  const buildInstanceEntry = (lesson, dateStr, instanceLesson) => {
    const startMinute = Number(instanceLesson.startMinute) || 0;
    const durationMinutes = Number(instanceLesson.durationMinutes) || 0;
    const instanceEnd = parseDate(dateStr);
    instanceEnd.setMinutes(instanceEnd.getMinutes() + startMinute + durationMinutes);
    if (instanceEnd >= now) return;
    if (Array.isArray(lesson.cancelledDates) && lesson.cancelledDates.includes(dateStr)) return;

    if (Array.isArray(instanceLesson.participants) && instanceLesson.participants.length > 0) {
      const uniqueNames = [...new Set(
        instanceLesson.participants
          .filter(participant => participant?.packageMode !== false)
          .map(participant => (participant?.packageName || participant?.name || '').trim())
          .filter(Boolean)
      )];
      for (const name of uniqueNames) {
        pushEntry(name, {
          date: instanceEnd.toISOString(),
          amount: -1,
          reason: 'lesson',
          lessonDate: dateStr,
          lessonStartMinute: startMinute,
          lessonId: lesson.id,
          derived: true,
        });
      }
      return;
    }

    if (instanceLesson.packageMode === false) return;
    const packageName = (instanceLesson.title || lesson.title || '').trim();
    if (!packageName) return;
    pushEntry(packageName, {
      date: instanceEnd.toISOString(),
      amount: -1,
      reason: 'lesson',
      lessonDate: dateStr,
      lessonStartMinute: startMinute,
      lessonId: lesson.id,
      derived: true,
    });
  };

  const getInstanceLesson = (lesson, dateStr) => {
    const override = lesson.instanceOverrides?.[dateStr];
    return override ? { ...lesson, ...override } : lesson;
  };

  for (const lesson of state.lessons || []) {
    if (!lesson.recurring) {
      buildInstanceEntry(lesson, lesson.date, lesson);
      continue;
    }

    if (lesson.recurringUntil && lesson.date > lesson.recurringUntil) continue;
    let currentInstance = parseDate(lesson.date);
    const recurrenceEnd = lesson.recurringUntil ? parseDate(lesson.recurringUntil) : now;
    const loopEnd = recurrenceEnd < now ? recurrenceEnd : now;

    while (currentInstance <= loopEnd) {
      const dateStr = formatDate(currentInstance);
      const instanceLesson = getInstanceLesson(lesson, dateStr);
      buildInstanceEntry(lesson, dateStr, instanceLesson);
      currentInstance.setDate(currentInstance.getDate() + 7);
    }
  }

  return historyByPackage;
}

function recomputePackageCreditState(state) {
  const derivedHistoryByPackage = buildDerivedLessonHistoryByPackage(state);

  for (const pkg of state.packages || []) {
    const manualHistory = getPackageManualHistory(pkg);
    const derivedHistory = derivedHistoryByPackage.get((pkg.name || '').trim().toLowerCase()) || [];
    const combinedHistory = [...manualHistory, ...derivedHistory].sort((a, b) => {
      const timeDiff = new Date(a.date).getTime() - new Date(b.date).getTime();
      if (timeDiff !== 0) return timeDiff;
      const lessonDateA = a.lessonDate || '';
      const lessonDateB = b.lessonDate || '';
      if (lessonDateA !== lessonDateB) return lessonDateA.localeCompare(lessonDateB);
      const minuteA = Number(a.lessonStartMinute) || 0;
      const minuteB = Number(b.lessonStartMinute) || 0;
      if (minuteA !== minuteB) return minuteA - minuteB;
      return String(a.reason || '').localeCompare(String(b.reason || ''));
    });

    let runningCredits = Number(pkg.openingCredits) || 0;
    pkg.manualHistory = manualHistory;
    pkg.history = combinedHistory.map(entry => {
      const amount = Number(entry.amount) || 0;
      const nextEntry = {
        ...entry,
        before: runningCredits,
        after: runningCredits + amount,
      };
      runningCredits += amount;
      return nextEntry;
    });
    pkg.credits = runningCredits;
  }
}

function syncReferenceEntriesFromLessons(state) {
  const horseSet = new Set(normalizeHorseList(state.horses));
  const instructorMap = new Map(
    (Array.isArray(state.instructors) ? state.instructors : [])
      .filter(instr => instr?.name)
      .map(instr => [instr.name.toLowerCase(), instr])
  );

  const addHorseName = (horseName) => {
    const trimmed = (horseName || '').trim();
    if (!trimmed || horseSet.has(trimmed)) return;
    horseSet.add(trimmed);
  };

  const addInstructorName = (instructorName) => {
    const trimmed = (instructorName || '').trim();
    if (!trimmed || instructorMap.has(trimmed.toLowerCase())) return;
    const next = { name: trimmed, color: getAutoInstructorColor({ instructors: [...instructorMap.values()] }) };
    instructorMap.set(trimmed.toLowerCase(), next);
  };

  const collectFromLesson = (lesson) => {
    addHorseName(lesson?.horse);
    addInstructorName(lesson?.instructor);
    for (const participant of lesson?.participants || []) {
      addHorseName(participant?.horse);
    }
    if (lesson?.instanceOverrides && typeof lesson.instanceOverrides === 'object') {
      for (const override of Object.values(lesson.instanceOverrides)) {
        addHorseName(override?.horse);
        addInstructorName(override?.instructor);
        for (const participant of override?.participants || []) {
          addHorseName(participant?.horse);
        }
      }
    }
  };

  for (const lesson of state.lessons || []) {
    collectFromLesson(lesson);
  }

  state.horses = [...horseSet];
  state.instructors = [...instructorMap.values()];
}

function setDataState(nextState, { persisted = false, pending = _hasPendingLocalChanges } = {}) {
  _data = normalizeAppState(nextState);
  if (persisted) {
    _persistedData = deepClone(_data);
  }
  _hasPendingLocalChanges = pending;
  persistLocalState({ pending });
}

function getAutoInstructorColor(state) {
  const colors = GROUP_COLORS;
  const count = (state?.instructors || []).length;
  return colors[count % colors.length];
}

function isStateEffectivelyEmpty(state) {
  if (!state) return true;
  return (
    (!state.lessons || state.lessons.length === 0) &&
    (!state.packages || state.packages.length === 0) &&
    (!state.groups || state.groups.length === 0) &&
    (!state.closedDates || state.closedDates.length === 0) &&
    (!state.expenses || state.expenses.length === 0) &&
    (!state.horses || state.horses.length === 0) &&
    (!state.instructors || state.instructors.length === 0)
  );
}

async function fetchRemoteRows(table) {
  const { data, error } = await supabase.from(table).select('*');
  if (error) {
    // If the table doesn't exist yet (e.g. expenses before migration), return empty
    if (error.code === '42P01' || error.message?.includes('does not exist')) {
      console.warn(`[store] Table '${table}' not found, returning empty`);
      return [];
    }
    throw error;
  }
  return data || [];
}



function clearMeta() {
  _meta.horses.clear();
  _meta.instructors.clear();
  _meta.settings.clear();
}

function buildRemoteState(rows) {
  clearMeta();

  const horses = (rows.horses || [])
    .map(row => {
      const name = (row.name || '').trim();
      if (!name) return null;
      _meta.horses.set(name, { id: row.id });
      return name;
    })
    .filter(Boolean);

  const instructors = (rows.instructors || [])
    .map(row => {
      const name = (row.name || '').trim();
      if (!name) return null;
      _meta.instructors.set(name, { id: row.id });
      return { name, color: row.color || getAutoInstructorColor({ instructors: rows.instructors || [] }) };
    })
    .filter(Boolean);

  const horseNameById = new Map((rows.horses || []).map(row => [row.id, row.name]));
  const instructorNameById = new Map((rows.instructors || []).map(row => [row.id, row.name]));

  const lessons = (rows.lessons || []).map(row => normalizeLesson({
    id: row.id,
    title: row.title,
    date: row.date,
    startMinute: row.start_minute,
    durationMinutes: row.duration_minutes,
    horse: row.horse_name || horseNameById.get(row.horse_id) || null,
    instructor: row.instructor_name || instructorNameById.get(row.instructor_id) || null,
    recurring: row.recurring === true,
    recurringUntil: row.recurring_until,
    lessonType: row.lesson_type || 'individual',
    packageMode: row.package_mode !== false,
    groupName: row.group_name || null,
    groupColor: row.group_color || null,
    participants: Array.isArray(row.participants) ? row.participants : [],
    cancelledDates: Array.isArray(row.cancelled_dates) ? row.cancelled_dates : [],
    deductedDates: Array.isArray(row.deducted_dates) ? row.deducted_dates : [],
    instanceOverrides: row.instance_overrides && typeof row.instance_overrides === 'object' ? row.instance_overrides : {},
  }));

  const packages = (rows.packages || []).map(row => normalizePackageEntry({
    id: row.id,
    name: row.name,
    credits: row.credits,
    active: row.active,
    archivedAt: row.archived_at,
    history: Array.isArray(row.history) ? row.history : [],
    customPaymentRate: row.custom_payment_rate,
    hasPackageLessons: row.has_package_lessons,
  }));

  const groups = (rows.groups || []).map(row => ({
    id: row.id,
    name: (row.name || '').trim(),
    color: row.color || getAutoGroupColor(),
  })).filter(group => group.name);

  const settingsMap = new Map((rows.settings || []).map(row => {
    _meta.settings.set(row.key, true);
    return [row.key, row.value];
  }));

  const expenses = (rows.expenses || []).map(row => ({
    id: row.id,
    title: row.title || '',
    cost: Number(row.cost) || 0,
    date: row.date || formatDate(new Date()),
    description: row.description || '',
  }));
  const incomes = (rows.incomes || []).map(row => ({
    id: row.id,
    title: row.title || '',
    cost: Number(row.cost || row.amount) || 0,
    date: row.date || formatDate(new Date()),
    description: row.description || '',
  }));

  // Fall back to settings JSON if expenses table is empty (migration scenario)
  const expenseData = expenses.length > 0
    ? expenses
    : (Array.isArray(settingsMap.get('expenses')) ? settingsMap.get('expenses') : []);

  return normalizeAppState({
    horses,
    instructors,
    lessons,
    packages,
    groups,
    closedDates: Array.isArray(settingsMap.get('closed_dates')) ? settingsMap.get('closed_dates') : [],
    expenses: expenseData,
    incomes: incomes,
    nextId: Number(settingsMap.get('legacy_next_id')) || 1,
    nextGroupId: Number(settingsMap.get('legacy_next_group_id')) || 1,
  });
}

async function fetchRemoteSnapshot() {
  const [lessons, packages, instructors, horses, groups, settings, expenses, incomes] = await Promise.all(
    REMOTE_TABLES.map(table => fetchRemoteRows(table))
  );

  const hasData = [lessons, packages, instructors, horses, groups, settings, expenses, incomes].some(rows => rows.length > 0);
  return {
    hasData,
    state: buildRemoteState({ lessons, packages, instructors, horses, groups, settings, expenses, incomes }),
  };
}

function setupRealtime() {
  if (!supabase || _realtimeInitialized) return;
  _realtimeInitialized = true;
  _realtimeChannel = supabase.channel('horsebook-normalized');
  for (const table of REMOTE_TABLES) {
    _realtimeChannel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table },
      () => {
        if (_hasPendingLocalChanges) {
          _needsRemoteRefresh = true;
          return;
        }
        refreshFromRemote();
      }
    );
  }
  _realtimeChannel.subscribe();
}

async function refreshFromRemote() {
  if (!supabase) return;
  try {
    const snapshot = await fetchRemoteSnapshot();
    if (!snapshot.hasData && !_hasPendingLocalChanges) return;
    setDataState(snapshot.state, { persisted: true, pending: false });
    notifyListeners();
  } catch (error) {
    console.error('[store] Realtime refresh failed', error);
  }
}

export async function login(email, password) {
  if (!supabase) return false;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (!error && data.session) {
    _isAdmin = true;
    if (_hasPendingLocalChanges) {
      saveData();
    }
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

  const cachedLocalState = readLocalState();
  const hasPendingLocalCache = readPendingFlag();

  // Instantly populate the store from local cache if it exists.
  // This ensures the UI is populated instantly upon refresh while the 
  // fresh data is being fetched from Supabase in the background.
  if (cachedLocalState) {
    setDataState(cachedLocalState, { pending: hasPendingLocalCache });
  }
  
  // First notification to trigger a render with cached data (or empty state if first load)
  notifyListeners();

  if (!supabase) {
    // If no Supabase, the current state is the persisted state
    setDataState(_data, { persisted: true, pending: false });
    _isLoading = false;
    processPastLessonsForCredits();
    notifyListeners();
    return _data;
  }

  try {
    // Parallelize session check and data fetch to minimize the loading gap
    const [sessionResponse, snapshot] = await Promise.all([
      supabase.auth.getSession(),
      fetchRemoteSnapshot()
    ]);
    
    _isAdmin = !!sessionResponse.data?.session;
    setupRealtime();

    // Reconcile remote data with local state
    if (_isAdmin && hasPendingLocalCache && cachedLocalState) {
      _persistedData = deepClone(snapshot.state);
      setDataState(cachedLocalState, { pending: true });
    } else if (snapshot.hasData) {
      setDataState(snapshot.state, { persisted: true, pending: false });
    } else if (cachedLocalState) {
      setDataState(cachedLocalState, { pending: !!_isAdmin });
      _persistedData = deepClone(createEmptyPersistedState());
    } else {
      setDataState(defaultData(), { persisted: true, pending: false });
    }
  } catch (error) {
    console.error('[store] Failed to load Supabase data', error);
    // Fallback logic consistent with original implementation
    setDataState(cachedLocalState || defaultData(), {
      persisted: !cachedLocalState,
      pending: _isAdmin && !!cachedLocalState,
    });
  }

  _isLoading = false;
  processPastLessonsForCredits();
  notifyListeners();

  if (_isAdmin && _hasPendingLocalChanges) {
    saveData();
  }

  return _data;
}

function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function buildHistorySignatureCounts(history = []) {
  const counts = new Map();
  for (const entry of history) {
    const signature = getHistoryEntrySignature(entry);
    if (!signature) continue;
    counts.set(signature, (counts.get(signature) || 0) + 1);
  }
  return counts;
}

function getHistoryDiff(baseHistory = [], currentHistory = []) {
  const remainingBaseCounts = buildHistorySignatureCounts(baseHistory);
  return currentHistory.filter(entry => {
    const signature = getHistoryEntrySignature(entry);
    if (!signature) return false;
    const remaining = remainingBaseCounts.get(signature) || 0;
    if (remaining > 0) {
      remainingBaseCounts.set(signature, remaining - 1);
      return false;
    }
    return true;
  });
}

function mergeHistory(remoteHistory = [], localEntries = []) {
  const merged = [...remoteHistory];
  for (const entry of localEntries) {
    const normalizedEntry = normalizeHistoryEntry(entry);
    const signature = getHistoryEntrySignature(normalizedEntry);
    if (!signature) continue;
    merged.push(normalizedEntry);
  }
  return merged;
}

function pickMergedField(field, current, base, remote) {
  return jsonEqual(current?.[field], base?.[field]) ? remote?.[field] : current?.[field];
}

function mergePackageState(current, base, remote) {
  if (!remote) return current;
  const currentHistory = getPackageManualHistory(current);
  const baseHistory = getPackageManualHistory(base || {});
  const remoteHistory = getPackageManualHistory(remote);
  const localHistoryDelta = getHistoryDiff(baseHistory, currentHistory);
  const uniqueLocalHistoryDelta = getHistoryDiff(remoteHistory, localHistoryDelta);
  const creditsChangedLocally = !jsonEqual(current?.openingCredits, base?.openingCredits);
  const historyChangedLocally = localHistoryDelta.length > 0 || !jsonEqual(currentHistory, baseHistory);
  const mergedOpeningCredits = creditsChangedLocally ? current.openingCredits : remote.openingCredits;
  const mergedManualHistory = historyChangedLocally ? mergeHistory(remoteHistory, uniqueLocalHistoryDelta) : remoteHistory;

  return normalizePackageEntry({
    ...remote,
    id: current.id,
    name: pickMergedField('name', current, base, remote),
    active: pickMergedField('active', current, base, remote),
    archivedAt: pickMergedField('archivedAt', current, base, remote),
    hasPackageLessons: pickMergedField('hasPackageLessons', current, base, remote),
    customPaymentRate: pickMergedField('customPaymentRate', current, base, remote),
    openingCredits: mergedOpeningCredits,
    credits: (Number(mergedOpeningCredits) || 0) + sumHistoryAmounts(mergedManualHistory),
    history: mergedManualHistory,
    manualHistory: mergedManualHistory,
  });
}

function buildLessonRow(lesson, horseIdByName, instructorIdByName) {
  return {
    id: lesson.id,
    title: lesson.title || '',
    date: lesson.date,
    start_minute: lesson.startMinute,
    duration_minutes: lesson.durationMinutes,
    horse_id: lesson.horse ? (horseIdByName.get(lesson.horse) || null) : null,
    horse_name: lesson.horse || null,
    instructor_id: lesson.instructor ? (instructorIdByName.get(lesson.instructor) || null) : null,
    instructor_name: lesson.instructor || null,
    recurring: lesson.recurring === true,
    recurring_until: lesson.recurringUntil || null,
    lesson_type: lesson.lessonType || 'individual',
    package_mode: lesson.packageMode !== false,
    group_name: lesson.groupName || null,
    group_color: lesson.groupColor || null,
    participants: lesson.participants || [],
    cancelled_dates: lesson.cancelledDates || [],
    deducted_dates: lesson.deductedDates || [],
    instance_overrides: lesson.instanceOverrides || {},
  };
}

function buildPackageRow(pkg) {
  const manualHistory = getPackageManualHistory(pkg);
  return {
    id: pkg.id,
    name: pkg.name,
    credits: (Number(pkg.openingCredits) || 0) + sumHistoryAmounts(manualHistory),
    active: pkg.active !== false,
    archived_at: pkg.archivedAt || null,
    history: manualHistory,
    custom_payment_rate: pkg.customPaymentRate ?? null,
    has_package_lessons: pkg.hasPackageLessons === true,
  };
}

function buildGroupRow(group) {
  return {
    id: group.id,
    name: group.name,
    color: group.color,
  };
}

async function syncHorses(current, persisted) {
  const currentSet = new Set(current.horses || []);
  const persistedSet = new Set(persisted.horses || []);

  for (const horse of currentSet) {
    if (persistedSet.has(horse)) continue;
    const { error } = await supabase.from('horses').insert({ name: horse });
    logAction('ADD_HORSE', { name: horse });
    if (error && error.code !== '23505') throw error;
  }

  for (const horse of persistedSet) {
    if (currentSet.has(horse)) continue;
    const { error } = await supabase.from('horses').delete().eq('name', horse);
    logAction('DELETE_HORSE', { name: horse });
    if (error) throw error;
  }
}

async function syncInstructors(current, persisted) {
  const currentByName = new Map((current.instructors || []).map(instr => [instr.name, instr]));
  const persistedByName = new Map((persisted.instructors || []).map(instr => [instr.name, instr]));

  for (const [name, instr] of currentByName.entries()) {
    const previous = persistedByName.get(name);
    if (!previous) {
      const { error } = await supabase.from('instructors').insert({
        name,
        color: instr.color,
      });
      logAction('ADD_INSTRUCTOR', { name, color: instr.color });
      if (error && error.code !== '23505') throw error;
      continue;
    }
    if (jsonEqual(instr, previous)) continue;
    const { error } = await supabase.from('instructors').update({
      color: instr.color,
    }).eq('name', name);
    logAction('UPDATE_INSTRUCTOR', { name, color: instr.color });
    if (error) throw error;
  }

  for (const [name] of persistedByName.entries()) {
    if (currentByName.has(name)) continue;
    const { error } = await supabase.from('instructors').delete().eq('name', name);
    logAction('DELETE_INSTRUCTOR', { name });
    if (error) throw error;
  }
}

async function syncGroups(current, persisted) {
  const currentById = new Map((current.groups || []).map(group => [group.id, group]));
  const persistedById = new Map((persisted.groups || []).map(group => [group.id, group]));

  for (const [id, group] of currentById.entries()) {
    const previous = persistedById.get(id);
    if (previous && jsonEqual(group, previous)) continue;
    const { error } = await supabase.from('groups').upsert(buildGroupRow(group), { onConflict: 'id' });
    if (error) throw error;
  }

  for (const [id] of persistedById.entries()) {
    if (currentById.has(id)) continue;
    const { error } = await supabase.from('groups').delete().eq('id', id);
    if (error) throw error;
  }
}

async function syncPackages(current, persisted) {
  const currentPackages = current.packages || [];
  const persistedById = new Map((persisted.packages || []).map(pkg => [pkg.id, pkg]));

  for (let index = 0; index < currentPackages.length; index += 1) {
    const pkg = currentPackages[index];
    const previous = persistedById.get(pkg.id);
    if (previous && jsonEqual(pkg, previous)) continue;

    if (!previous) {
      const { data: existingByName, error: existingByNameError } = await supabase
        .from('packages')
        .select('*')
        .eq('name', pkg.name)
        .maybeSingle();
      if (existingByNameError) throw existingByNameError;

      if (existingByName) {
        const remotePkg = normalizePackageEntry({
          id: existingByName.id,
          name: existingByName.name,
          credits: existingByName.credits,
          active: existingByName.active,
          archivedAt: existingByName.archived_at,
          history: existingByName.history,
          customPaymentRate: existingByName.custom_payment_rate,
          hasPackageLessons: existingByName.has_package_lessons,
        });
        const mergedPkg = mergePackageState(pkg, null, remotePkg);
        currentPackages[index] = mergedPkg;
        const { error } = await supabase.from('packages').upsert(buildPackageRow(mergedPkg), { onConflict: 'id' });
        if (error) throw error;
        continue;
      }

      const { error } = await supabase.from('packages').upsert(buildPackageRow(pkg), { onConflict: 'id' });
      if (error) throw error;
      continue;
    }

    const { data: latestRow, error: latestError } = await supabase.from('packages').select('*').eq('id', pkg.id).maybeSingle();
    if (latestError) throw latestError;

    const mergedPkg = mergePackageState(
      pkg,
      previous,
      latestRow ? normalizePackageEntry({
        id: latestRow.id,
        name: latestRow.name,
        credits: latestRow.credits,
        active: latestRow.active,
        archivedAt: latestRow.archived_at,
        history: latestRow.history,
        customPaymentRate: latestRow.custom_payment_rate,
        hasPackageLessons: latestRow.has_package_lessons,
      }) : null
    );

    currentPackages[index] = mergedPkg;

    const { error } = await supabase.from('packages').upsert(buildPackageRow(mergedPkg), { onConflict: 'id' });
    if (error) throw error;
  }

  for (const pkg of persisted.packages || []) {
    if (currentPackages.some(entry => entry.id === pkg.id)) continue;
    const { error } = await supabase.from('packages').delete().eq('id', pkg.id);
    if (error) throw error;
  }
}

async function syncLessons(current, persisted) {
  const horseIdByName = new Map();
  const instructorIdByName = new Map();
  const { data: horseRows, error: horseError } = await supabase.from('horses').select('id,name');
  if (horseError) throw horseError;
  for (const row of horseRows || []) horseIdByName.set(row.name, row.id);
  const { data: instructorRows, error: instructorError } = await supabase.from('instructors').select('id,name');
  if (instructorError) throw instructorError;
  for (const row of instructorRows || []) instructorIdByName.set(row.name, row.id);

  const currentById = new Map((current.lessons || []).map(lesson => [lesson.id, lesson]));
  const persistedById = new Map((persisted.lessons || []).map(lesson => [lesson.id, lesson]));

  for (const [id, lesson] of currentById.entries()) {
    const previous = persistedById.get(id);
    if (previous && jsonEqual(lesson, previous)) continue;
    const { error } = await supabase.from('lessons').upsert(
      buildLessonRow(lesson, horseIdByName, instructorIdByName),
      { onConflict: 'id' }
    );
    if (error) throw error;
  }

  for (const [id] of persistedById.entries()) {
    if (currentById.has(id)) continue;
    const { error } = await supabase.from('lessons').delete().eq('id', id);
    if (error) throw error;
  }
}

async function syncSettings(current, persisted) {
  const currentRows = [
    { key: 'closed_dates', value: current.closedDates || [] },
    { key: 'legacy_next_id', value: current.nextId || 1 },
    { key: 'legacy_next_group_id', value: current.nextGroupId || 1 },
  ];
  const persistedRows = [
    { key: 'closed_dates', value: persisted.closedDates || [] },
    { key: 'legacy_next_id', value: persisted.nextId || 1 },
    { key: 'legacy_next_group_id', value: persisted.nextGroupId || 1 },
  ];
  const persistedMap = new Map(persistedRows.map(row => [row.key, row.value]));

  for (const row of currentRows) {
    if (jsonEqual(row.value, persistedMap.get(row.key))) continue;
    const { error } = await supabase.from('settings').upsert(row, { onConflict: 'key' });
    if (error) throw error;
  }
}

async function syncExpenses(current, persisted) {
  const currentById = new Map((current.expenses || []).map(e => [e.id, e]));
  const persistedById = new Map((persisted.expenses || []).map(e => [e.id, e]));

  for (const [id, expense] of currentById.entries()) {
    const previous = persistedById.get(id);
    if (previous && jsonEqual(expense, previous)) continue;
    const { error } = await supabase.from('expenses').upsert({
      id: expense.id,
      title: expense.title || '',
      cost: expense.cost || 0,
      date: expense.date || formatDate(new Date()),
      description: expense.description || '',
    }, { onConflict: 'id' });
    if (error) throw error;
  }

  for (const [id] of persistedById.entries()) {
    if (currentById.has(id)) continue;
    const { error } = await supabase.from('expenses').delete().eq('id', id);
    if (error) throw error;
  }
}

async function syncIncomes(current, persisted) {
  const currentById = new Map((current.incomes || []).map(e => [e.id, e]));
  const persistedById = new Map((persisted.incomes || []).map(e => [e.id, e]));

  for (const [id, income] of currentById.entries()) {
    const previous = persistedById.get(id);
    if (previous && jsonEqual(income, previous)) continue;
    const { error } = await supabase.from('incomes').upsert({
      id: income.id,
      title: income.title || '',
      amount: income.cost || 0,
      date: income.date || formatDate(new Date()),
      description: income.description || '',
    }, { onConflict: 'id' });
    if (error) throw error;
  }

  for (const [id] of persistedById.entries()) {
    if (currentById.has(id)) continue;
    const { error } = await supabase.from('incomes').delete().eq('id', id);
    if (error) throw error;
  }
}

async function syncToSupabase() {
  await syncHorses(_data, _persistedData);
  await syncInstructors(_data, _persistedData);
  await syncGroups(_data, _persistedData);
  await syncPackages(_data, _persistedData);
  await syncLessons(_data, _persistedData);
  await syncSettings(_data, _persistedData);
  await syncExpenses(_data, _persistedData);
  await syncIncomes(_data, _persistedData);
}

export function saveData({ throwOnError = false } = {}) {
  _isSaving = true;
  notifyListeners();
  _saveChain = _saveChain.then(async () => {
    try {
      _data = normalizeAppState(_data);
      const hasDiff = !jsonEqual(_data, _persistedData);
      // Only admins can have "pending" local changes that need syncing.
      _hasPendingLocalChanges = _isAdmin ? hasDiff : false;
      persistLocalState({ pending: _hasPendingLocalChanges });

      if (!hasDiff) {
        if (_needsRemoteRefresh) {
          _needsRemoteRefresh = false;
          await refreshFromRemote();
        }
        return;
      }

      if (!supabase || !_isAdmin) {
        if (!_isAdmin) {
          console.warn('[store] saveData skipped Supabase sync - no active admin session.');
        }
        return;
      }

      try {
        await syncToSupabase();
        _data = normalizeAppState(_data);
        _persistedData = deepClone(_data);
        _hasPendingLocalChanges = false;
        persistLocalState({ pending: false });
        if (_needsRemoteRefresh) {
          _needsRemoteRefresh = false;
          await refreshFromRemote();
        }
      } catch (error) {
        console.error('[store] Failed to save to Supabase', error);
        _hasPendingLocalChanges = true;
        persistLocalState({ pending: true });
        dispatchStoreError(error?.message ? t('syncFailed', { error: error.message }) : t('syncConnectionError'));
        if (throwOnError) {
          throw error;
        }
      }
    } finally {
      _isSaving = false;
      notifyListeners();
    }
  });

  return _saveChain;
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
      customPaymentRate: null,
      hasPackageLessons: !!hasPackageLessons
    });
    logAction('ADD_PACKAGE', { name: trimmed });
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
    logAction('SET_PACKAGE_ACTIVE', { id: pkg.id, active: true });
    changed = true;
  }
  if (pkg.hasPackageLessons !== true && hasPackageLessons) {
    pkg.hasPackageLessons = true;
    changed = true;
  }
  if (typeof pkg.archivedAt !== 'string' && pkg.active !== false) {
    pkg.archivedAt = null;
  }
  if (!Number.isFinite(Number(pkg.customPaymentRate))) {
    pkg.customPaymentRate = null;
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

  d.packages = d.packages.map(pkg => normalizePackageEntry(pkg)).filter(Boolean);

  const registerClient = (name, hasPackageLessons) => {
    if (ensurePackageEntryState(name, { hasPackageLessons, reactivate: false })) {
      changed = true;
    }
  };

  for (const lesson of d.lessons || []) {
    if (lesson.lessonType === 'custom') continue;
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

export function addLesson(lesson, { save = true } = {}) {
  const d = getData();
  const newLesson = normalizeLesson({
    id: generateId(),
    ...lesson
  });
  d.lessons.push(newLesson);
  logAction('ADD_LESSON', newLesson);
  if (save) saveData();
  return newLesson;
}

export function updateLesson(id, updates, { save = true } = {}) {
  const d = getData();
  const idx = d.lessons.findIndex(lesson => lesson.id === id);
  if (idx >= 0) {
    d.lessons[idx] = normalizeLesson({ ...d.lessons[idx], ...updates });
    logAction('UPDATE_LESSON', { id, updates });
    if (save) saveData();
  }
}

export function updateLessonInstance(id, dateStr, updates, { save = true } = {}) {
  const d = getData();
  const idx = d.lessons.findIndex(lesson => lesson.id === id);
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
      merged.participants = normalizeParticipants(merged.participants);
    }
    lesson.instanceOverrides[dateStr] = merged;
  }

  if (save) saveData();
}

export function deleteLesson(id) {
  const d = getData();
  const lesson = d.lessons.find(entry => entry.id === id);
  if (!lesson) return;

  d.lessons = d.lessons.filter(entry => entry.id !== id);
  logAction('DELETE_LESSON', { id, title: lesson.title });
  recomputePackageCreditState(d);
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
    if (lesson.recurring && lesson.recurringUntil && dateStr > lesson.recurringUntil) {
      continue;
    }
    if (lesson.date === dateStr) {
      results.push(getInstanceLesson(lesson, dateStr));
    } else if (lesson.recurring) {
      const lessonDate = new Date(lesson.date);
      if (lessonDate.getDay() === targetDay && lessonDate <= targetDate) {
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
  const lesson = d.lessons.find(entry => entry.id === id);
  if (!lesson) return;

  if (!lesson.cancelledDates) lesson.cancelledDates = [];

  if (lesson.cancelledDates.includes(dateStr)) {
    lesson.cancelledDates = lesson.cancelledDates.filter(entry => entry !== dateStr);
  } else {
    lesson.cancelledDates.push(dateStr);
  }
  saveData();
}

export function processPastLessonsForCredits() {
  if (!_data) return;
  const packageSyncChanged = syncPackageEntriesFromLessons();
  const archiveChanged = autoArchiveDormantClients();
  const beforeSnapshot = JSON.stringify(
    (_data.packages || []).map(pkg => ({
      id: pkg.id,
      credits: pkg.credits,
      openingCredits: pkg.openingCredits,
      history: pkg.history,
      manualHistory: pkg.manualHistory,
    }))
  );
  recomputePackageCreditState(_data);
  const afterSnapshot = JSON.stringify(
    (_data.packages || []).map(pkg => ({
      id: pkg.id,
      credits: pkg.credits,
      openingCredits: pkg.openingCredits,
      history: pkg.history,
      manualHistory: pkg.manualHistory,
    }))
  );
  const changed = packageSyncChanged || archiveChanged || beforeSnapshot !== afterSnapshot;

  if (changed) {
    saveData();
  }
}

export function ensurePackageEntry(name, { save = true, hasPackageLessons = false } = {}) {
  const changed = ensurePackageEntryState(name, { hasPackageLessons, reactivate: true });
  if (changed && save) saveData();
}

export function updatePackageCredits(id, credits) {
  const d = getData();
  const pkg = d.packages.find(entry => entry.id === id);
  if (!pkg) return;
  pkg.openingCredits = (Number(credits) || 0) - sumHistoryAmounts(getPackageManualHistory(pkg));
  pkg.hasPackageLessons = true;
  logAction('UPDATE_PACKAGE_CREDITS', { id, credits });
  recomputePackageCreditState(d);
  saveData();
}

export function addPackageCredits(id, amount) {
  const d = getData();
  const pkg = d.packages.find(entry => entry.id === id);
  if (!pkg) return;
  if (!Array.isArray(pkg.manualHistory)) {
    pkg.manualHistory = getPackageManualHistory(pkg);
  }
  pkg.hasPackageLessons = true;
  pkg.manualHistory.push({
    date: new Date().toISOString(),
    amount,
  });
  recomputePackageCreditState(d);
  logAction('ADD_PACKAGE_CREDITS', { id, amount, after: pkg.credits });
  saveData();
}

export function updatePackageCustomPaymentRate(id, value) {
  const d = getData();
  const pkg = d.packages.find(entry => entry.id === id);
  if (!pkg) return false;
  if (value === null || value === undefined || value === '') {
    pkg.customPaymentRate = null;
  } else {
    const parsedValue = Number(value);
    pkg.customPaymentRate = Number.isFinite(parsedValue) ? parsedValue : null;
  }
  logAction('UPDATE_PACKAGE_RATE', { id, rate: pkg.customPaymentRate });
  saveData();
  return true;
}

export function togglePackageActive(id) {
  const d = getData();
  const pkg = d.packages.find(entry => entry.id === id);
  if (pkg) setPackageActive(id, !pkg.active);
}

export function setPackageActive(id, active) {
  const d = getData();
  const pkg = d.packages.find(entry => entry.id === id);
  if (!pkg) return;
  pkg.active = !!active;
  pkg.archivedAt = pkg.active ? null : new Date().toISOString();
  logAction('SET_PACKAGE_ACTIVE', { id, active: pkg.active });
  saveData();
}

export function updatePackageName(id, newName) {
  const d = getData();
  const pkg = d.packages.find(entry => entry.id === id);
  if (!pkg) return false;

  const oldName = pkg.name;
  const trimmedNew = newName.trim();
  if (!trimmedNew || oldName === trimmedNew) return false;
  if (d.packages.some(entry => entry.id !== id && entry.name.toLowerCase() === trimmedNew.toLowerCase())) {
    return false;
  }

  pkg.name = trimmedNew;
  logAction('UPDATE_PACKAGE_NAME', { id, oldName, newName: pkg.name });

  for (const lesson of d.lessons) {
    if (lesson.title && lesson.title.toLowerCase() === oldName.toLowerCase()) {
      lesson.title = pkg.name;
    }
    if (Array.isArray(lesson.participants)) {
      for (const participant of lesson.participants) {
        const packageName = participant.packageName || participant.name || '';
        if (packageName.toLowerCase() === oldName.toLowerCase()) {
          if (participant.packageName) participant.packageName = pkg.name;
          if (participant.name.toLowerCase() === oldName.toLowerCase()) {
            participant.name = pkg.name;
          }
        }
      }
    }
    if (lesson.instanceOverrides) {
      for (const override of Object.values(lesson.instanceOverrides)) {
        if (override.title && override.title.toLowerCase() === oldName.toLowerCase()) {
          override.title = pkg.name;
        }
        if (Array.isArray(override.participants)) {
          for (const participant of override.participants) {
            const packageName = participant.packageName || participant.name || '';
            if (packageName.toLowerCase() === oldName.toLowerCase()) {
              if (participant.packageName) participant.packageName = pkg.name;
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
  d.packages = d.packages.filter(entry => entry.id !== id);
  logAction('DELETE_PACKAGE', { id });
  saveData();
}

export function getPackageByName(name) {
  const d = getData();
  return d.packages.find(entry => entry.name.toLowerCase() === name.trim().toLowerCase());
}

export function deductCredit(name, dateStr, startMinute) {
  const d = getData();
  const pkg = d.packages.find(entry => entry.name.toLowerCase() === name.trim().toLowerCase());
  if (!pkg || !pkg.active) return;
  if (!Array.isArray(pkg.manualHistory)) {
    pkg.manualHistory = getPackageManualHistory(pkg);
  }
  pkg.hasPackageLessons = true;
  pkg.manualHistory.push({
    date: new Date().toISOString(),
    amount: -1,
    reason: 'manual_deduct',
    lessonDate: dateStr,
    lessonStartMinute: startMinute
  });
  recomputePackageCreditState(d);
  saveData();
}

export function addHorse(name) {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const d = getData();
  if (d.horses.includes(trimmed)) return false;
  d.horses.push(trimmed);
  saveData();
  return true;
}

export function deleteHorse(name) {
  const d = getData();
  const next = d.horses.filter(entry => entry !== name);
  if (next.length === d.horses.length) return false;
  d.horses = next;
  saveData();
  return true;
}

export function addInstructor(name) {
  const d = getData();
  const trimmed = name.trim();
  if (!trimmed || d.instructors.find(instr => instr.name.toLowerCase() === trimmed.toLowerCase())) {
    return false;
  }
  const colors = GROUP_COLORS;
  const color = colors[d.instructors.length % colors.length];
  d.instructors.push({ name: trimmed, color });
  saveData();
  return true;
}

export function updateInstructorColor(name, color) {
  const d = getData();
  const instr = d.instructors.find(entry => entry.name === name);
  if (!instr) return;
  instr.color = color;
  saveData();
}

export function deleteInstructor(name) {
  const d = getData();
  d.instructors = d.instructors.filter(entry => entry.name !== name);
  saveData();
}

export const GROUP_COLORS = [
  '#FF1744',
  '#F57C00',
  '#FFD600',
  '#76FF03',
  '#00E676',
  '#00E5FF',
  '#D500F9'
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
  const colorIdx = d.groups.length % GROUP_COLORS.length;
  const group = {
    id: generateGroupId(),
    name: name.trim(),
    color: color || GROUP_COLORS[colorIdx]
  };
  d.groups.push(group);
  if (save) saveData();
  return group;
}

export function updateGroup(id, updates, { save = true } = {}) {
  const d = getData();
  const idx = d.groups.findIndex(group => group.id === id);
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
  return getData().groups.find(group => group.id === id);
}

export function deleteGroup(id) {
  const d = getData();
  d.groups = d.groups.filter(group => group.id !== id);
  d.lessons.forEach(lesson => {
    if (lesson.groupId === id) lesson.groupId = null;
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
    d.closedDates = d.closedDates.filter(entry => entry !== dateStr);
  } else {
    d.closedDates.push(dateStr);
  }
  logAction('TOGGLE_CLOSED_DATE', { date: dateStr, active: d.closedDates.includes(dateStr) });
  saveData();
}

export function importData(importedState) {
  setDataState(importedState, { pending: true });
  logAction('IMPORT_DATA', { timestamp: new Date().toISOString() });
  saveData();
}



export function addExpense(expense) {
  const d = getData();
  const newExpense = {
    id: generateId(),
    title: expense.title || '',
    cost: Number(expense.cost) || 0,
    date: expense.date || formatDate(new Date()),
    description: expense.description || '',
  };
  d.expenses.push(newExpense);
  logAction('ADD_EXPENSE', newExpense);
  saveData();
  return newExpense;
}

export function updateExpense(id, updates) {
  const d = getData();
  const idx = d.expenses.findIndex(e => e.id === id);
  if (idx >= 0) {
    d.expenses[idx] = { ...d.expenses[idx], ...updates };
    logAction('UPDATE_EXPENSE', { id, updates });
    saveData();
  }
}

export function deleteExpense(id) {
  const d = getData();
  d.expenses = d.expenses.filter(e => e.id !== id);
  logAction('DELETE_EXPENSE', { id });
  saveData();
}

export function addIncome(income) {
  const d = getData();
  const newIncome = {
    id: generateId(),
    title: income.title || '',
    cost: Number(income.cost) || 0,
    date: income.date || formatDate(new Date()),
    description: income.description || '',
  };
  d.incomes.push(newIncome);
  logAction('ADD_INCOME', newIncome);
  saveData();
  return newIncome;
}

export function updateIncome(id, updates) {
  const d = getData();
  const idx = d.incomes.findIndex(e => e.id === id);
  if (idx >= 0) {
    d.incomes[idx] = { ...d.incomes[idx], ...updates };
    logAction('UPDATE_INCOME', { id, updates });
    saveData();
  }
}

export function deleteIncome(id) {
  const d = getData();
  d.incomes = d.incomes.filter(e => e.id !== id);
  logAction('DELETE_INCOME', { id });
  saveData();
}

