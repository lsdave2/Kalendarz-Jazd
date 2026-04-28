import { formatDate, parseDate } from './utils.js';
import { supabase } from './supabase.js';
import { t } from './i18n.js';

const LOCAL_DATA_KEY = 'horsebook_data';
const LOCAL_PENDING_KEY = 'horsebook_pending_sync';
const REMOTE_TABLES = ['lessons', 'packages', 'instructors', 'horses', 'groups', 'settings'];

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
    nextId: 1,
    nextGroupId: 1,
  };
}

let _data = defaultData();
let _persistedData = defaultData();
let _isAdmin = false;
let _isLoading = true;
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
      if (!name) return null;
      return { name, horse, packageName, packageMode };
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
  const seen = new Set();
  let duplicateAmountTotal = 0;

  for (const entry of history) {
    const normalizedEntry = normalizeHistoryEntry(entry);
    if (!normalizedEntry) continue;
    const signature = getHistoryEntrySignature(normalizedEntry);
    if (!signature) continue;
    if (seen.has(signature)) {
      duplicateAmountTotal += Number(normalizedEntry.amount) || 0;
      continue;
    }
    seen.add(signature);
    dedupedHistory.push(normalizedEntry);
  }

  return { history: dedupedHistory, duplicateAmountTotal };
}

function normalizePackageEntry(pkg, lessonIdMap = new Map()) {
  if (!pkg || typeof pkg !== 'object') return null;
  const name = (pkg.name || '').trim();
  if (!name) return null;
  const rawCredits = Number.isFinite(pkg.credits) ? pkg.credits : (parseInt(pkg.credits, 10) || 0);
  const hasHistory = Array.isArray(pkg.history) && pkg.history.length > 0;
  const mappedHistory = Array.isArray(pkg.history) ? pkg.history.map(entry => {
    if (!entry || typeof entry !== 'object') return null;
    const nextEntry = { ...entry };
    if (nextEntry.lessonId !== undefined && lessonIdMap.has(String(nextEntry.lessonId))) {
      nextEntry.lessonId = lessonIdMap.get(String(nextEntry.lessonId));
    }
    return nextEntry;
  }).filter(Boolean) : [];
  const { history, duplicateAmountTotal } = dedupeHistoryEntries(mappedHistory);
  const credits = rawCredits - duplicateAmountTotal;
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
    history,
    customPaymentRate: Number.isFinite(customPaymentRate) ? customPaymentRate : null,
    hasPackageLessons: pkg.hasPackageLessons === true || hasHistory || credits !== 0,
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

  syncReferenceEntriesFromLessons(normalizedState);

  return normalizedState;
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
    (!state.horses || state.horses.length === 0) &&
    (!state.instructors || state.instructors.length === 0)
  );
}

async function fetchRemoteRows(table) {
  const { data, error } = await supabase.from(table).select('*');
  if (error) throw error;
  return data || [];
}

async function fetchLegacyAppState() {
  try {
    const { data, error } = await supabase.from('app_state').select('state').eq('id', 1).maybeSingle();
    if (error) throw error;
    return data?.state || null;
  } catch (error) {
    console.warn('[store] Legacy app_state lookup failed', error);
    return null;
  }
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

  return normalizeAppState({
    horses,
    instructors,
    lessons,
    packages,
    groups,
    closedDates: Array.isArray(settingsMap.get('closed_dates')) ? settingsMap.get('closed_dates') : [],
    nextId: Number(settingsMap.get('legacy_next_id')) || 1,
    nextGroupId: Number(settingsMap.get('legacy_next_group_id')) || 1,
  });
}

