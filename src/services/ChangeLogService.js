import { supabase } from '../supabase.js';
import { fetchAdminProfilesByUserIds, getAdminDisplayName } from './AdminIdentityService.js';

export const CHANGE_LOG_TABLES = [
  'lessons',
  'packages',
  'package_transactions',
  'horses',
  'instructors',
  'groups',
  'settings',
  'expenses',
  'incomes',
];

export const CHANGE_LOG_ACTIONS = ['INSERT', 'UPDATE', 'DELETE'];

export async function fetchChangeLogEntries({
  tableName = '',
  action = '',
  dateFrom = '',
  dateTo = '',
  limit = 100,
} = {}) {
  if (!supabase) {
    return { entries: [], error: new Error('Supabase is not configured.') };
  }

  let query = supabase
    .from('change_log')
    .select('id,occurred_at,schema_name,table_name,row_id,action,changed_by_user_id,old_row,new_row,changed_fields,source')
    .order('occurred_at', { ascending: false })
    .limit(limit);

  if (tableName) query = query.eq('table_name', tableName);
  if (action) query = query.eq('action', action);
  if (dateFrom) query = query.gte('occurred_at', `${dateFrom}T00:00:00.000Z`);
  if (dateTo) query = query.lt('occurred_at', `${dateTo}T23:59:59.999Z`);

  const { data, error } = await query;
  if (error) return { entries: [], error };

  const profilesByUserId = await fetchAdminProfilesByUserIds((data || []).map(entry => entry.changed_by_user_id));
  const entries = (data || []).map(entry => {
    const profile = profilesByUserId.get(entry.changed_by_user_id);
    return {
      ...entry,
      changed_by_display_name: getAdminDisplayName(profile, entry.changed_by_user_id),
      changed_by_login_name: profile?.login_name || null,
    };
  });

  return { entries, error: null };
}

function compactList(values) {
  return (Array.isArray(values) ? values : [])
    .map(value => {
      if (typeof value === 'string') return value.trim();
      if (value && typeof value === 'object') {
        return String(value.name || value.clientName || value.horse || '').trim();
      }
      return '';
    })
    .filter(Boolean)
    .join(', ');
}

export function getChangeLogRowTitle(entry) {
  const row = entry?.new_row || entry?.old_row || {};
  const tableName = entry?.table_name || '';

  if (tableName === 'lessons') {
    const titleParts = [
      row.title,
      row.date,
      row.start_minute != null ? `${Math.floor(row.start_minute / 60).toString().padStart(2, '0')}:${(row.start_minute % 60).toString().padStart(2, '0')}` : '',
      row.horse_name,
      row.instructor_name,
    ].filter(Boolean);
    if (titleParts.length) return titleParts.join(' / ');
  }

  if (tableName === 'package_transactions') {
    return [row.type, row.amount != null ? String(row.amount) : '', row.note]
      .filter(Boolean)
      .join(' / ');
  }

  if (tableName === 'settings') return row.key || entry.row_id || '';
  if (tableName === 'expenses') return [row.title, row.date].filter(Boolean).join(' / ');
  if (tableName === 'incomes') return [row.title, row.date].filter(Boolean).join(' / ');

  const participantNames = compactList(row.participants);
  return row.name || row.title || participantNames || entry.row_id || '';
}
