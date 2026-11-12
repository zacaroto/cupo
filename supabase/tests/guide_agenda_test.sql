-- ============================================================================
-- guide agenda: what a guía reads from tours, prices and customer_display
-- (plan u7; r11, r20; ktd4, ktd13)
-- ============================================================================
-- self-contained: creates its own operator, auth users, guides, tours,
-- departures, customers and reservations inside one transaction that is
-- rolled back. fixtures are written as postgres (the system path); the reads
-- run as `authenticated` with the user's jwt claims, as the data api does.

begin;

create extension if not exists pgtap with schema extensions;

select plan(12);

-- ============================================================================
-- structure and grants
-- ============================================================================

select policies_are(
  'public', 'customer_display',
  array['Staff read their operator''s masked customer names and guías those of their reservations'],
  'customer_display has one select policy: staff all names, guías those of their reservations'
);
select policies_are(
  'public', 'tours',
  array[
    'Staff read their operator''s tours',
    'Guías read the tours of their future assigned departures',
    'Administradores add tours to their operator',
    'Administradores edit their operator''s tours'
  ],
  'tours gains the guía select policy'
);
select ok(
  has_table_privilege('authenticated', 'public.tours', 'SELECT')
  and has_table_privilege('authenticated', 'public.customer_display', 'SELECT'),
  'authenticated already holds select on tours and customer_display'
);

-- ============================================================================
-- fixtures
-- ============================================================================

insert into public.operators (id, name, slug, timezone, currency)
values ('b7000000-0000-4000-8000-000000000001', 'Pgtap Agenda', 'pgtap-agenda', 'America/Costa_Rica', 'USD');

insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data)
values
  ('b7000000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pgtap-agenda-guia@cupo.test', '{}'),
  ('b7000000-0000-4000-8000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pgtap-agenda-staff@cupo.test', '{}');

-- d1 is the guía's guide; d2 belongs to someone else.
insert into public.guides (id, operator_id, name, user_id)
values
  ('b7000000-0000-4000-8000-0000000000d1', 'b7000000-0000-4000-8000-000000000001', 'Pgtap Mine', 'b7000000-0000-4000-8000-0000000000a1'),
  ('b7000000-0000-4000-8000-0000000000d2', 'b7000000-0000-4000-8000-000000000001', 'Pgtap Other', null);
insert into public.memberships (user_id, operator_id, role)
values
  ('b7000000-0000-4000-8000-0000000000a1', 'b7000000-0000-4000-8000-000000000001', 'guia'),
  ('b7000000-0000-4000-8000-0000000000a2', 'b7000000-0000-4000-8000-000000000001', 'contabilidad');

-- c1 future and mine, c2 past and mine, c3 future and another guide's,
-- c4 future and mine until it is unassigned, c5 without departures.
insert into public.tours (id, operator_id, name, duration_minutes, default_capacity)
select ('b7000000-0000-4000-8000-0000000000c' || n)::uuid, 'b7000000-0000-4000-8000-000000000001', 'Pgtap Agenda ' || n, 120, 6
from generate_series(1, 5) n;
insert into public.tour_prices (operator_id, tour_id, channel, price_minor, currency)
select 'b7000000-0000-4000-8000-000000000001', ('b7000000-0000-4000-8000-0000000000c' || n)::uuid, 'direct', 1000, 'USD'
from generate_series(1, 5) n;
insert into public.tour_departures (id, operator_id, tour_id, date, start_time, guide_id)
values
  ('b7000000-0000-4000-8000-0000000000e1', 'b7000000-0000-4000-8000-000000000001', 'b7000000-0000-4000-8000-0000000000c1', '2030-03-05', '08:00', 'b7000000-0000-4000-8000-0000000000d1'),
  ('b7000000-0000-4000-8000-0000000000e2', 'b7000000-0000-4000-8000-000000000001', 'b7000000-0000-4000-8000-0000000000c2', '2020-03-03', '08:00', 'b7000000-0000-4000-8000-0000000000d1'),
  ('b7000000-0000-4000-8000-0000000000e3', 'b7000000-0000-4000-8000-000000000001', 'b7000000-0000-4000-8000-0000000000c3', '2030-03-05', '08:00', 'b7000000-0000-4000-8000-0000000000d2'),
  ('b7000000-0000-4000-8000-0000000000e4', 'b7000000-0000-4000-8000-000000000001', 'b7000000-0000-4000-8000-0000000000c4', '2030-03-05', '08:00', 'b7000000-0000-4000-8000-0000000000d1');

