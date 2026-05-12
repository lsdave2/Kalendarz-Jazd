alter table public.package_transactions
  add column if not exists source_key text;

create unique index if not exists uq_package_transactions_source_key
  on public.package_transactions (source_key)
  where source_key is not null;
