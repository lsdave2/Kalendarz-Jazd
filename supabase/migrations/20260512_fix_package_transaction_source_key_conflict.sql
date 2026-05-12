alter table public.package_transactions
  add column if not exists source_key text;

drop index if exists public.uq_package_transactions_source_key;

create unique index if not exists uq_package_transactions_source_key
  on public.package_transactions (source_key);
