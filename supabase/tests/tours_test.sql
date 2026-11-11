-- ============================================================================
-- tours: departure state machine, derived starts_at, the timezone recompute,
-- slot materialization and the guide rules (plan u5; ktd5, ktd7, ktd13)
-- ============================================================================
-- self-contained: creates its own operator, tour, schedule and guide inside
-- one transaction that is rolled back, so it does not depend on the seed.

begin;

create extension if not exists pgtap with schema extensions;

select plan(16);

insert into public.operators (id, name, slug, timezone, currency)
values ('e0000000-0000-4000-8000-000000000001', 'Pgtap Tours', 'pgtap-tours', 'America/Costa_Rica', 'USD');

insert into public.tours (id, operator_id, name, duration_minutes, default_capacity)
values
  ('e0000000-0000-4000-8000-0000000000c1', 'e0000000-0000-4000-8000-000000000001', 'Pgtap Tour', 120, 10),
  ('e0000000-0000-4000-8000-0000000000c2', 'e0000000-0000-4000-8000-000000000001', 'Pgtap Archived', 60, 4);
update public.tours set archived_at = now() where id = 'e0000000-0000-4000-8000-0000000000c2';

-- thursdays at 10:00 with 6 seats.
insert into public.tour_schedules (operator_id, tour_id, weekday, start_time, capacity_override, valid_from)
values ('e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000c1', 4, '10:00', 6, '2030-01-01');

insert into public.guides (id, operator_id, name)
values ('e0000000-0000-4000-8000-0000000000d1', 'e0000000-0000-4000-8000-000000000001', 'Pgtap Guide');

-- starts_at (ktd7): 2030-01-03 08:00 in costa rica (utc-6) and the capacity default.
insert into public.tour_departures (id, operator_id, tour_id, date, start_time, guide_id)
values ('e0000000-0000-4000-8000-0000000000e1', 'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000c1', '2030-01-03', '08:00', 'e0000000-0000-4000-8000-0000000000d1');
select is(
  (select starts_at from public.tour_departures where id = 'e0000000-0000-4000-8000-0000000000e1'),
  '2030-01-03 14:00:00+00'::timestamptz,
  'starts_at is the utc instant of the local date and time'
);
select is(
  (select capacity from public.tour_departures where id = 'e0000000-0000-4000-8000-0000000000e1'),
  10,
  'an omitted capacity is copied from the tour'
);

-- r21: archived tours take no new departures.
select throws_ok(
  $q$ insert into public.tour_departures (operator_id, tour_id, date, start_time)
      values ('e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000c2', '2030-01-03', '08:00') $q$,
  'P0001', 'tour_archived',
  'a departure of an archived tour is rejected'
);

-- ktd5 state machine.
select throws_ok(
  $q$ update public.tour_departures set status = 'cancelled' where id = 'e0000000-0000-4000-8000-0000000000e1' $q$,
  'P0001', 'forbidden_transition',
  'a direct move to cancelled is rejected'
);
update public.tour_departures set status = 'closed' where id = 'e0000000-0000-4000-8000-0000000000e1';
select throws_ok(
  $q$ update public.tour_departures set status = 'scheduled' where id = 'e0000000-0000-4000-8000-0000000000e1' $q$,
  'P0001', 'forbidden_transition',
  'closed never goes back to scheduled'
);
select lives_ok(
  $q$ select set_config('cupo.cancel_departure', 'e0000000-0000-4000-8000-0000000000e1', true);
      update public.tour_departures set status = 'cancelled' where id = 'e0000000-0000-4000-8000-0000000000e1';
      select set_config('cupo.cancel_departure', '', true) $q$,
  'the move to cancelled is accepted for the row named in cupo.cancel_departure'
);
select throws_ok(
  $q$ update public.tour_departures set status = 'closed' where id = 'e0000000-0000-4000-8000-0000000000e1' $q$,
  'P0001', 'forbidden_transition',
  'cancelled is terminal'
);