async function fetchRemoteSnapshot() {
  const [lessons, packages, instructors, horses, groups, settings] = await Promise.all(
    REMOTE_TABLES.map(table => fetchRemoteRows(table))
  );

  const hasData = [lessons, packages, instructors, horses, groups, settings].some(rows => rows.length > 0);
  return {
    hasData,
    state: buildRemoteState({ lessons, packages, instructors, horses, groups, settings }),
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
  notifyListeners();

  const cachedLocalState = readLocalState();
  const hasPendingLocalCache = readPendingFlag();

  if (!supabase) {
    setDataState(cachedLocalState || defaultData(), {
      persisted: true,
      pending: false,
    });
    _isLoading = false;
    processPastLessonsForCredits();
    notifyListeners();
    return _data;
  }

  try {
    const { data: { session } } = await supabase.auth.getSession();
    _isAdmin = !!session;
    setupRealtime();

    let snapshot = await fetchRemoteSnapshot();
    let legacyMigrationState = null;

    if (!snapshot.hasData) {
      const legacyRemoteState = await fetchLegacyAppState();
      if (legacyRemoteState && !isStateEffectivelyEmpty(legacyRemoteState)) {
        legacyMigrationState = normalizeAppState(legacyRemoteState);
      }
    }

    if (hasPendingLocalCache && cachedLocalState) {
      _persistedData = deepClone(snapshot.state);
      setDataState(cachedLocalState, { pending: true });
    } else if (snapshot.hasData) {
      setDataState(snapshot.state, { persisted: true, pending: false });
    } else if (legacyMigrationState) {
      _persistedData = deepClone(createEmptyPersistedState());
      setDataState(legacyMigrationState, { pending: true });
    } else if (cachedLocalState) {
      setDataState(cachedLocalState, { pending: !!_isAdmin });
      _persistedData = deepClone(createEmptyPersistedState());
    } else {
      setDataState(defaultData(), { persisted: true, pending: false });
    }
  } catch (error) {
    console.error('[store] Failed to load Supabase data', error);
    setDataState(cachedLocalState || defaultData(), {
      persisted: !cachedLocalState,
      pending: !!cachedLocalState,
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

function getHistoryDiff(baseHistory = [], currentHistory = []) {
  const baseSet = new Set(baseHistory.map(getHistoryEntrySignature).filter(Boolean));
  return currentHistory.filter(entry => {
    const signature = getHistoryEntrySignature(entry);
    return signature && !baseSet.has(signature);
  });
}

function mergeHistory(remoteHistory = [], localEntries = []) {
  const merged = [...remoteHistory];
  const seen = new Set(remoteHistory.map(getHistoryEntrySignature).filter(Boolean));
  for (const entry of localEntries) {
    const normalizedEntry = normalizeHistoryEntry(entry);
    const signature = getHistoryEntrySignature(normalizedEntry);
    if (!signature || seen.has(signature)) continue;
    merged.push(normalizedEntry);
    seen.add(signature);
  }
  return merged;
}

function pickMergedField(field, current, base, remote) {
  return jsonEqual(current?.[field], base?.[field]) ? remote?.[field] : current?.[field];
}

function mergePackageState(current, base, remote) {
  if (!remote) return current;
  const currentHistory = current.history || [];
  const baseHistory = base?.history || [];
  const remoteHistory = remote.history || [];
  const localHistoryDelta = getHistoryDiff(baseHistory, currentHistory);
  const uniqueLocalHistoryDelta = getHistoryDiff(remoteHistory, localHistoryDelta);
  const localCreditsDelta = (current.credits || 0) - (base?.credits || 0);
  const creditsChangedLocally = !jsonEqual(current.credits, base?.credits);
  const historyChangedLocally = localHistoryDelta.length > 0 || !jsonEqual(currentHistory, baseHistory);
  const uniqueLocalCreditsDelta = uniqueLocalHistoryDelta.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);

  let mergedCredits = remote.credits;
  if (creditsChangedLocally && !historyChangedLocally) {
    mergedCredits = current.credits;
  } else if (creditsChangedLocally) {
    mergedCredits = (Number(remote.credits) || 0) + uniqueLocalCreditsDelta;
    if (uniqueLocalHistoryDelta.length === 0 && localCreditsDelta !== 0) {
      mergedCredits = remote.credits;
    }
  }

  return normalizePackageEntry({
    ...remote,
    id: current.id,
    name: pickMergedField('name', current, base, remote),
    active: pickMergedField('active', current, base, remote),
    archivedAt: pickMergedField('archivedAt', current, base, remote),
    hasPackageLessons: pickMergedField('hasPackageLessons', current, base, remote),
    customPaymentRate: pickMergedField('customPaymentRate', current, base, remote),
    credits: mergedCredits,
    history: historyChangedLocally ? mergeHistory(remoteHistory, uniqueLocalHistoryDelta) : remoteHistory,
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
  return {
    id: pkg.id,
    name: pkg.name,
    credits: pkg.credits || 0,
    active: pkg.active !== false,
    archived_at: pkg.archivedAt || null,
    history: pkg.history || [],
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
    if (error && error.code !== '23505') throw error;
  }

  for (const horse of persistedSet) {
    if (currentSet.has(horse)) continue;
    const { error } = await supabase.from('horses').delete().eq('name', horse);
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
      if (error && error.code !== '23505') throw error;
      continue;
    }
    if (jsonEqual(instr, previous)) continue;
    const { error } = await supabase.from('instructors').update({
      color: instr.color,
    }).eq('name', name);
    if (error) throw error;
  }

  for (const [name] of persistedByName.entries()) {
    if (currentByName.has(name)) continue;
    const { error } = await supabase.from('instructors').delete().eq('name', name);
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

async function syncToSupabase() {
  await syncHorses(_data, _persistedData);
  await syncInstructors(_data, _persistedData);
  await syncGroups(_data, _persistedData);
  await syncPackages(_data, _persistedData);
  await syncLessons(_data, _persistedData);
  await syncSettings(_data, _persistedData);
}

export function saveData({ throwOnError = false } = {}) {
  notifyListeners();
  _saveChain = _saveChain.then(async () => {
    _data = normalizeAppState(_data);
    const hasDiff = !jsonEqual(_data, _persistedData);
    _hasPendingLocalChanges = hasDiff;
    persistLocalState({ pending: hasDiff });

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
  });

  return _saveChain;
}

async function clearRemoteNormalizedTables() {
  const deleteAllById = async (table, key) => {
    const { error } = await supabase.from(table).delete().not(key, 'is', null);
    if (error) throw error;
  };

  await deleteAllById('lessons', 'id');
  await deleteAllById('packages', 'id');
  await deleteAllById('groups', 'id');
  await deleteAllById('instructors', 'id');
  await deleteAllById('horses', 'id');
  await deleteAllById('settings', 'key');
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
  if (save) saveData();
  return newLesson;
}

export function updateLesson(id, updates, { save = true } = {}) {
  const d = getData();
  const idx = d.lessons.findIndex(lesson => lesson.id === id);
  if (idx >= 0) {
    d.lessons[idx] = normalizeLesson({ ...d.lessons[idx], ...updates });
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

  const affectedClientNames = [];
  if (Array.isArray(lesson.participants) && lesson.participants.length > 0) {
    lesson.participants.forEach(participant => {
      const name = (participant.packageName || participant.name || '').trim();
      if (name) affectedClientNames.push(name.toLowerCase());
    });
  } else if (lesson.title) {
    affectedClientNames.push(lesson.title.trim().toLowerCase());
  }

  const uniqueClients = [...new Set(affectedClientNames)];
  for (const clientName of uniqueClients) {
    const pkg = d.packages.find(entry => entry.name.toLowerCase() === clientName);
    if (pkg && pkg.history) {
      let creditDelta = 0;
      const originalHistoryLength = pkg.history.length;

      pkg.history = pkg.history.filter(record => {
        if (!isLessonReason(record)) return true;

        const isIdMatch = record.lessonId === id;
        const isLegacyMatch = !record.lessonId
          && record.lessonDate
          && (lesson.date === record.lessonDate || (lesson.deductedDates && lesson.deductedDates.includes(record.lessonDate)))
          && record.lessonStartMinute === lesson.startMinute;

        if (isIdMatch || isLegacyMatch) {
          creditDelta -= record.amount;
          return false;
        }
        return true;
      });

      if (pkg.history.length !== originalHistoryLength) {
        pkg.credits += creditDelta;
      }
    }
  }

  d.lessons = d.lessons.filter(entry => entry.id !== id);
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
            .map(participant => (participant?.packageName || participant?.name || '').trim())
            .filter(Boolean)
        )];
        if (uniqueNames.length === 0) return;
        if (isPast && !isCancelled && !isDeducted) {
          for (const name of uniqueNames) {
            const pkg = _data.packages.find(entry => entry.name.toLowerCase() === name.toLowerCase());
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
            const pkg = _data.packages.find(entry => entry.name.toLowerCase() === name.toLowerCase());
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
          lesson.deductedDates = lesson.deductedDates.filter(entry => entry !== dStr);
          changed = true;
        }
        return;
      }

      if (instanceLesson.packageMode === false) return;

      const pkg = _data.packages.find(entry => entry.name.toLowerCase() === lesson.title.toLowerCase());
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
        lesson.deductedDates = lesson.deductedDates.filter(entry => entry !== dStr);
        changed = true;
      }
    };

    if (!lesson.recurring) {
      checkInstance(lesson.date, lesson);
    } else {
      if (lesson.recurringUntil && lesson.date > lesson.recurringUntil) continue;
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

export function ensurePackageEntry(name, { save = true, hasPackageLessons = false } = {}) {
  const changed = ensurePackageEntryState(name, { hasPackageLessons, reactivate: true });
  if (changed && save) saveData();
}

export function updatePackageCredits(id, credits) {
  const d = getData();
  const pkg = d.packages.find(entry => entry.id === id);
  if (!pkg) return;
  pkg.credits = credits;
  pkg.hasPackageLessons = true;
  saveData();
}

export function addPackageCredits(id, amount) {
  const d = getData();
  const pkg = d.packages.find(entry => entry.id === id);
  if (!pkg) return;
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
  saveData();
}

export function importData(importedState) {
  setDataState(importedState, { pending: true });
  saveData();
}

export async function migrateLegacyAppState() {
  if (!supabase) {
    throw new Error('Supabase is not configured.');
  }
  if (!_isAdmin) {
    throw new Error('You must be logged in as admin.');
  }

  const legacyRemoteState = await fetchLegacyAppState();
  if (!legacyRemoteState || isStateEffectivelyEmpty(legacyRemoteState)) {
    throw new Error('Legacy app_state is empty or missing.');
  }

  await clearRemoteNormalizedTables();
  _persistedData = deepClone(createEmptyPersistedState());
  setDataState(normalizeAppState(legacyRemoteState), { pending: true });
  notifyListeners();
  await saveData({ throwOnError: true });
  await refreshFromRemote();

  return {
    lessons: _data.lessons.length,
    packages: _data.packages.length,
    horses: _data.horses.length,
    instructors: _data.instructors.length,
    groups: _data.groups.length,
  };
}
