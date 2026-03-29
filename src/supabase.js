import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://nmgkjoorzozkfssaibyr.supabase.co'
const supabaseKey = 'sb_publishable_20zanLJnH9tdk3vVIBjxCQ_7Lkkro9N'
export const supabase = createClient(supabaseUrl, supabaseKey)