-- r17: a cancelled departure frees its slot; a live one holds it.
select lives_ok(
  $q$ insert into public.tour_departures (id, operator_id, tour_id, date, start_time)
      values ('e0000000-0000-4000-8000-0000000000e2', 'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000c1', '2030-01-03', '08:00') $q$,
  'the slot of a cancelled departure can be used again'
);
select throws_ok(
  $q$ insert into public.tour_departures (operator_id, tour_id, date, start_time)
      values ('e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000c1', '2030-01-03', '08:00') $q$,
  '23505', null,
  'a second live departure of the same slot is rejected'
);

-- the capacity backstop.
update public.tour_departures set seats_booked = 4 where id = 'e0000000-0000-4000-8000-0000000000e2';
select throws_ok(
  $q$ update public.tour_departures set capacity = 3 where id = 'e0000000-0000-4000-8000-0000000000e2' $q$,
  '23514', null,
  'capacity below seats_booked violates tour_departures_seats_within_capacity'
);

-- materialize_departure (service role claims): schedule slot and ad hoc time.
-- the calls run in their own statements so the outer queries see the rows.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
create temporary table materialized as
select 'schedule' as slot, private.materialize_departure('e0000000-0000-4000-8000-0000000000c1', '2030-01-10', '10:00') as id;
insert into materialized
select 'again', private.materialize_departure('e0000000-0000-4000-8000-0000000000c1', '2030-01-10', '10:00');
insert into materialized
select 'ad_hoc', private.materialize_departure('e0000000-0000-4000-8000-0000000000c1', '2030-01-10', '11:00');
select is(
  (select d.origin::text || ':' || d.capacity from public.tour_departures d join materialized m on m.id = d.id where m.slot = 'schedule'),
  'schedule:6',
  'a thursday 10:00 slot materializes from the schedule with its capacity override'
);
select is(
  (select id from materialized where slot = 'again'),
  (select id from materialized where slot = 'schedule'),
  'materializing an existing slot returns the existing departure'
);
select is(
  (select d.origin::text || ':' || d.capacity from public.tour_departures d join materialized m on m.id = d.id where m.slot = 'ad_hoc'),
  'ad_hoc:10',
  'a time without a schedule materializes ad hoc with the tour default'
);
select set_config('request.jwt.claims', '', true);

-- ktd7: a timezone change moves future departures only.
insert into public.tour_departures (id, operator_id, tour_id, date, start_time, capacity)
values ('e0000000-0000-4000-8000-0000000000e3', 'e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-0000000000c1', '2020-01-02', '08:00', 5);
update public.operators set timezone = 'Europe/Madrid' where id = 'e0000000-0000-4000-8000-000000000001';
select results_eq(
  $q$ select starts_at from public.tour_departures
      where id in ('e0000000-0000-4000-8000-0000000000e2', 'e0000000-0000-4000-8000-0000000000e3') order by date desc, id $q$,
  $q$ values ('2030-01-03 07:00:00+00'::timestamptz), ('2020-01-02 14:00:00+00'::timestamptz) $q$,
  'the future departure follows the new zone and the past one keeps its instant'
);

-- ktd13: deactivating a guide clears their future departures; an inactive guide cannot be assigned.
update public.tour_departures set guide_id = 'e0000000-0000-4000-8000-0000000000d1'
where id in ('e0000000-0000-4000-8000-0000000000e2', 'e0000000-0000-4000-8000-0000000000e3');
update public.guides set active = false where id = 'e0000000-0000-4000-8000-0000000000d1';
select results_eq(
  $q$ select guide_id from public.tour_departures
      where id in ('e0000000-0000-4000-8000-0000000000e2', 'e0000000-0000-4000-8000-0000000000e3') order by date desc $q$,
  $q$ values (null::uuid), ('e0000000-0000-4000-8000-0000000000d1'::uuid) $q$,
  'deactivation clears the future departure and keeps the past one'
);
select throws_ok(
  $q$ update public.tour_departures set guide_id = 'e0000000-0000-4000-8000-0000000000d1'
      where id = 'e0000000-0000-4000-8000-0000000000e2' $q$,
  'P0001', 'guide_inactive',
  'an inactive guide cannot be assigned'
);

select * from finish();

rollback;
