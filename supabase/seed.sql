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