-- f1 active on e1, f2 cancelled on e1, f3 on the past e2, f4 on the other
-- guide's e3, f5 without reservations.
insert into public.customers (id, operator_id, name)
select ('b7000000-0000-4000-8000-0000000000f' || n)::uuid, 'b7000000-0000-4000-8000-000000000001', 'Cliente Agenda' || n
from generate_series(1, 5) n;
insert into public.reservations (id, operator_id, departure_id, customer_id, people)
values
  ('b7000000-0000-4000-8000-0000000000b1', 'b7000000-0000-4000-8000-000000000001', 'b7000000-0000-4000-8000-0000000000e1', 'b7000000-0000-4000-8000-0000000000f1', 1),
  ('b7000000-0000-4000-8000-0000000000b2', 'b7000000-0000-4000-8000-000000000001', 'b7000000-0000-4000-8000-0000000000e1', 'b7000000-0000-4000-8000-0000000000f2', 1),
  ('b7000000-0000-4000-8000-0000000000b3', 'b7000000-0000-4000-8000-000000000001', 'b7000000-0000-4000-8000-0000000000e2', 'b7000000-0000-4000-8000-0000000000f3', 1),
  ('b7000000-0000-4000-8000-0000000000b4', 'b7000000-0000-4000-8000-000000000001', 'b7000000-0000-4000-8000-0000000000e3', 'b7000000-0000-4000-8000-0000000000f4', 1);
update public.reservations set status = 'cancelled', cancel_reason = 'pgtap'
where id = 'b7000000-0000-4000-8000-0000000000b2';

-- ============================================================================
-- the guía
-- ============================================================================

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b7000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);

select results_eq(
  $q$ select id from public.tours order by id $q$,
  $q$ values ('b7000000-0000-4000-8000-0000000000c1'::uuid), ('b7000000-0000-4000-8000-0000000000c4'::uuid) $q$,
  'the guía reads only the tours of their future assigned departures'
);
select is_empty($q$ select 1 from public.tour_prices $q$, 'the guía reads no prices');
select is_empty($q$ select 1 from public.tour_schedules $q$, 'the guía reads no schedules');
select results_eq(
  $q$ select customer_id, display_name from public.customer_display order by customer_id $q$,
  $q$ values ('b7000000-0000-4000-8000-0000000000f1'::uuid, 'Cliente A.') $q$,
  'the guía reads only the masked names of their active reservations on future departures'
);
select is_empty($q$ select 1 from public.customers $q$, 'the guía reads no customers');

-- unassigning the departure takes its tour out of the guía's reach.
reset role;
update public.tour_departures set guide_id = null where id = 'b7000000-0000-4000-8000-0000000000e4';
set local role authenticated;
select results_eq(
  $q$ select id from public.tours order by id $q$,
  $q$ values ('b7000000-0000-4000-8000-0000000000c1'::uuid) $q$,
  'after the departure is unassigned its tour is gone'
);

-- unassigning the last departure leaves nothing.
reset role;
update public.tour_departures set guide_id = null where id = 'b7000000-0000-4000-8000-0000000000e1';
set local role authenticated;
select is_empty($q$ select 1 from public.tours $q$, 'a guía without future assigned departures reads no tours');
select is_empty($q$ select 1 from public.customer_display $q$, 'a guía without future assigned departures reads no masked names');

-- ============================================================================
-- staff keep the u9 behavior
-- ============================================================================

select set_config('request.jwt.claims', '{"sub":"b7000000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
select is(
  (select count(*)::int from public.customer_display where operator_id = 'b7000000-0000-4000-8000-000000000001'),
  5,
  'contabilidad reads every masked name of the operator'
);
reset role;

select * from finish();

rollback;
