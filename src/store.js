import { formatDate, parseDate } from './utils.js';
import { supabase } from './supabase.js';
import { t } from './i18n.js';
import { resolveAdminLoginEmail } from './services/AdminIdentityService.js';

const LOCAL_DATA_KEY = 'horsebook_data';
const LOCAL_PENDING_KEY = 'horsebook_pending_sync';
const REMOTE_TABLES = ['lessons', 'packages', 'package_transactions', 'instructors', 'horses', 'groups', 'settings', 'expenses', 'incomes'];
const DEFAULT_CREDIT_TRACKING_MIGRATED_AT = '2026-05-12T00:00:00.000Z';
const CLOUD_SAVE_TIMEOUT_MS = 10000;
const SYNC_SCOPE_FULL = 'full';
const SYNC_SCOPE_LESSONS = 'lessons';
const LESSON_SYNC_KEYS = new Set(['lessons', 'packages', 'packageTransactions']);

const defaultData = () => ({
  horses: ['Rubin', 'Czempion', 'Cera', 'Muminek', 'Kadet', 'Sakwa', 'Fason', 'Carewicz', 'Grot', 'Siwa', 'Figa'],
  instructors: [
    { name: 'Ania', color: '#FF5722' },
    { name: 'Olga', color: '#4CAF50' }
  ],
  lessons: [],
  packages: [],
  packageTransactions: [],
  groups: [],
  closedDates: [],
  expenses: [],
  incomes: [],
  creditTrackingMigratedAt: DEFAULT_CREDIT_TRACKING_MIGRATED_AT,
  recurringChainMigratedAt: null,
  nextId: 1,
  nextGroupId: 1,
});

