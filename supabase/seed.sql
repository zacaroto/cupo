-- ============================================================================
-- cupo local seed: three operators for the isolation suite (r7)
-- ============================================================================
-- applied by `supabase db reset` on the local stack and in ci only. the deploy
-- workflow never passes `--include-seed`, and the guard below aborts before any
-- insert when the server is not the local docker stack. auth users and
-- memberships are created afterwards by `npm run db:seed-users` (ktd10).
--
-- the uuids are fixed so tests can reference them: keep them in sync with
-- tests/db/fixtures.ts.

-- ============================================================================
-- local-only guard
-- ============================================================================
-- two independent signals, both must hold:
-- 1. the server address is loopback or the docker bridge range (172.16/12).
--    on the local stack a tcp connection from the host sees the container
--    address (for example 172.18.0.2); unix-socket connections see null and
--    are refused too.
-- 2. the legacy jwt secret setting equals the constant the supabase cli bakes
--    into every local stack; hosted projects never carry it.

do $$
declare
  v_addr inet := inet_server_addr();
  v_jwt text := current_setting('app.settings.jwt_secret', true);
begin
  if v_addr is null
     or not (v_addr <<= '127.0.0.0/8'::inet or v_addr <<= '::1/128'::inet or v_addr <<= '172.16.0.0/12'::inet) then
    raise exception 'seed.sql refused: server address % is not loopback or the docker range', v_addr
      using errcode = 'P0001';
  end if;
  if v_jwt is distinct from 'super-secret-jwt-token-with-at-least-32-characters-long' then
    raise exception 'seed.sql refused: this server is not a supabase cli local stack'
      using errcode = 'P0001';
  end if;
end;
$$;

-- ============================================================================
-- operators
-- ============================================================================

insert into public.operators (id, name, slug, timezone, currency, locale, status)
values
  ('0a000000-0000-4000-8000-00000000000a', 'Operator A', 'operator-a', 'America/Costa_Rica', 'USD', 'es', 'active'),
  ('0b000000-0000-4000-8000-00000000000b', 'Operator B', 'operator-b', 'America/Mexico_City', 'MXN', 'es', 'active'),
  ('0c000000-0000-4000-8000-00000000000c', 'Operator C', 'operator-c', 'Europe/Madrid', 'EUR', 'en', 'active')
on conflict (id) do nothing;

-- ============================================================================
-- guides (u4)
-- ============================================================================
-- a1 is linked to the seeded guía user by scripts/seed-users.ts (the guía
-- membership requires it); a2 and b1 have no account.

insert into public.guides (id, operator_id, name, email, phone, languages, specialties, max_daily_hours)
values
  ('9a100000-0000-4000-8000-00000000000a', '0a000000-0000-4000-8000-00000000000a', 'Guía A', 'guia-a@cupo.test', '+506 8888 0001', '{es,en}', '{senderismo}', 8),
  ('9a200000-0000-4000-8000-00000000000a', '0a000000-0000-4000-8000-00000000000a', 'Guía A sin cuenta', 'guia-a2@cupo.test', null, '{es}', '{}', null),
  ('9b100000-0000-4000-8000-00000000000b', '0b000000-0000-4000-8000-00000000000b', 'Guía B', 'guia-b@cupo.test', null, '{es}', '{pesca}', 6)
on conflict (id) do nothing;

-- ============================================================================
-- tours (u5)
-- ============================================================================
-- one tour per operator a and b with a direct price and one weekly schedule
-- (tuesday 08:00 for a, saturday 09:00 for b). departures are created by the
-- tests and the app (their dates are relative to today).

insert into public.tours (id, operator_id, name, description, duration_minutes, default_capacity, meeting_point)
values
  ('7a100000-0000-4000-8000-00000000000a', '0a000000-0000-4000-8000-00000000000a', 'Tour A', 'Caminata por el bosque nuboso.', 180, 12, 'Plaza central'),
  ('7b100000-0000-4000-8000-00000000000b', '0b000000-0000-4000-8000-00000000000b', 'Tour B', 'Pesca en la bahía.', 240, 8, 'Muelle')
on conflict (id) do nothing;

insert into public.tour_prices (operator_id, tour_id, channel, price_minor, currency)
values
  ('0a000000-0000-4000-8000-00000000000a', '7a100000-0000-4000-8000-00000000000a', 'direct', 12500, 'USD'),
  ('0b000000-0000-4000-8000-00000000000b', '7b100000-0000-4000-8000-00000000000b', 'direct', 150000, 'MXN')
on conflict (operator_id, tour_id, channel) do nothing;

insert into public.tour_schedules (operator_id, tour_id, weekday, start_time, valid_from)
values
  ('0a000000-0000-4000-8000-00000000000a', '7a100000-0000-4000-8000-00000000000a', 2, '08:00', '2026-01-01'),
  ('0b000000-0000-4000-8000-00000000000b', '7b100000-0000-4000-8000-00000000000b', 6, '09:00', '2026-01-01')
on conflict (operator_id, tour_id, weekday, start_time) do nothing;
