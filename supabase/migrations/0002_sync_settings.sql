-- Years of financial history the connector syncs (returned in the heartbeat).
alter table tally.tenants add column if not exists years_to_sync int not null default 3 check (years_to_sync between 1 and 20);

-- Pending-bill snapshot: each sync run stamps the bills it sends; on commit, bills not stamped by that run are removed.
alter table tally.bills add column if not exists run_id uuid;