function createEmptyPersistedState() {
  return {
    horses: [],
    instructors: [],
    lessons: [],
    packages: [],
    packageTransactions: [],
    groups: [],
    closedDates: [],
    expenses: [],
    incomes: [],
    creditTrackingMigratedAt: DEFAULT_CREDIT_TRACKING_MIGRATED_AT,
    recurringChainMigratedAt: null,
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
let _dataRevision = 0;
let _pendingSaveJobs = 0;
let _realtimeChannel = null;
let _realtimeInitialized = false;
let _needsRemoteRefresh = false;
let _preserveRemoteLessonsDuringNextSync = false;
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
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
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

function dispatchStoreWarning(message) {
  window.dispatchEvent(new CustomEvent('store-error', {
    detail: { message, type: 'warning' }
  }));
}

class CloudSyncTimeoutError extends Error {
  constructor() {
    super(t('syncTimeout'));
    this.name = 'CloudSyncTimeoutError';
  }
}

async function withCloudTimeout(queryOrPromise) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timeoutId;
  try {
    const executable = controller && typeof queryOrPromise?.abortSignal === 'function'
      ? queryOrPromise.abortSignal(controller.signal)
      : queryOrPromise;
    return await Promise.race([
      executable,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          controller?.abort();
          reject(new CloudSyncTimeoutError());
        }, CLOUD_SAVE_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    if (error?.name === 'AbortError' || controller?.signal?.aborted) {
      throw new CloudSyncTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function getSyncFailureMessage(error) {
  if (error instanceof CloudSyncTimeoutError || error?.name === 'CloudSyncTimeoutError') {
    return t('syncTimeout');
  }

  const code = String(error?.code || error?.status || '');
  const message = String(error?.message || '').toLowerCase();

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return t('syncOffline');
  }
  if (code === '401' || code === '403' || message.includes('jwt') || message.includes('session')) {
    return t('syncAuthExpired');
  }
  if (code === '42501' || message.includes('row-level security') || message.includes('permission denied')) {
    return t('syncPermissionDenied');
  }
  if (code === '42P01' || code === '42703' || message.includes('does not exist') || message.includes('schema')) {
    return t('syncSchemaMismatch');
  }
  if (['23505', '23503', '23514', '23502'].includes(code)) {
    return t('syncConstraintConflict');
  }
  if (message.includes('failed to fetch') || message.includes('network') || message.includes('load failed')) {
    return t('syncNetworkError');
  }
  if (message.includes(String(t('syncVerificationFailed')).toLowerCase())) {
    return t('syncVerificationFailed');
  }

  return error?.message ? t('syncFailed', { error: error.message }) : t('syncConnectionError');
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

function normalizePackageTransaction(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const packageId = typeof entry.packageId === 'string'
    ? entry.packageId
    : (typeof entry.package_id === 'string' ? entry.package_id : '');
  if (!packageId) return null;

  const dateSource = entry.date || entry.createdAt || entry.created_at || new Date().toISOString();
  const nextEntry = {
    id: isUuid(entry.id) ? entry.id : createUuid(),
    packageId,
    type: String(entry.type || 'correction'),
    amount: Number(entry.amount) || 0,
    lessonId: entry.lessonId || entry.lesson_id || null,
    lessonDate: entry.lessonDate || entry.lesson_date || null,
    lessonStartMinute: Number.isFinite(Number(entry.lessonStartMinute ?? entry.lesson_start_minute))
      ? Number(entry.lessonStartMinute ?? entry.lesson_start_minute)
      : null,
    note: entry.note || null,
    date: new Date(dateSource).toISOString(),
    sourceKey: typeof entry.sourceKey === 'string'
      ? entry.sourceKey
      : (typeof entry.source_key === 'string' ? entry.source_key : null),
  };

  return nextEntry;
}

function normalizePackageEntry(pkg, lessonIdMap = new Map()) {
  if (!pkg || typeof pkg !== 'object') return null;
  const name = (pkg.name || '').trim();
  if (!name) return null;
  const rawCredits = Number.isFinite(Number(pkg.legacyCredits))
    ? Number(pkg.legacyCredits)
    : (Number.isFinite(Number(pkg.credits)) ? Number(pkg.credits) : 0);
  const rawCustomPaymentRate = pkg.customPaymentRate;
  const customPaymentRate = rawCustomPaymentRate === null
    || rawCustomPaymentRate === undefined
    || rawCustomPaymentRate === ''
    ? null
    : Number(rawCustomPaymentRate);
  const rawSyncedCurrentCredits = pkg.syncedCurrentCredits;
  const syncedCurrentCredits = Number.isFinite(Number(rawSyncedCurrentCredits))
    ? Number(rawSyncedCurrentCredits)
    : null;
  const rawCurrentCredits = pkg.currentCredits;
  const currentCredits = Number.isFinite(Number(rawCurrentCredits))
    ? Number(rawCurrentCredits)
    : (syncedCurrentCredits ?? 0);
  return {
    ...pkg,
    id: isUuid(pkg.id) ? pkg.id : createUuid(),
    name,
    credits: currentCredits,
    legacyCredits: rawCredits,
    currentCredits,
    active: pkg.active !== false,
    archivedAt: typeof pkg.archivedAt === 'string' && pkg.archivedAt.trim() ? pkg.archivedAt : null,
    history: Array.isArray(pkg.history) ? pkg.history.map(entry => {
      if (!entry || typeof entry !== 'object') return null;
      const nextEntry = { ...entry };
      if (nextEntry.lessonId !== undefined && lessonIdMap.has(String(nextEntry.lessonId))) {
        nextEntry.lessonId = lessonIdMap.get(String(nextEntry.lessonId));
      }
      return nextEntry;
    }).filter(Boolean) : [],
    syncedCurrentCredits,
    customPaymentRate: Number.isFinite(customPaymentRate) ? customPaymentRate : null,
    hasPackageLessons: pkg.hasPackageLessons === true,
  };
}

function normalizeLesson(lesson, lessonIdMap = new Map(), groupMetadataById = new Map()) {
  const normalized = {
    cancelledDates: [],
    lessonType: 'individual',
    ...lesson
  };

  const oldId = normalized.id;
  normalized.id = isUuid(normalized.id) ? normalized.id : createUuid();
  if (oldId !== undefined && String(oldId) !== normalized.id) {
    lessonIdMap.set(String(oldId), normalized.id);
  }

  if (!Array.isArray(normalized.cancelledDates)) normalized.cancelledDates = [];
  normalized.cancelledDates = normalized.cancelledDates.filter(date => typeof date === 'string');

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
  normalized.recurring = normalized.recurring === true;
  normalized.recurringParentId = isUuid(normalized.recurringParentId || normalized.recurring_parent_id)
    ? (normalized.recurringParentId || normalized.recurring_parent_id)
    : null;
  normalized.recurringUntil = null;
  normalized.horse = normalized.horse || null;
  normalized.instructor = normalized.instructor || null;

  normalized.instanceOverrides = {};

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
  normalizedState.packageTransactions = Array.isArray(normalizedState.packageTransactions)
    ? normalizedState.packageTransactions.map(entry => normalizePackageTransaction(entry)).filter(Boolean)
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
  const normalizedMigratedAt = normalizeDateString(normalizedState.creditTrackingMigratedAt)
    || (typeof normalizedState.creditTrackingMigratedAt === 'string' && normalizedState.creditTrackingMigratedAt.trim()
      ? normalizedState.creditTrackingMigratedAt
      : null);
  normalizedState.creditTrackingMigratedAt = normalizedMigratedAt || DEFAULT_CREDIT_TRACKING_MIGRATED_AT;
  normalizedState.recurringChainMigratedAt = normalizeDateString(normalizedState.recurringChainMigratedAt)
    || (typeof normalizedState.recurringChainMigratedAt === 'string' && normalizedState.recurringChainMigratedAt.trim()
      ? normalizedState.recurringChainMigratedAt
      : null);

  recomputePackageCreditState(normalizedState);

  return normalizedState;
}

function mapPackageTransactionToHistoryRecord(tx) {
  if (!tx) return null;
  let reason = tx.type;
  if (tx.type === 'lesson_use') reason = 'lesson';
  if (tx.type === 'lesson_cancel') reason = 'lesson_cancel';
  if (tx.type === 'manual_deduct') reason = 'manual_deduct';
  return {
    date: tx.date,
    amount: Number(tx.amount) || 0,
    reason,
    lessonId: tx.lessonId || null,
    lessonDate: tx.lessonDate || null,
    lessonStartMinute: tx.lessonStartMinute,
    note: tx.note || null,
    sourceKey: tx.sourceKey || null,
    transactionId: tx.id,
  };
}

function buildTransactionHistoryByPackage(state) {
  const historyByPackage = new Map();
  const sortedTransactions = [...(state.packageTransactions || [])].sort((a, b) => {
    const timeDiff = new Date(a.date).getTime() - new Date(b.date).getTime();
    if (timeDiff !== 0) return timeDiff;
    return String(a.sourceKey || a.id).localeCompare(String(b.sourceKey || b.id));
  });

  for (const tx of sortedTransactions) {
    const key = tx.packageId;
    if (!key) continue;
    if (!historyByPackage.has(key)) historyByPackage.set(key, []);
    const record = mapPackageTransactionToHistoryRecord(tx);
    if (record) historyByPackage.get(key).push(record);
  }

  return historyByPackage;
}

function recomputePackageCreditState(state) {
  const historyByPackage = buildTransactionHistoryByPackage(state);
  for (const pkg of state.packages || []) {
    const transactionHistory = historyByPackage.get(pkg.id) || [];
    let runningCredits = 0;
    pkg.history = transactionHistory.map(entry => {
      const amount = Number(entry.amount) || 0;
      const nextEntry = {
        ...entry,
        before: runningCredits,
        after: runningCredits + amount,
      };
      runningCredits += amount;
      return nextEntry;
    });
    pkg.currentCredits = runningCredits;
    pkg.credits = runningCredits;
  }
}

function getCurrentCreditValue(pkg) {
  return Number.isFinite(Number(pkg?.currentCredits))
    ? Number(pkg.currentCredits)
    : (Number.isFinite(Number(pkg?.credits)) ? Number(pkg.credits) : 0);
}

function getDisplayedPackageCredits(pkg) {
  return getCurrentCreditValue(pkg);
}

function hasUnsyncedPackageCurrentCredits(state) {
  return (state?.packages || []).some(pkg => {
    if (!pkg) return false;
    return getCurrentCreditValue(pkg) !== pkg.syncedCurrentCredits;
  });
}

function markPackageCurrentCreditsSynced(pkg) {
  if (!pkg || typeof pkg !== 'object') return pkg;
  pkg.syncedCurrentCredits = getCurrentCreditValue(pkg);
  return pkg;
}

function preparePackageForSync(pkg, state) {
  const normalizedPkg = normalizePackageEntry(pkg);
  const transientState = {
    lessons: state?.lessons || [],
    packageTransactions: state?.packageTransactions || [],
    creditTrackingMigratedAt: state?.creditTrackingMigratedAt || DEFAULT_CREDIT_TRACKING_MIGRATED_AT,
    packages: [normalizedPkg],
  };
  recomputePackageCreditState(transientState);
  return transientState.packages[0];
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
    recurringParentId: row.recurring_parent_id || null,
    recurringUntil: null,
    lessonType: row.lesson_type || 'individual',
    packageMode: row.package_mode !== false,
    groupName: row.group_name || null,
    groupColor: row.group_color || null,
    participants: Array.isArray(row.participants) ? row.participants : [],
    cancelledDates: Array.isArray(row.cancelled_dates) ? row.cancelled_dates : [],
    instanceOverrides: {},
  }));

  const packages = (rows.packages || []).map(row => normalizePackageEntry({
    id: row.id,
    name: row.name,
    credits: row.credits,
    currentCredits: row.current_credits,
    active: row.active,
    archivedAt: row.archived_at,
    history: Array.isArray(row.history) ? row.history : [],
    syncedCurrentCredits: row.current_credits,
    customPaymentRate: row.custom_payment_rate,
    hasPackageLessons: row.has_package_lessons,
  }));

  const packageTransactions = (rows.package_transactions || [])
    .map(row => normalizePackageTransaction(row))
    .filter(Boolean);

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
    packageTransactions,
    groups,
    recurringChainMigratedAt: settingsMap.get('recurring_chain_migrated_at') || null,
    creditTrackingMigratedAt: settingsMap.get('credit_tracking_migrated_at') || DEFAULT_CREDIT_TRACKING_MIGRATED_AT,
    closedDates: Array.isArray(settingsMap.get('closed_dates')) ? settingsMap.get('closed_dates') : [],
    expenses: expenseData,
    incomes: incomes,
    nextId: Number(settingsMap.get('legacy_next_id')) || 1,
    nextGroupId: Number(settingsMap.get('legacy_next_group_id')) || 1,
  });
}

async function fetchRemoteSnapshot() {
  const [lessons, packages, package_transactions, instructors, horses, groups, settings, expenses, incomes] = await Promise.all(
    REMOTE_TABLES.map(table => fetchRemoteRows(table))
  );

  const hasData = [lessons, packages, package_transactions, instructors, horses, groups, settings, expenses, incomes].some(rows => rows.length > 0);
  return {
    hasData,
    state: buildRemoteState({ lessons, packages, package_transactions, instructors, horses, groups, settings, expenses, incomes }),
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
    if (_hasPendingLocalChanges) {
      _needsRemoteRefresh = true;
      return;
    }
    setDataState(snapshot.state, { persisted: true, pending: false });
    notifyListeners();
  } catch (error) {
    console.error('[store] Realtime refresh failed', error);
  }
}

function scheduleRemoteRefresh() {
  if (!supabase) return;
  setTimeout(() => {
    refreshFromRemote();
  }, 0);
}

