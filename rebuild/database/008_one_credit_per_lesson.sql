-- Each participant's lesson consumes exactly one package credit if approved.
-- Existing ledger entries and decisions remain immutable.
alter table horsebook.bookings add constraint bookings_one_credit check (units=1);
insert into horsebook.schema_version values(8);
