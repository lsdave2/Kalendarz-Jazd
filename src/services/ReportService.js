import { getDatesInRange } from '../utils.js';
import { getData, getLessonsForDate } from '../store.js';
import { isGroupLessonRecord, isCustomLessonRecord, getLessonParticipants } from './LessonService.js';
import { t } from '../i18n.js';

const SETTINGS_KEY = 'horsebook_settings';
function getSettings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
}
function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

export function formatCurrency(amount) {
  if (Number.isNaN(amount)) return '0 zł';
  return `${Number.isInteger(amount) ? String(amount) : amount.toFixed(2)} zł`;
}

export function formatDuration(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return `0${t('m')}`;
  const h = Math.floor(minutes / 60), m = minutes % 60;
  const parts = [];
  if (h > 0) parts.push(`${h}${t('h')}`);
  if (m > 0) parts.push(`${m}${t('m')}`);
  return parts.join(' ') || `0${t('m')}`;
}

export function parseRate(v) {
  const r = Number.parseFloat(v);
  return Number.isFinite(r) ? r : 0;
}

export function getPaymentReportRates() {
  const s = getSettings();
  const i = Number.parseFloat(s.paymentReportIndividualRate);
  const g = Number.parseFloat(s.paymentReportGroupRate);
  return { individual: Number.isFinite(i) ? i : 60, group: Number.isFinite(g) ? g : 30 };
}

export function savePaymentReportRates(individual, group) {
  const s = getSettings();
  s.paymentReportIndividualRate = Number.isFinite(individual) ? individual : 60;
  s.paymentReportGroupRate = Number.isFinite(group) ? group : 30;
  saveSettings(s);
}

export function getRevenueReportRates() {
  const s = getSettings();
  return {
    individual: Number.parseFloat(s.revenueReportIndividualRate) || 140,
    group: Number.parseFloat(s.revenueReportGroupRate) || 110,
    individualPackage: Number.parseFloat(s.revenueReportIndividualPackageRate) || 110,
    groupPackage: Number.parseFloat(s.revenueReportGroupPackageRate) || 90,
  };
}

export function saveRevenueReportRates(rates) {
  const s = getSettings();
  s.revenueReportIndividualRate = rates.individual;
  s.revenueReportGroupRate = rates.group;
  s.revenueReportIndividualPackageRate = rates.individualPackage;
  s.revenueReportGroupPackageRate = rates.groupPackage;
  saveSettings(s);
}

function getCustomPaymentRate(clientName) {
  const name = (clientName || '').trim().toLowerCase();
  if (!name) return null;
  const pkg = (getData().packages || []).find(e => (e.name || '').trim().toLowerCase() === name);
  const rate = Number.parseFloat(pkg?.customPaymentRate);
  return Number.isFinite(rate) ? rate : null;
}

function getDefaultRate(lesson, participant, rates) {
  if (participant) return participant.packageMode !== false ? rates.groupPackageRate : rates.groupRate;
  return lesson.packageMode !== false ? rates.individualPackageRate : rates.individualRate;
}

export function computeRevenueReport({ from, to, rates }) {
  const dates = getDatesInRange(from, to);
  const totals = {
    individual: { count: 0, hours: 0, revenue: 0 },
    individualPackage: { count: 0, hours: 0, revenue: 0 },
    group: { count: 0, hours: 0, revenue: 0 },
    groupPackage: { count: 0, hours: 0, revenue: 0 },
    custom: { count: 0, hours: 0, revenue: 0 },
  };
  const days = [];

  for (const dateStr of dates) {
    const lessons = getLessonsForDate(dateStr);
    const dayEntries = [];
    let dayTotal = 0;

    for (const lesson of lessons) {
      if (Array.isArray(lesson.cancelledDates) && lesson.cancelledDates.includes(dateStr)) continue;
      const dm = Math.max((lesson.durationMinutes || 0) / 60, 0);

      if (isGroupLessonRecord(lesson)) {
        for (const p of getLessonParticipants(lesson)) {
          const bucket = p.packageMode !== false ? totals.groupPackage : totals.group;
          const cn = p.packageName || p.name;
          const cr = getCustomPaymentRate(cn);
          const rate = cr ?? getDefaultRate(lesson, p, rates);
          const amount = dm * rate;
          bucket.count++; bucket.hours += dm; bucket.revenue += amount;
          dayTotal += amount;
          dayEntries.push({ clientName: cn, amount, rate, durationMultiplier: dm, lessonType: p.packageMode !== false ? 'groupPackage' : 'group' });
        }
        continue;
      }

      if (isCustomLessonRecord(lesson)) {
        for (const p of getLessonParticipants(lesson)) {
          const cn = p.name;
          const amount = p.customCost !== undefined ? p.customCost : 140;
          const rate = dm > 0 ? amount / dm : 0;
          totals.custom.count++; totals.custom.hours += dm; totals.custom.revenue += amount;
          dayTotal += amount;
          dayEntries.push({ clientName: cn, amount, rate, durationMultiplier: dm, lessonType: 'custom' });
        }
        continue;
      }

      const bucket = lesson.packageMode !== false ? totals.individualPackage : totals.individual;
      const cn = lesson.title || '';
      const cr = getCustomPaymentRate(cn);
      const rate = cr ?? getDefaultRate(lesson, null, rates);
      const amount = dm * rate;
      bucket.count++; bucket.hours += dm; bucket.revenue += amount;
      dayTotal += amount;
      dayEntries.push({ clientName: cn, amount, rate, durationMultiplier: dm, lessonType: lesson.packageMode !== false ? 'individualPackage' : 'individual' });
    }

    if (dayEntries.length > 0) days.push({ dateStr, total: dayTotal, entries: dayEntries });
  }
  return { totals, days };
}

export function computeInstructorPaymentReport({ instructor, from, to }) {
  const dates = getDatesInRange(from, to);
  let individualCount = 0, individualDurationMinutes = 0;
  let customCount = 0, customDurationMinutes = 0;
  const groupSessions = new Map();

  for (const dateStr of dates) {
    for (const lesson of getLessonsForDate(dateStr)) {
      if (lesson.cancelledDates && lesson.cancelledDates.includes(dateStr)) continue;

      if (isCustomLessonRecord(lesson)) {
        for (const p of getLessonParticipants(lesson)) {
          if (p.instructor === instructor) {
            customCount++; customDurationMinutes += lesson.durationMinutes || 0;
          }
        }
        continue;
      }

      if (lesson.instructor !== instructor) continue;

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
        individualCount++; individualDurationMinutes += lesson.durationMinutes || 0;
      }
    }
  }

  let groupParticipants = 0;
  for (const e of groupSessions.values()) groupParticipants += e.participants;
  return { individualCount, individualDurationMinutes, groupLessonsCount: groupSessions.size, groupParticipants, customCount, customDurationMinutes };
}

export function computeInstructorPaymentAmount({ instructor, from, to, individualRate, groupRate }) {
  const r = computeInstructorPaymentReport({ instructor, from, to });
  return (r.individualDurationMinutes / 60) * individualRate + (r.customDurationMinutes / 60) * individualRate + r.groupParticipants * groupRate;
}