export async function login(identifier, password) {
  if (!supabase) return false;
  const email = await resolveAdminLoginEmail(identifier);
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
    const remoteRecurringMigration = snapshot.state?.recurringChainMigratedAt || null;
    const cachedRecurringMigration = cachedLocalState?.recurringChainMigratedAt || null;
    const cachePredatesRecurringMigration = !!remoteRecurringMigration && cachedRecurringMigration !== remoteRecurringMigration;

    if (hasPendingLocalCache && cachedLocalState && !cachePredatesRecurringMigration) {
      _persistedData = deepClone(snapshot.state);
      _preserveRemoteLessonsDuringNextSync = true;
      setDataState(mergeRemoteOnlyLessonsIntoLocal(cachedLocalState, snapshot.state), { pending: true });
      if (!_isAdmin) {
        dispatchStoreWarning(t('syncLoginRequired'));
      }
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

  if (_isAdmin && (_hasPendingLocalChanges || hasUnsyncedPackageCurrentCredits(_data))) {
    saveData();
  }

  return _data;
}

function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function pickMergedField(field, current, base, remote) {
  return jsonEqual(current?.[field], base?.[field]) ? remote?.[field] : current?.[field];
}

function mergePackageState(current, base, remote) {
  if (!remote) return normalizePackageEntry(current);

  const localCurrentCreditsChanged = !!base && getCurrentCreditValue(current) !== getCurrentCreditValue(base);
  const localLegacyCreditsChanged = !!base && Number(current?.legacyCredits ?? current?.credits) !== Number(base?.legacyCredits ?? base?.credits);

  return normalizePackageEntry({
    ...remote,
    id: current.id,
    name: pickMergedField('name', current, base, remote),
    active: pickMergedField('active', current, base, remote),
    archivedAt: pickMergedField('archivedAt', current, base, remote),
    hasPackageLessons: pickMergedField('hasPackageLessons', current, base, remote),
    customPaymentRate: pickMergedField('customPaymentRate', current, base, remote),
    credits: localLegacyCreditsChanged
      ? Number(current?.legacyCredits ?? current?.credits) || 0
      : Number(remote?.legacyCredits ?? remote?.credits) || 0,
    currentCredits: localCurrentCreditsChanged
      ? getCurrentCreditValue(current)
      : getCurrentCreditValue(remote),
    syncedCurrentCredits: remote?.syncedCurrentCredits ?? getCurrentCreditValue(remote),
  });
}

function mergeRemoteOnlyLessonsIntoLocal(localState, remoteState) {
  const mergedState = normalizeAppState(localState);
  const localLessonIds = new Set((mergedState.lessons || []).map(lesson => lesson.id));
  const remoteOnlyLessons = (remoteState?.lessons || [])
    .filter(lesson => lesson?.id && !localLessonIds.has(lesson.id))
    .map(lesson => normalizeLesson(lesson));

  if (remoteOnlyLessons.length > 0) {
    mergedState.lessons = [...(mergedState.lessons || []), ...remoteOnlyLessons];
  }

  return mergedState;
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
    recurring_parent_id: lesson.recurringParentId || null,
    recurring_until: null,
    lesson_type: lesson.lessonType || 'individual',
    package_mode: lesson.packageMode !== false,
    group_name: lesson.groupName || null,
    group_color: lesson.groupColor || null,
    participants: lesson.participants || [],
    cancelled_dates: lesson.cancelledDates || [],
    instance_overrides: {},
  };
}

function buildPackageRow(pkg) {
  return {
    id: pkg.id,
    name: pkg.name,
    credits: Number(pkg.legacyCredits ?? pkg.credits) || 0,
    current_credits: getCurrentCreditValue(pkg),
    active: pkg.active !== false,
    archived_at: pkg.archivedAt || null,
    history: [],
    custom_payment_rate: pkg.customPaymentRate ?? null,
    has_package_lessons: pkg.hasPackageLessons === true,
  };
}

function buildPackageTransactionRow(tx) {
  return {
    id: tx.id,
    package_id: tx.packageId,
    type: tx.type,
    amount: Number(tx.amount) || 0,
    lesson_id: tx.lessonId || null,
    lesson_date: tx.lessonDate || null,
    lesson_start_minute: tx.lessonStartMinute ?? null,
    note: tx.note || null,
    created_at: tx.date,
    source_key: tx.sourceKey || null,
  };
}

function buildGroupRow(group) {
  return {
    id: group.id,
    name: group.name,
    color: group.color,
  };
}

function createSyncMutationLog() {
  return [];
}

function addUpsertVerification(mutations, table, match, expected) {
  mutations.push({ type: 'upsert', table, match, expected });
}

function addDeleteVerification(mutations, table, match) {
  mutations.push({ type: 'delete', table, match });
}

function dbValueEqual(actual, expected) {
  if (expected === null || expected === undefined) {
    return actual === null || actual === undefined;
  }
  if (typeof expected === 'number') {
    return Number(actual) === expected;
  }
  if (typeof expected === 'boolean') {
    return actual === expected;
  }
  if (Array.isArray(expected) || (expected && typeof expected === 'object')) {
    return JSON.stringify(actual ?? null) === JSON.stringify(expected);
  }
  return String(actual ?? '') === String(expected);
}

function dbRowMatchesExpected(row, expected) {
  return Object.entries(expected || {}).every(([key, value]) => dbValueEqual(row?.[key], value));
}

function resolveSyncScope(requestedScope, current, persisted) {
  if (requestedScope !== SYNC_SCOPE_LESSONS) return SYNC_SCOPE_FULL;
  const keys = new Set([...Object.keys(current || {}), ...Object.keys(persisted || {})]);
  for (const key of keys) {
    if (LESSON_SYNC_KEYS.has(key)) continue;
    if (!jsonEqual(current?.[key], persisted?.[key])) {
      return SYNC_SCOPE_FULL;
    }
  }
  return SYNC_SCOPE_LESSONS;
}

async function getLessonForeignKeyMaps(lessons = [], { preferCached = false } = {}) {
  if (!preferCached) {
    const [
      { data: horseRows, error: horseError },
      { data: instructorRows, error: instructorError },
    ] = await Promise.all([
      withCloudTimeout(supabase.from('horses').select('id,name')),
      withCloudTimeout(supabase.from('instructors').select('id,name')),
    ]);
    if (horseError) throw horseError;
    if (instructorError) throw instructorError;
    const horseIdByName = new Map();
    const instructorIdByName = new Map();
    for (const row of horseRows || []) {
      horseIdByName.set(row.name, row.id);
      _meta.horses.set(row.name, { id: row.id });
    }
    for (const row of instructorRows || []) {
      instructorIdByName.set(row.name, row.id);
      _meta.instructors.set(row.name, { id: row.id });
    }
    return { horseIdByName, instructorIdByName };
  }

  const horseIdByName = new Map(Array.from(_meta.horses.entries()).map(([name, meta]) => [name, meta.id]));
  const instructorIdByName = new Map(Array.from(_meta.instructors.entries()).map(([name, meta]) => [name, meta.id]));
  const missingHorseNames = [...new Set(
    lessons
      .map(lesson => lesson?.horse)
      .filter(name => name && !horseIdByName.has(name))
  )];
  const missingInstructorNames = [...new Set(
    lessons
      .map(lesson => lesson?.instructor)
      .filter(name => name && !instructorIdByName.has(name))
  )];

  if (missingHorseNames.length > 0) {
    const { data, error } = await withCloudTimeout(
      supabase.from('horses').select('id,name').in('name', missingHorseNames)
    );
    if (error) throw error;
    for (const row of data || []) {
      horseIdByName.set(row.name, row.id);
      _meta.horses.set(row.name, { id: row.id });
    }
  }

  if (missingInstructorNames.length > 0) {
    const { data, error } = await withCloudTimeout(
      supabase.from('instructors').select('id,name').in('name', missingInstructorNames)
    );
    if (error) throw error;
    for (const row of data || []) {
      instructorIdByName.set(row.name, row.id);
      _meta.instructors.set(row.name, { id: row.id });
    }
  }

  return { horseIdByName, instructorIdByName };
}

