-- Apply once to a Supabase project. Enable anonymous sign-in in Auth settings.
create table public.travel_snapshots (
 user_id uuid primary key references auth.users(id) on delete cascade,
 snapshot jsonb not null,
 updated_at timestamptz not null default now()
);
create table public.travel_analytics (
 id text primary key,
 user_id uuid not null references auth.users(id) on delete cascade,
 name text not null check (name in ('trip_created','replan_started','replan_generated','replan_validation_failed','replan_regenerated','replan_accepted','replan_rejected','preference_saved')),
 properties jsonb not null default '{}',
 created_at timestamptz not null default now()
);
create index travel_analytics_user_time on public.travel_analytics(user_id,created_at);
alter table public.travel_snapshots enable row level security;
alter table public.travel_analytics enable row level security;
create policy "own snapshot read" on public.travel_snapshots for select to authenticated using ((select auth.uid())=user_id);
create policy "own analytics read" on public.travel_analytics for select to authenticated using ((select auth.uid())=user_id);
create policy "own analytics insert" on public.travel_analytics for insert to authenticated with check ((select auth.uid())=user_id);
grant select on public.travel_snapshots to authenticated;
grant select,insert on public.travel_analytics to authenticated;
revoke all on public.travel_snapshots from anon;
revoke all on public.travel_analytics from anon;

create or replace function public.save_travel_snapshot(new_snapshot jsonb,expected_revision integer default null)
returns void language plpgsql security definer set search_path=public as $$
declare existing jsonb; uid uuid:=auth.uid();
begin
 if uid is null then raise exception 'Authentication required'; end if;
 -- Serializes first insert as well as subsequent writes for this guest.
 perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
 select snapshot into existing from public.travel_snapshots where user_id=uid for update;
 if expected_revision is not null and existing is not null and (existing->>'revision')::integer<>expected_revision then raise exception 'stale revision'; end if;
 if jsonb_typeof(new_snapshot)<>'object' or not(new_snapshot ?& array['profile','trip','state','itinerary','revision']) then raise exception 'Invalid snapshot'; end if;
 insert into public.travel_snapshots(user_id,snapshot) values(uid,new_snapshot)
 on conflict(user_id) do update set snapshot=excluded.snapshot,updated_at=now();
end; $$;
revoke all on function public.save_travel_snapshot(jsonb,integer) from public;
grant execute on function public.save_travel_snapshot(jsonb,integer) to authenticated;

-- Portfolio query: deduplicated plan-level acceptance (filter mode for live/demo).
create view public.travel_metrics with (security_invoker=true) as
select user_id,
 count(distinct properties->>'planId') filter(where name='replan_accepted')::float /
 nullif(count(distinct properties->>'planId') filter(where name='replan_generated'),0) as plan_acceptance_rate,
 avg((properties->>'regenerationCount')::numeric) filter(where name='replan_generated') as average_regeneration_count,
 count(*) filter(where name='replan_generated')::float /
 nullif(count(*) filter(where name in ('replan_generated','replan_validation_failed')),0) as attempt_hard_constraint_pass_rate
from public.travel_analytics group by user_id;

-- Independent of editable client analytics. At most five calls/minute/guest.
create table public.travel_request_limits(user_id uuid primary key references auth.users(id) on delete cascade,window_start timestamptz not null default now(),request_count integer not null default 0);
alter table public.travel_request_limits enable row level security;
revoke all on public.travel_request_limits from anon,authenticated;
create function public.claim_replan_request() returns void language plpgsql security definer set search_path=public as $$
declare uid uuid:=auth.uid(); n integer;
begin
 if uid is null then raise exception 'Authentication required'; end if;
 insert into travel_request_limits(user_id,window_start,request_count) values(uid,now(),1)
 on conflict(user_id) do update set
 request_count=case when travel_request_limits.window_start<now()-interval '1 minute' then 1 else travel_request_limits.request_count+1 end,
 window_start=case when travel_request_limits.window_start<now()-interval '1 minute' then now() else travel_request_limits.window_start end
 returning request_count into n;
 if n>5 then raise exception 'Rate limited'; end if;
end; $$;
revoke all on function public.claim_replan_request() from public;
grant execute on function public.claim_replan_request() to authenticated;
