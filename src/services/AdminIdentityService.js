import { supabase } from '../supabase.js';

export async function resolveAdminLoginEmail(identifier) {
  const trimmed = String(identifier || '').trim();
  if (!trimmed || !supabase) return trimmed;
  if (trimmed.includes('@')) return trimmed;

  const { data, error } = await supabase.rpc('resolve_admin_login_email', {
    login_identifier: trimmed,
  });

  if (error) {
    console.warn('[auth] Failed to resolve admin login alias', error);
    return trimmed;
  }
  return data || trimmed;
}

export async function fetchAdminProfilesByUserIds(userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (ids.length === 0 || !supabase) return new Map();

  const { data, error } = await supabase
    .from('admin_profiles')
    .select('user_id,login_name,display_name,email')
    .in('user_id', ids);

  if (error) {
    console.warn('[audit] Failed to load admin profiles', error);
    return new Map();
  }

  return new Map((data || []).map(profile => [profile.user_id, profile]));
}

export function getAdminDisplayName(profile, fallbackUserId = '') {
  if (!profile) return fallbackUserId;
  return profile.display_name || profile.login_name || fallbackUserId;
}