async function fetchVerificationRow(table, match) {
  let query = supabase.from(table).select('*');
  for (const [column, value] of Object.entries(match || {})) {
    query = query.eq(column, value);
  }
  const { data, error } = await withCloudTimeout(query.limit(1));
  if (error) throw error;
  return (data || [])[0] || null;
}

async function confirmSupabaseMutations(mutations) {
  for (const mutation of mutations || []) {
    const row = await fetchVerificationRow(mutation.table, mutation.match);
    if (mutation.type === 'delete') {
      if (row) throw new Error(t('syncVerificationFailed'));
      continue;
    }
    if (!row || !dbRowMatchesExpected(row, mutation.expected)) {
      throw new Error(t('syncVerificationFailed'));
    }
  }
}

async function syncHorses(current, persisted, mutations) {
  const currentSet = new Set(current.horses || []);
  const persistedSet = new Set(persisted.horses || []);

  for (const horse of currentSet) {
    if (persistedSet.has(horse)) continue;
    const { error } = await withCloudTimeout(supabase.from('horses').insert({ name: horse }));
    if (error && error.code !== '23505') throw error;
    addUpsertVerification(mutations, 'horses', { name: horse }, { name: horse });
  }

  for (const horse of persistedSet) {
    if (currentSet.has(horse)) continue;
    const { error } = await withCloudTimeout(supabase.from('horses').delete().eq('name', horse));
    if (error) throw error;
    addDeleteVerification(mutations, 'horses', { name: horse });
  }
}

async function syncInstructors(current, persisted, mutations) {
  const currentByName = new Map((current.instructors || []).map(instr => [instr.name, instr]));
  const persistedByName = new Map((persisted.instructors || []).map(instr => [instr.name, instr]));

  for (const [name, instr] of currentByName.entries()) {
    const previous = persistedByName.get(name);
    if (!previous) {
      const { error } = await withCloudTimeout(supabase.from('instructors').insert({
        name,
        color: instr.color,
      }));
      if (error && error.code !== '23505') throw error;
      addUpsertVerification(mutations, 'instructors', { name }, { name, color: instr.color });
      continue;
    }
    if (jsonEqual(instr, previous)) continue;
    const { error } = await withCloudTimeout(supabase.from('instructors').update({
      color: instr.color,
    }).eq('name', name));
    if (error) throw error;
    addUpsertVerification(mutations, 'instructors', { name }, { name, color: instr.color });
  }

  for (const [name] of persistedByName.entries()) {
    if (currentByName.has(name)) continue;
    const { error } = await withCloudTimeout(supabase.from('instructors').delete().eq('name', name));
    if (error) throw error;
    addDeleteVerification(mutations, 'instructors', { name });
  }
}

async function syncGroups(current, persisted, mutations) {
  const currentById = new Map((current.groups || []).map(group => [group.id, group]));
  const persistedById = new Map((persisted.groups || []).map(group => [group.id, group]));

  for (const [id, group] of currentById.entries()) {
    const previous = persistedById.get(id);
    if (previous && jsonEqual(group, previous)) continue;
    const row = buildGroupRow(group);
    const { error } = await withCloudTimeout(supabase.from('groups').upsert(row, { onConflict: 'id' }));
    if (error) throw error;
    addUpsertVerification(mutations, 'groups', { id }, row);
  }

  for (const [id] of persistedById.entries()) {
    if (currentById.has(id)) continue;
    const { error } = await withCloudTimeout(supabase.from('groups').delete().eq('id', id));
    if (error) throw error;
    addDeleteVerification(mutations, 'groups', { id });
  }
}

async function syncPackages(current, persisted, mutations) {
  const currentPackages = current.packages || [];
  const persistedById = new Map((persisted.packages || []).map(pkg => [pkg.id, pkg]));

  for (let index = 0; index < currentPackages.length; index += 1) {
    const pkg = currentPackages[index];
    const previous = persistedById.get(pkg.id);
    if (previous && jsonEqual(pkg, previous) && !hasUnsyncedPackageCurrentCredits({ packages: [pkg] })) continue;

    if (!previous) {
      const { data: existingByName, error: existingByNameError } = await withCloudTimeout(supabase
        .from('packages')
        .select('*')
        .eq('name', pkg.name)
        .maybeSingle());
      if (existingByNameError) throw existingByNameError;

      if (existingByName) {
        const remotePkg = normalizePackageEntry({
          id: existingByName.id,
          name: existingByName.name,
          credits: existingByName.credits,
          active: existingByName.active,
          archivedAt: existingByName.archived_at,
          history: existingByName.history,
          syncedCurrentCredits: existingByName.current_credits,
          customPaymentRate: existingByName.custom_payment_rate,
          hasPackageLessons: existingByName.has_package_lessons,
        });
        const mergedPkg = mergePackageState(pkg, null, remotePkg);
        const syncReadyPkg = preparePackageForSync(mergedPkg, current);
        currentPackages[index] = syncReadyPkg;
        const row = buildPackageRow(syncReadyPkg);
        const { error } = await withCloudTimeout(supabase.from('packages').upsert(row, { onConflict: 'id' }));
        if (error) throw error;
        markPackageCurrentCreditsSynced(syncReadyPkg);
        addUpsertVerification(mutations, 'packages', { id: syncReadyPkg.id }, row);
        continue;
      }

      const syncReadyPkg = preparePackageForSync(pkg, current);
      currentPackages[index] = syncReadyPkg;
      const row = buildPackageRow(syncReadyPkg);
      const { error } = await withCloudTimeout(supabase.from('packages').upsert(row, { onConflict: 'id' }));
      if (error) throw error;
      markPackageCurrentCreditsSynced(syncReadyPkg);
      addUpsertVerification(mutations, 'packages', { id: syncReadyPkg.id }, row);
      continue;
    }

    const { data: latestRow, error: latestError } = await withCloudTimeout(supabase.from('packages').select('*').eq('id', pkg.id).maybeSingle());
    if (latestError) throw latestError;

    const { data: matchingNameRow, error: matchingNameError } = await withCloudTimeout(supabase
      .from('packages')
      .select('*')
      .eq('name', pkg.name)
      .maybeSingle());
    if (matchingNameError) throw matchingNameError;

    const conflictingNameRow = matchingNameRow && matchingNameRow.id !== pkg.id
      ? matchingNameRow
      : null;

    if (conflictingNameRow) {
      const remotePkg = normalizePackageEntry({
        id: conflictingNameRow.id,
        name: conflictingNameRow.name,
        credits: conflictingNameRow.credits,
        active: conflictingNameRow.active,
        archivedAt: conflictingNameRow.archived_at,
        history: conflictingNameRow.history,
        syncedCurrentCredits: conflictingNameRow.current_credits,
        customPaymentRate: conflictingNameRow.custom_payment_rate,
        hasPackageLessons: conflictingNameRow.has_package_lessons,
      });

      // Another device already created this client name with a different id.
      // Adopt the remote id locally, merge manual history, and continue syncing
      // against that shared cloud row to avoid the unique(name) conflict.
      const mergedPkg = normalizePackageEntry({
        ...mergePackageState(pkg, previous, remotePkg),
        id: remotePkg.id,
      });

      const syncReadyPkg = preparePackageForSync(mergedPkg, current);
      currentPackages[index] = syncReadyPkg;

      const row = buildPackageRow(syncReadyPkg);
      const { error } = await withCloudTimeout(supabase.from('packages').upsert(row, { onConflict: 'id' }));
      if (error) throw error;
      markPackageCurrentCreditsSynced(syncReadyPkg);
      addUpsertVerification(mutations, 'packages', { id: syncReadyPkg.id }, row);
      continue;
    }

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
        syncedCurrentCredits: latestRow.current_credits,
        customPaymentRate: latestRow.custom_payment_rate,
        hasPackageLessons: latestRow.has_package_lessons,
      }) : null
    );

    const syncReadyPkg = preparePackageForSync(mergedPkg, current);
    currentPackages[index] = syncReadyPkg;

    const row = buildPackageRow(syncReadyPkg);
    const { error } = await withCloudTimeout(supabase.from('packages').upsert(row, { onConflict: 'id' }));
    if (error) throw error;
    markPackageCurrentCreditsSynced(syncReadyPkg);
    addUpsertVerification(mutations, 'packages', { id: syncReadyPkg.id }, row);
  }

  for (const pkg of persisted.packages || []) {
    if (currentPackages.some(entry => entry.id === pkg.id)) continue;
    const { error } = await withCloudTimeout(supabase.from('packages').delete().eq('id', pkg.id));
    if (error) throw error;
    addDeleteVerification(mutations, 'packages', { id: pkg.id });
  }
}

