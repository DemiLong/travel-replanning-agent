-- Anonymous API protection. Enable Anonymous Sign-Ins before deploying the app.
-- Counters contain no itinerary or user-provided content.

drop function if exists public.claim_replan_request();
drop table if exists public.travel_request_limits;

create table public.travel_api_rate_limit_policies (
  route text primary key check (route in ('parse', 'assist', 'validate')),
  user_limit integer not null check (user_limit > 0),
  global_limit integer not null check (global_limit > 0),
  window_seconds integer not null default 60 check (window_seconds > 0)
);

insert into public.travel_api_rate_limit_policies(route, user_limit, global_limit, window_seconds)
values
  ('parse', 10, 60, 60),
  ('assist', 5, 30, 60),
  ('validate', 10, 60, 60);

create table public.travel_api_rate_limit_counters (
  scope text not null check (scope in ('user', 'global')),
  subject text not null,
  route text not null references public.travel_api_rate_limit_policies(route) on delete cascade,
  window_started_at timestamptz not null,
  request_count integer not null check (request_count >= 0),
  primary key (scope, subject, route)
);

alter table public.travel_api_rate_limit_policies enable row level security;
alter table public.travel_api_rate_limit_counters enable row level security;
revoke all on public.travel_api_rate_limit_policies from anon, authenticated;
revoke all on public.travel_api_rate_limit_counters from anon, authenticated;

create function public.claim_api_request(requested_route text)
returns table (
  allowed boolean,
  remaining integer,
  retry_after_seconds integer,
  exceeded_scope text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_id uuid := auth.uid();
  caller_subject text;
  policy_row public.travel_api_rate_limit_policies%rowtype;
  request_time timestamptz := clock_timestamp();
  user_window_start timestamptz;
  global_window_start timestamptz;
  user_count integer;
  global_count integer;
  user_exceeded boolean;
  global_exceeded boolean;
  user_retry integer := 0;
  global_retry integer := 0;
begin
  if caller_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  select * into policy_row
  from public.travel_api_rate_limit_policies as policies
  where policies.route = requested_route;

  if not found then
    raise exception 'Unsupported protected route' using errcode = '22023';
  end if;

  caller_subject := caller_id::text;

  -- Every transaction takes the global lock first and the user lock second.
  perform pg_advisory_xact_lock(hashtextextended('coveredYou:global:' || requested_route, 0));
  perform pg_advisory_xact_lock(hashtextextended('coveredYou:user:' || caller_subject || ':' || requested_route, 0));

  insert into public.travel_api_rate_limit_counters(scope, subject, route, window_started_at, request_count)
  values ('global', 'project', requested_route, request_time, 0)
  on conflict (scope, subject, route) do nothing;

  insert into public.travel_api_rate_limit_counters(scope, subject, route, window_started_at, request_count)
  values ('user', caller_subject, requested_route, request_time, 0)
  on conflict (scope, subject, route) do nothing;

  select counters.window_started_at, counters.request_count
  into global_window_start, global_count
  from public.travel_api_rate_limit_counters as counters
  where counters.scope = 'global'
    and counters.subject = 'project'
    and counters.route = requested_route
  for update;

  select counters.window_started_at, counters.request_count
  into user_window_start, user_count
  from public.travel_api_rate_limit_counters as counters
  where counters.scope = 'user'
    and counters.subject = caller_subject
    and counters.route = requested_route
  for update;

  if global_window_start + make_interval(secs => policy_row.window_seconds) <= request_time then
    global_window_start := request_time;
    global_count := 0;
    update public.travel_api_rate_limit_counters as counters
    set window_started_at = request_time, request_count = 0
    where counters.scope = 'global'
      and counters.subject = 'project'
      and counters.route = requested_route;
  end if;

  if user_window_start + make_interval(secs => policy_row.window_seconds) <= request_time then
    user_window_start := request_time;
    user_count := 0;
    update public.travel_api_rate_limit_counters as counters
    set window_started_at = request_time, request_count = 0
    where counters.scope = 'user'
      and counters.subject = caller_subject
      and counters.route = requested_route;
  end if;

  user_exceeded := user_count >= policy_row.user_limit;
  global_exceeded := global_count >= policy_row.global_limit;

  if user_exceeded then
    user_retry := greatest(1, ceil(extract(epoch from (
      user_window_start + make_interval(secs => policy_row.window_seconds) - request_time
    )))::integer);
  end if;
  if global_exceeded then
    global_retry := greatest(1, ceil(extract(epoch from (
      global_window_start + make_interval(secs => policy_row.window_seconds) - request_time
    )))::integer);
  end if;

  if user_exceeded or global_exceeded then
    return query select
      false,
      least(greatest(policy_row.user_limit - user_count, 0), greatest(policy_row.global_limit - global_count, 0)),
      greatest(user_retry, global_retry),
      case when global_exceeded then 'global' else 'user' end;
    return;
  end if;

  update public.travel_api_rate_limit_counters as counters
  set request_count = counters.request_count + 1
  where counters.scope = 'global'
    and counters.subject = 'project'
    and counters.route = requested_route;

  update public.travel_api_rate_limit_counters as counters
  set request_count = counters.request_count + 1
  where counters.scope = 'user'
    and counters.subject = caller_subject
    and counters.route = requested_route;

  return query select
    true,
    least(policy_row.user_limit - user_count - 1, policy_row.global_limit - global_count - 1),
    greatest(1, ceil(extract(epoch from (
      least(
        user_window_start + make_interval(secs => policy_row.window_seconds),
        global_window_start + make_interval(secs => policy_row.window_seconds)
      ) - request_time
    )))::integer),
    null::text;
end;
$$;

revoke all on function public.claim_api_request(text) from public;
grant execute on function public.claim_api_request(text) to authenticated;
