-- Measured at ~220 MB per 100k vouchers; this index was never used by any report and cost ~25% of the entries table's size.
drop index if exists tally.entries_role_idx;