async function syncLessons(current, persisted, mutations, { preserveRemoteLessons = false, preferCachedForeignKeys = false } = {}) {
  const currentById = new Map((current.lessons || []).map(lesson => [lesson.id, lesson]));
  const persistedById = new Map((persisted.lessons || []).map(lesson => [lesson.id, lesson]));
  const changedLessons = [];

  for (const [id, lesson] of currentById.entries()) {
    const previous = persistedById.get(id);
    if (previous && jsonEqual(lesson, previous)) continue;
    if (preserveRemoteLessons && previous) continue;
    changedLessons.push(lesson);
  }

  const { horseIdByName, instructorIdByName } = await getLessonForeignKeyMaps(changedLessons, {
    preferCached: preferCachedForeignKeys,
  });

  for (const [id, lesson] of currentById.entries()) {
    const previous = persistedById.get(id);
    if (previous && jsonEqual(lesson, previous)) continue;
    if (preserveRemoteLessons && previous) continue;
    const row = buildLessonRow(lesson, horseIdByName, instructorIdByName);
    const { data, error } = await withCloudTimeout(
      supabase
        .from('lessons')
        .upsert(row, { onConflict: 'id' })
        .select('*')
        .maybeSingle()
    );
    if (error) throw error;
    if (!data || !dbRowMatchesExpected(data, row)) {
      throw new Error(t('syncVerificationFailed'));
    }
  }

  for (const [id] of persistedById.entries()) {
    if (currentById.has(id)) continue;
    if (preserveRemoteLessons) continue;
    const { error } = await withCloudTimeout(supabase.from('lessons').delete().eq('id', id));
    if (error) throw error;
    addDeleteVerification(mutations, 'lessons', { id });
  }
}

async function syncSettings(current, persisted, mutations) {
  const currentRows = [
    { key: 'closed_dates', value: current.closedDates || [] },
    { key: 'credit_tracking_migrated_at', value: current.creditTrackingMigratedAt || null },
    { key: 'recurring_chain_migrated_at', value: current.recurringChainMigratedAt || null },
    { key: 'legacy_next_id', value: current.nextId || 1 },
    { key: 'legacy_next_group_id', value: current.nextGroupId || 1 },
  ];
  const persistedRows = [
    { key: 'closed_dates', value: persisted.closedDates || [] },
    { key: 'credit_tracking_migrated_at', value: persisted.creditTrackingMigratedAt || null },
    { key: 'recurring_chain_migrated_at', value: persisted.recurringChainMigratedAt || null },
    { key: 'legacy_next_id', value: persisted.nextId || 1 },
    { key: 'legacy_next_group_id', value: persisted.nextGroupId || 1 },
  ];
  const persistedMap = new Map(persistedRows.map(row => [row.key, row.value]));

  for (const row of currentRows) {
    if (jsonEqual(row.value, persistedMap.get(row.key))) continue;
    const { error } = await withCloudTimeout(supabase.from('settings').upsert(row, { onConflict: 'key' }));
    if (error) throw error;
    addUpsertVerification(mutations, 'settings', { key: row.key }, row);
  }
}

function getPackageTransactionIdentity(tx) {
  return tx?.sourceKey || tx?.id || null;
}

async function syncPackageTransactions(current, persisted, mutations) {
  const validPackageIds = new Set((current.packages || []).map(pkg => pkg.id).filter(Boolean));
  const persistedKeys = new Set(
    (persisted.packageTransactions || [])
      .map(tx => getPackageTransactionIdentity(tx))
      .filter(Boolean)
  );

  for (const tx of current.packageTransactions || []) {
    const identity = getPackageTransactionIdentity(tx);
    if (!identity || persistedKeys.has(identity)) continue;
    if (!validPackageIds.has(tx.packageId)) {
      console.warn('[store] Skipping package transaction with missing package', {
        transactionId: tx.id,
        packageId: tx.packageId,
        type: tx.type,
        lessonId: tx.lessonId,
        sourceKey: tx.sourceKey,
      });
      continue;
    }

    const row = buildPackageTransactionRow(tx);
    const { error } = tx.sourceKey
      ? await withCloudTimeout(supabase.from('package_transactions').upsert(row, {
          onConflict: 'source_key',
          ignoreDuplicates: true,
        }))
      : await withCloudTimeout(supabase.from('package_transactions').insert(row));

    if (error && error.code !== '23505') throw error;
    const expectedRow = { ...row };
    delete expectedRow.created_at;
    addUpsertVerification(
      mutations,
      'package_transactions',
      tx.sourceKey ? { source_key: tx.sourceKey } : { id: tx.id },
      expectedRow
    );
  }
}

async function syncExpenses(current, persisted, mutations) {
  const currentById = new Map((current.expenses || []).map(e => [e.id, e]));
  const persistedById = new Map((persisted.expenses || []).map(e => [e.id, e]));

  for (const [id, expense] of currentById.entries()) {
    const previous = persistedById.get(id);
    if (previous && jsonEqual(expense, previous)) continue;
    const row = {
      id: expense.id,
      title: expense.title || '',
      cost: expense.cost || 0,
      date: expense.date || formatDate(new Date()),
      description: expense.description || '',
    };
    const { error } = await withCloudTimeout(supabase.from('expenses').upsert(row, { onConflict: 'id' }));
    if (error) throw error;
    addUpsertVerification(mutations, 'expenses', { id }, row);
  }

  for (const [id] of persistedById.entries()) {
    if (currentById.has(id)) continue;
    const { error } = await withCloudTimeout(supabase.from('expenses').delete().eq('id', id));
    if (error) throw error;
    addDeleteVerification(mutations, 'expenses', { id });
  }
}

async function syncIncomes(current, persisted, mutations) {
  const currentById = new Map((current.incomes || []).map(e => [e.id, e]));
  const persistedById = new Map((persisted.incomes || []).map(e => [e.id, e]));

  for (const [id, income] of currentById.entries()) {
    const previous = persistedById.get(id);
    if (previous && jsonEqual(income, previous)) continue;
    const row = {
      id: income.id,
      title: income.title || '',
      amount: income.cost || 0,
      date: income.date || formatDate(new Date()),
      description: income.description || '',
    };
    const { error } = await withCloudTimeout(supabase.from('incomes').upsert(row, { onConflict: 'id' }));
    if (error) throw error;
    addUpsertVerification(mutations, 'incomes', { id }, row);
  }

  for (const [id] of persistedById.entries()) {
    if (currentById.has(id)) continue;
    const { error } = await withCloudTimeout(supabase.from('incomes').delete().eq('id', id));
    if (error) throw error;
    addDeleteVerification(mutations, 'incomes', { id });
  }
}

async function syncToSupabase(current, persisted, { preserveRemoteLessons = false, syncScope = SYNC_SCOPE_FULL } = {}) {
  const mutations = createSyncMutationLog();
  const resolvedSyncScope = resolveSyncScope(syncScope, current, persisted);

  if (resolvedSyncScope === SYNC_SCOPE_LESSONS) {
    await syncPackages(current, persisted, mutations);
    await syncLessons(current, persisted, mutations, { preserveRemoteLessons, preferCachedForeignKeys: true });
    await syncPackageTransactions(current, persisted, mutations);
    return mutations;
  }

  await syncHorses(current, persisted, mutations);
  await syncInstructors(current, persisted, mutations);
  await syncGroups(current, persisted, mutations);
  await syncPackages(current, persisted, mutations);
  await syncLessons(current, persisted, mutations, { preserveRemoteLessons });
  await syncPackageTransactions(current, persisted, mutations);
  await syncSettings(current, persisted, mutations);
  await syncExpenses(current, persisted, mutations);
  await syncIncomes(current, persisted, mutations);
  return mutations;
}

export function saveData({ throwOnError = false, syncScope = SYNC_SCOPE_FULL } = {}) {
  _data = normalizeAppState(_data);
  const saveRevision = ++_dataRevision;
  const saveSnapshot = deepClone(_data);
  _pendingSaveJobs += 1;
  _isSaving = true;
  notifyListeners();
  _saveChain = _saveChain.catch(() => {}).then(async () => {
    const isLatestSaveRevision = () => saveRevision === _dataRevision;
    if (!isLatestSaveRevision()) {
      _hasPendingLocalChanges = true;
      persistLocalState({ pending: true });
      return;
    }
    const persistedSnapshot = deepClone(_persistedData);
    const syncState = normalizeAppState(deepClone(saveSnapshot));
    const preserveRemoteLessons = _preserveRemoteLessonsDuringNextSync;

    try {
      const hasDiff = !jsonEqual(syncState, persistedSnapshot) || hasUnsyncedPackageCurrentCredits(syncState);
      _hasPendingLocalChanges = isLatestSaveRevision() ? hasDiff : true;
      persistLocalState({ pending: _hasPendingLocalChanges });

      if (!hasDiff) {
        if (isLatestSaveRevision()) {
          _preserveRemoteLessonsDuringNextSync = false;
        }
        if (isLatestSaveRevision() && _needsRemoteRefresh) {
          _needsRemoteRefresh = false;
          scheduleRemoteRefresh();
        }
        return;
      }

      if (!supabase) {
        dispatchStoreWarning(t('syncUnavailableLocalOnly'));
        return;
      }

      if (!_isAdmin) {
        dispatchStoreWarning(t('syncLoginRequired'));
        if (!_isAdmin) {
          console.warn('[store] saveData skipped Supabase sync - no active admin session.');
        }
        return;
      }

      try {
        const mutations = await syncToSupabase(syncState, persistedSnapshot, { preserveRemoteLessons, syncScope });
        await confirmSupabaseMutations(mutations);
        const persistedSyncState = normalizeAppState(syncState);
        _persistedData = deepClone(persistedSyncState);

        if (isLatestSaveRevision()) {
          _data = persistedSyncState;
          _hasPendingLocalChanges = false;
          persistLocalState({ pending: false });
        } else {
          _hasPendingLocalChanges = true;
          persistLocalState({ pending: true });
        }

        if (isLatestSaveRevision()) {
          const shouldRefreshAfterSave = _preserveRemoteLessonsDuringNextSync || _needsRemoteRefresh;
          _preserveRemoteLessonsDuringNextSync = false;
          _needsRemoteRefresh = false;
          if (shouldRefreshAfterSave) {
            scheduleRemoteRefresh();
          }
        }
      } catch (error) {
        console.error('[store] Failed to save to Supabase', error);
        _hasPendingLocalChanges = true;
        persistLocalState({ pending: true });
        dispatchStoreError(getSyncFailureMessage(error));
        if (throwOnError) {
          throw error;
        }
      }
    } finally {
      _pendingSaveJobs = Math.max(0, _pendingSaveJobs - 1);
      _isSaving = _pendingSaveJobs > 0;
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
      legacyCredits: 0,
      currentCredits: 0,
      syncedCurrentCredits: 0,
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
  if (pkg.active === undefined) {
    pkg.active = true;
    changed = true;
  }
  if (!Number.isFinite(Number(pkg.legacyCredits))) {
    pkg.legacyCredits = Number(pkg.credits) || 0;
    changed = true;
  }
  if (!Number.isFinite(Number(pkg.currentCredits))) {
    pkg.currentCredits = Number(pkg.syncedCurrentCredits ?? pkg.credits) || 0;
    changed = true;
  }
  if (!Number.isFinite(Number(pkg.syncedCurrentCredits))) {
    pkg.syncedCurrentCredits = Number(pkg.currentCredits) || 0;
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

function buildPackageTransactionSourceKey(prefix, occurrenceBase, ordinal = null) {
  return ordinal === null
    ? `${prefix}|${occurrenceBase}`
    : `${prefix}|${occurrenceBase}|${ordinal}`;
}

function buildOccurrenceBaseKey({ packageId, lessonId, lessonDate, lessonStartMinute }) {
  return [
    packageId || '',
    lessonId || '',
    lessonDate || '',
    Number.isFinite(Number(lessonStartMinute)) ? Number(lessonStartMinute) : ''
  ].join('|');
}

function getOccurrenceTransactions(state, occurrence) {
  const targetBase = buildOccurrenceBaseKey(occurrence);
  return (state.packageTransactions || []).filter(tx => {
    if (!tx?.packageId || !tx?.lessonDate) return false;
    if (buildOccurrenceBaseKey(tx) !== targetBase) return false;
    if (tx.type === 'lesson_use' || tx.type === 'lesson_cancel') return true;
    return tx.type === 'correction' && typeof tx.sourceKey === 'string' && (
      tx.sourceKey.startsWith('lesson_restore|')
      || tx.sourceKey.startsWith('lesson_adjust|')
    );
  });
}

function getOccurrenceNetAmount(state, occurrence) {
  return getOccurrenceTransactions(state, occurrence)
    .reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0);
}

function getOccurrenceSourceKeyCount(state, prefix, occurrenceBase) {
  return (state.packageTransactions || []).filter(tx =>
    typeof tx?.sourceKey === 'string' && tx.sourceKey.startsWith(`${prefix}|${occurrenceBase}|`)
  ).length;
}

function appendPackageTransactionState(state, tx, { recompute = true } = {}) {
  const normalized = normalizePackageTransaction(tx);
  if (!normalized) return false;
  const identity = getPackageTransactionIdentity(normalized);
  if (!identity) return false;
  if ((state.packageTransactions || []).some(entry => getPackageTransactionIdentity(entry) === identity)) {
    return false;
  }
  if (!Array.isArray(state.packageTransactions)) {
    state.packageTransactions = [];
  }
  state.packageTransactions.push(normalized);
  if (recompute) {
    recomputePackageCreditState(state);
  }
  return true;
}

function getPackageNamesForLessonCreditUse(lesson) {
  if (!lesson || lesson.lessonType === 'custom') return [];
  const names = Array.isArray(lesson.participants) && lesson.participants.length > 0
    ? lesson.participants
        .filter(participant => participant?.packageMode !== false)
        .map(participant => (participant?.packageName || participant?.name || '').trim())
        .filter(Boolean)
    : ((lesson.packageMode === false)
        ? []
        : [String(lesson.title || '').trim()].filter(Boolean));
  return [...new Set(names)];
}

function lessonHasEnded(lesson, now = new Date()) {
  if (!lesson?.date) return false;
  const start = parseDate(lesson.date);
  start.setMinutes(start.getMinutes() + (Number(lesson.startMinute) || 0));
  const end = new Date(start);
  end.setMinutes(end.getMinutes() + (Number(lesson.durationMinutes) || 0));
  return end < now;
}

function reconcileSavedLessonPackageCredits(state, previousLesson, nextLesson) {
  if (!nextLesson || nextLesson.lessonType === 'custom' || !lessonHasEnded(nextLesson)) return false;

  const previousNames = new Set(getPackageNamesForLessonCreditUse(previousLesson).map(name => name.toLowerCase()));
  const packageByName = new Map(
    (state.packages || []).map(pkg => [String(pkg.name || '').trim().toLowerCase(), pkg]).filter(([key]) => key)
  );
  const desiredNet = Array.isArray(nextLesson.cancelledDates) && nextLesson.cancelledDates.includes(nextLesson.date) ? 0 : -1;
  let changed = false;

  for (const packageName of getPackageNamesForLessonCreditUse(nextLesson)) {
    if (previousNames.has(packageName.toLowerCase())) continue;
    const pkg = packageByName.get(packageName.toLowerCase());
    if (!pkg) continue;
    const occurrence = {
      packageId: pkg.id,
      lessonId: nextLesson.id,
      lessonDate: nextLesson.date,
      lessonStartMinute: Number(nextLesson.startMinute) || 0,
    };
    if (ensureOccurrenceNet(state, occurrence, desiredNet)) {
      changed = true;
    }
  }

  if (changed) {
    recomputePackageCreditState(state);
  }
  return changed;
}

function buildPastPackageOccurrenceMap(state, now = new Date()) {
  const cutoff = new Date(state.creditTrackingMigratedAt || DEFAULT_CREDIT_TRACKING_MIGRATED_AT);
  const packageByName = new Map(
    (state.packages || []).map(pkg => [String(pkg.name || '').trim().toLowerCase(), pkg]).filter(([key]) => key)
  );
  const occurrences = new Map();

  const pushOccurrence = ({ lesson, dateStr, instanceLesson, desiredNet }) => {
    if (instanceLesson?.lessonType === 'custom' || lesson?.lessonType === 'custom') return;
    const startMinute = Number(instanceLesson?.startMinute ?? lesson?.startMinute) || 0;
    const packageNames = getPackageNamesForLessonCreditUse(instanceLesson || lesson);

    for (const packageName of packageNames) {
      const pkg = packageByName.get(packageName.toLowerCase());
      if (!pkg) continue;
      const occurrence = {
        packageId: pkg.id,
        lessonId: lesson.id,
        lessonDate: dateStr,
        lessonStartMinute: startMinute,
      };
      occurrences.set(buildOccurrenceBaseKey(occurrence), {
        ...occurrence,
        desiredNet,
      });
    }
  };

  for (const lesson of state.lessons || []) {
    if (!lesson?.date) continue;
    const durationMinutes = Number(lesson.durationMinutes) || 0;

    const start = parseDate(lesson.date);
    start.setMinutes(start.getMinutes() + (Number(lesson.startMinute) || 0));
    const end = new Date(start);
    end.setMinutes(end.getMinutes() + durationMinutes);
    if (end >= now || end < cutoff) continue;
    const desiredNet = Array.isArray(lesson.cancelledDates) && lesson.cancelledDates.includes(lesson.date) ? 0 : -1;
    pushOccurrence({ lesson, dateStr: lesson.date, instanceLesson: lesson, desiredNet });
  }

  return occurrences;
}

function ensureOccurrenceNet(state, occurrence, desiredNet) {
  const occurrenceBase = buildOccurrenceBaseKey(occurrence);
  const occurrenceTransactions = getOccurrenceTransactions(state, occurrence);
  const currentNet = occurrenceTransactions.reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0);
  if (currentNet === desiredNet) return false;

  const hasBaseUse = occurrenceTransactions.some(tx => tx.type === 'lesson_use');
  let nextTransaction = null;

  if (desiredNet === -1 && currentNet === 0) {
    if (hasBaseUse) {
      const ordinal = getOccurrenceSourceKeyCount(state, 'lesson_restore', occurrenceBase) + 1;
      nextTransaction = {
        id: generateId(),
        packageId: occurrence.packageId,
        type: 'correction',
        amount: -1,
        lessonId: occurrence.lessonId,
        lessonDate: occurrence.lessonDate,
        lessonStartMinute: occurrence.lessonStartMinute,
        note: 'Restore cancelled lesson occurrence',
        date: new Date().toISOString(),
        sourceKey: buildPackageTransactionSourceKey('lesson_restore', occurrenceBase, ordinal),
      };
    } else {
      nextTransaction = {
        id: generateId(),
        packageId: occurrence.packageId,
        type: 'lesson_use',
        amount: -1,
        lessonId: occurrence.lessonId,
        lessonDate: occurrence.lessonDate,
        lessonStartMinute: occurrence.lessonStartMinute,
        note: 'Automatic deduction for completed lesson',
        date: new Date().toISOString(),
        sourceKey: buildPackageTransactionSourceKey('lesson_use', occurrenceBase),
      };
    }
  } else if (desiredNet === 0 && currentNet === -1) {
    const ordinal = getOccurrenceSourceKeyCount(state, 'lesson_cancel', occurrenceBase) + 1;
    nextTransaction = {
      id: generateId(),
      packageId: occurrence.packageId,
      type: 'lesson_cancel',
      amount: 1,
      lessonId: occurrence.lessonId,
      lessonDate: occurrence.lessonDate,
      lessonStartMinute: occurrence.lessonStartMinute,
      note: 'Reverse deduction for removed or cancelled lesson',
      date: new Date().toISOString(),
      sourceKey: buildPackageTransactionSourceKey('lesson_cancel', occurrenceBase, ordinal),
    };
  } else {
    const ordinal = getOccurrenceSourceKeyCount(state, 'lesson_adjust', occurrenceBase) + 1;
    nextTransaction = {
      id: generateId(),
      packageId: occurrence.packageId,
      type: 'correction',
      amount: desiredNet - currentNet,
      lessonId: occurrence.lessonId,
      lessonDate: occurrence.lessonDate,
      lessonStartMinute: occurrence.lessonStartMinute,
      note: 'Automatic lesson credit reconciliation',
      date: new Date().toISOString(),
      sourceKey: buildPackageTransactionSourceKey('lesson_adjust', occurrenceBase, ordinal),
    };
  }

  return appendPackageTransactionState(state, nextTransaction, { recompute: false });
}

function reconcileMigratedPackageCredits(state) {
  const expectedOccurrences = buildPastPackageOccurrenceMap(state);
  const seenOccurrences = new Map();
  const cutoff = new Date(state.creditTrackingMigratedAt || DEFAULT_CREDIT_TRACKING_MIGRATED_AT);
  let changed = false;

  for (const tx of state.packageTransactions || []) {
    if (!tx?.packageId || !tx?.lessonDate || !tx?.lessonId) continue;
    const txDate = parseDate(tx.lessonDate);
    if (txDate < cutoff) continue;
    const occurrence = {
      packageId: tx.packageId,
      lessonId: tx.lessonId,
      lessonDate: tx.lessonDate,
      lessonStartMinute: tx.lessonStartMinute,
    };
    seenOccurrences.set(buildOccurrenceBaseKey(occurrence), occurrence);
  }

  for (const occurrence of expectedOccurrences.values()) {
    if (ensureOccurrenceNet(state, occurrence, occurrence.desiredNet)) {
      changed = true;
    }
  }

  for (const [baseKey, occurrence] of seenOccurrences.entries()) {
    if (expectedOccurrences.has(baseKey)) continue;
    if (ensureOccurrenceNet(state, occurrence, 0)) {
      changed = true;
    }
  }

  if (changed) {
    recomputePackageCreditState(state);
  }

  return changed;
}

function buildClientLessonStats() {
  const stats = new Map();
  const now = new Date();

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

function addDays(dateStr, days) {
  const date = parseDate(dateStr);
  date.setDate(date.getDate() + days);
  return formatDate(date);
}

function getRecurringLessonSignature(lesson, dateStr = lesson?.date) {
  return JSON.stringify({
    date: dateStr,
    startMinute: Number(lesson?.startMinute) || 0,
    durationMinutes: Number(lesson?.durationMinutes) || 0,
    lessonType: lesson?.lessonType || 'individual',
    title: lesson?.title || '',
    horse: lesson?.horse || null,
    instructor: lesson?.instructor || null,
    packageMode: lesson?.packageMode !== false,
    groupName: lesson?.groupName || null,
    groupColor: lesson?.groupColor || null,
    participants: lesson?.participants || [],
  });
}

function buildRecurringChildFromParent(parent, existingChild = null) {
  const nextDate = addDays(parent.date, 7);
  const child = {
    ...parent,
    ...(existingChild ? { id: existingChild.id } : { id: generateId() }),
    date: nextDate,
    recurring: existingChild ? existingChild.recurring === true : true,
    recurringParentId: parent.id,
    recurringUntil: null,
    cancelledDates: [],
    instanceOverrides: {},
  };
  delete child._recurringInstance;
  delete child._instanceDate;
  return normalizeLesson(child);
}

function getDirectRecurringChild(state, parentId) {
  return (state.lessons || []).find(lesson => lesson.recurringParentId === parentId) || null;
}

function getExistingNextWeekRecurringCopy(state, parent) {
  const nextDate = addDays(parent.date, 7);
  const targetSignature = getRecurringLessonSignature(parent, nextDate);
  return (state.lessons || []).find(lesson => {
    if (lesson.id === parent.id || lesson.date !== nextDate) return false;
    return getRecurringLessonSignature(lesson) === targetSignature;
  }) || null;
}

function syncDirectRecurringChild(state, parent) {
  if (!parent?.id || !parent.date) return false;
  const child = getDirectRecurringChild(state, parent.id);

  if (parent.recurring !== true) {
    if (!child) return false;
    state.lessons = state.lessons.filter(lesson => lesson.id !== child.id);
    for (const lesson of state.lessons || []) {
      if (lesson.recurringParentId === child.id) {
        lesson.recurringParentId = null;
      }
    }
    return true;
  }

  const nextDate = addDays(parent.date, 7);
  if (child) {
    // Once a child exists, it is an independent concrete lesson.
    // Parent edits must not rewrite it.
    return false;
  }

  if ((state.lessons || []).some(lesson => lesson.date === nextDate && lesson.recurringParentId === parent.id)) {
    return false;
  }

  const existingCopy = getExistingNextWeekRecurringCopy(state, parent);
  if (existingCopy) {
    if (existingCopy.recurringParentId || existingCopy.recurringParentId === parent.id) return false;
    existingCopy.recurringParentId = parent.id;
    return true;
  }

  state.lessons.push(buildRecurringChildFromParent(parent));
  return true;
}

function materializeDueRecurringLessons(state, todayStr = formatDate(new Date())) {
  let changed = false;
  const maxIterations = Math.max(1, (state.lessons || []).length + 52);

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const dueLesson = [...(state.lessons || [])]
      .filter(lesson =>
        lesson?.recurring === true
        && lesson.date
        && lesson.date <= todayStr
        && !getDirectRecurringChild(state, lesson.id)
      )
      .sort((a, b) => {
        const dateCompare = a.date.localeCompare(b.date);
        if (dateCompare !== 0) return dateCompare;
        return (Number(a.startMinute) || 0) - (Number(b.startMinute) || 0);
      })[0];

    if (!dueLesson) break;

    if (syncDirectRecurringChild(state, dueLesson)) {
      changed = true;
      continue;
    }

    break;
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
  if (newLesson.date <= formatDate(new Date())) {
    syncDirectRecurringChild(d, newLesson);
  }
  materializeDueRecurringLessons(d);
  reconcileMigratedPackageCredits(d);
  reconcileSavedLessonPackageCredits(d, null, newLesson);
  if (save) saveData({ syncScope: SYNC_SCOPE_LESSONS });
  return newLesson;
}

export function updateLesson(id, updates, { save = true } = {}) {
  const d = getData();
  const idx = d.lessons.findIndex(lesson => lesson.id === id);
  if (idx >= 0) {
    const previousLesson = d.lessons[idx];
    d.lessons[idx] = normalizeLesson({ ...d.lessons[idx], ...updates });
    if (d.lessons[idx].date <= formatDate(new Date())) {
      syncDirectRecurringChild(d, d.lessons[idx]);
    }
    materializeDueRecurringLessons(d);
    reconcileMigratedPackageCredits(d);
    reconcileSavedLessonPackageCredits(d, previousLesson, d.lessons[idx]);
    if (save) saveData({ syncScope: SYNC_SCOPE_LESSONS });
  }
}

export function deleteLesson(id) {
  const d = getData();
  const lesson = d.lessons.find(entry => entry.id === id);
  if (!lesson) return;

  if (lesson.recurringParentId) {
    const parent = d.lessons.find(entry => entry.id === lesson.recurringParentId);
    if (parent) {
      parent.recurring = false;
    }
  }
  for (const child of d.lessons || []) {
    if (child.recurringParentId === id) {
      child.recurringParentId = null;
    }
  }
  d.lessons = d.lessons.filter(entry => entry.id !== id);
  reconcileMigratedPackageCredits(d);
  for (const tx of d.packageTransactions || []) {
    if (tx.lessonId === id) {
      tx.lessonId = null;
    }
  }
  saveData({ syncScope: SYNC_SCOPE_LESSONS });
}

export function getLessonsForDate(dateStr) {
  const d = getData();
  return (d.lessons || []).filter(lesson => lesson.date === dateStr);
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
  reconcileMigratedPackageCredits(d);
  saveData({ syncScope: SYNC_SCOPE_LESSONS });
}

export function processPastLessonsForCredits() {
  if (!_data) return;
  if (!_isAdmin) {
    recomputePackageCreditState(_data);
    return;
  }
  const recurringChainChanged = materializeDueRecurringLessons(_data);
  const archiveChanged = autoArchiveDormantClients();
  recomputePackageCreditState(_data);
  const transactionChanged = reconcileMigratedPackageCredits(_data);
  if (recurringChainChanged || archiveChanged || transactionChanged) {
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
  const delta = (Number(credits) || 0) - getCurrentCreditValue(pkg);
  if (delta === 0) return;
  appendPackageTransactionState(d, {
    id: generateId(),
    packageId: pkg.id,
    type: 'correction',
    amount: delta,
    note: 'Manual package credit set',
    date: new Date().toISOString(),
    sourceKey: `manual_set|${pkg.id}|${generateId()}`,
  });
  saveData();
}

export function addPackageCredits(id, amount) {
  const d = getData();
  const pkg = d.packages.find(entry => entry.id === id);
  if (!pkg) return;
  appendPackageTransactionState(d, {
    id: generateId(),
    packageId: pkg.id,
    type: amount >= 0 ? 'manual_add' : 'manual_deduct',
    amount,
    note: amount >= 0 ? 'Manual credit addition' : 'Manual credit deduction',
    date: new Date().toISOString(),
    sourceKey: `manual_adjust|${pkg.id}|${generateId()}`,
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
  appendPackageTransactionState(d, {
    id: generateId(),
    packageId: pkg.id,
    type: 'manual_deduct',
    amount: -1,
    lessonDate: dateStr,
    lessonStartMinute: startMinute,
    note: 'Manual package deduction',
    date: new Date().toISOString(),
    sourceKey: `manual_deduct|${pkg.id}|${generateId()}`,
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
  const next = d.instructors.filter(entry => entry.name !== name);
  if (next.length === d.instructors.length) return;
  d.instructors = next;
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
  saveData();
  return newExpense;
}

export function updateExpense(id, updates) {
  const d = getData();
  const idx = d.expenses.findIndex(e => e.id === id);
  if (idx >= 0) {
    d.expenses[idx] = { ...d.expenses[idx], ...updates };
    saveData();
  }
}

export function deleteExpense(id) {
  const d = getData();
  d.expenses = d.expenses.filter(e => e.id !== id);
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
  saveData();
  return newIncome;
}

export function updateIncome(id, updates) {
  const d = getData();
  const idx = d.incomes.findIndex(e => e.id === id);
  if (idx >= 0) {
    d.incomes[idx] = { ...d.incomes[idx], ...updates };
    saveData();
  }
}

export function deleteIncome(id) {
  const d = getData();
  d.incomes = d.incomes.filter(e => e.id !== id);
  saveData();
}

