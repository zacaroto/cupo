-- ============================================================================
-- reservations: structure, grants, rls, triggers and the seat counter
-- (plan u6; r22 to r25, r27, r28; ktd4, ktd5, ktd6, ktd14)
-- ============================================================================
-- self-contained: creates its own operator, tour, price, departure and
-- customers inside one transaction that is rolled back. runs as postgres (no
-- jwt), which is the system path every trigger also covers.

begin;

create extension if not exists pgtap with schema extensions;

select plan(40);

-- ============================================================================
-- structure
-- ============================================================================

select has_table('public', 'reservations', 'reservations exists');
select has_table('public', 'reservation_notes', 'reservation_notes exists');
select has_table('public', 'reservation_amounts', 'reservation_amounts exists');
select has_table('private', 'reservation_counters', 'the code counters live in private');
select enum_has_labels('public', 'reservation_status', array['pending_review', 'confirmed', 'cancelled'], 'reservation statuses');

select results_eq(
  $q$ select tgname::text collate "default" from pg_trigger
      where tgrelid = 'public.reservations'::regclass and not tgisinternal order by tgname $q$,
  $q$ values ('t10_set_updated_at'), ('t20_reservation_rules'), ('t25_reservation_seats'), ('t27_reservation_flag'),
             ('t30_reservation_code'), ('t80_reservation_amount'), ('t80_reservation_amount_update'),
             ('t90_audit'), ('t90_audit_update') $q$,
  'reservations triggers fire in the ktd5 order'
);
select has_trigger('public', 'customers', 't85_customer_flag', 'customers carry the flag trigger');
select has_trigger('public', 'reservation_amounts', 't20_amount_override', 'amounts carry the override trigger');
select has_trigger('public', 'tour_departures', 't90_audit_seat_reconcile', 'departures audit the reconcile');

select is_empty(
  $q$ select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('create_reservation', 'update_reservation', 'cancel_departure', 'admin_seat_drift', 'admin_reconcile_seats')
        and p.prosecdef $q$,
  'the reservation rpcs are security invoker'
);

-- ============================================================================
-- grants (ktd4)
-- ============================================================================

select ok(
  not has_column_privilege('authenticated', 'public.reservations', 'code', 'INSERT')
  and not has_column_privilege('authenticated', 'public.reservations', 'created_by', 'INSERT')
  and not has_column_privilege('authenticated', 'public.reservations', 'has_incomplete_data', 'INSERT')
  and not has_column_privilege('authenticated', 'public.reservations', 'channel', 'INSERT'),
  'server-owned reservation columns are not insertable by authenticated'
);
select ok(
  not has_column_privilege('authenticated', 'public.reservations', 'code', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.reservations', 'operator_id', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.reservations', 'has_incomplete_data', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.reservations', 'created_by', 'UPDATE'),
  'server-owned reservation columns and operator_id are not updatable by authenticated'
);
select ok(
  has_column_privilege('authenticated', 'public.reservations', 'operator_id', 'INSERT')
  and has_column_privilege('authenticated', 'public.reservations', 'cancel_reason', 'UPDATE'),
  'operator_id is insertable and cancel_reason updatable'
);
select ok(
  not has_table_privilege('authenticated', 'public.reservations', 'DELETE')
  and not has_table_privilege('authenticated', 'public.reservation_notes', 'DELETE')
  and not has_table_privilege('authenticated', 'public.reservation_amounts', 'DELETE'),
  'authenticated deletes no reservation rows (r27)'
);
select ok(
  not has_table_privilege('authenticated', 'public.reservation_amounts', 'INSERT')
  and has_column_privilege('authenticated', 'public.reservation_amounts', 'total_minor', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.reservation_amounts', 'unit_price_minor', 'UPDATE')
  and not has_column_privilege('authenticated', 'public.reservation_amounts', 'amount_overridden', 'UPDATE'),
  'amounts: no insert, and only total_minor is updatable'
);
select ok(
  not has_table_privilege('authenticated', 'private.reservation_counters', 'SELECT')
  and not has_table_privilege('service_role', 'private.reservation_counters', 'SELECT'),
  'no api role reads the code counters'
);
select ok(
  has_function_privilege('authenticated', 'public.create_reservation(uuid, integer, uuid, uuid, date, time, public.reservation_status, uuid, text, text, text, text)', 'execute')
  and has_function_privilege('authenticated', 'public.update_reservation(uuid, integer, uuid, date, time, text)', 'execute'),
  'authenticated executes the booking rpcs'
);
select ok(
  not has_function_privilege('authenticated', 'public.admin_seat_drift()', 'execute')
  and not has_function_privilege('authenticated', 'public.admin_reconcile_seats(uuid)', 'execute')
  and has_function_privilege('service_role', 'public.admin_seat_drift()', 'execute')
  and has_function_privilege('service_role', 'public.admin_reconcile_seats(uuid)', 'execute'),
  'the seat runbook rpcs are service_role only'
);

-- ============================================================================
-- fixtures
-- ============================================================================

insert into public.operators (id, name, slug, timezone, currency)
values ('f0000000-0000-4000-8000-000000000001', 'Pgtap Reservations', 'pgtap-reservations', 'America/Costa_Rica', 'USD');
insert into public.tours (id, operator_id, name, duration_minutes, default_capacity)
values
  ('f0000000-0000-4000-8000-0000000000c1', 'f0000000-0000-4000-8000-000000000001', 'Pgtap Tour', 120, 4),
  ('f0000000-0000-4000-8000-0000000000c2', 'f0000000-0000-4000-8000-000000000001', 'Pgtap Unpriced', 120, 4);
insert into public.tour_prices (operator_id, tour_id, channel, price_minor, currency)
values ('f0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-0000000000c1', 'direct', 2500, 'USD');
insert into public.tour_departures (id, operator_id, tour_id, date, start_time)
values
  ('f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-0000000000c1', '2030-02-05', '08:00'),
  ('f0000000-0000-4000-8000-0000000000e2', 'f0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-0000000000c2', '2030-02-05', '08:00');
insert into public.customers (id, operator_id, name)
values ('f0000000-0000-4000-8000-0000000000a1', 'f0000000-0000-4000-8000-000000000001', 'Solo Nombre');

-- ============================================================================
-- triggers on the system path
-- ============================================================================

insert into public.reservations (id, operator_id, departure_id, customer_id, people)
values ('f0000000-0000-4000-8000-0000000000b1', 'f0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-0000000000a1', 3);

select is(
  (select code from public.reservations where id = 'f0000000-0000-4000-8000-0000000000b1'),
  'D-000001',
  'the first reservation of an operator is D-000001'
);
select is(
  (select seats_booked from public.tour_departures where id = 'f0000000-0000-4000-8000-0000000000e1'),
  3,
  'an insert takes its people from the counter'
);
select is(
  (select row(unit_price_minor, currency::text, total_minor, amount_overridden)::text
   from public.reservation_amounts where reservation_id = 'f0000000-0000-4000-8000-0000000000b1'),
  '(2500,USD,7500,f)',
  'the amount snapshot is the direct price times people'
);
select ok(
  (select has_incomplete_data from public.reservations where id = 'f0000000-0000-4000-8000-0000000000b1'),
  'a customer with neither email nor phone marks the reservation incomplete'
);
select is(
  (select count(*)::int from audit.events
   where record_id = 'f0000000-0000-4000-8000-0000000000b1' and op = 'insert'),
  2,
  'the reservation and its amount row are audited under the reservation id'
);

select throws_ok(
  $q$ insert into public.reservations (operator_id, departure_id, customer_id, people)
      values ('f0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-0000000000a1', 2) $q$,
  'P0001', 'capacity_exceeded',
  'a create past capacity is refused'
);
select throws_ok(
  $q$ insert into public.reservations (operator_id, departure_id, customer_id, people)
      values ('f0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-0000000000e2', 'f0000000-0000-4000-8000-0000000000a1', 1) $q$,
  'P0001', 'price_missing',
  'a tour without a direct price refuses the create'
);
select throws_ok(
  $q$ insert into public.reservations (operator_id, departure_id, customer_id, people, status)
      values ('f0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-0000000000a1', 1, 'cancelled') $q$,
  'P0001', 'forbidden_transition',
  'a reservation is never born cancelled'
);
select is(
  (select row(seats_booked, (select last_value from private.reservation_counters where operator_id = 'f0000000-0000-4000-8000-000000000001'))::text
   from public.tour_departures where id = 'f0000000-0000-4000-8000-0000000000e1'),
  '(3,1)',
  'refused creates move no seats and consume no code'
);

update public.reservations set people = 4 where id = 'f0000000-0000-4000-8000-0000000000b1';
select is(
  (select row(d.seats_booked, a.total_minor)::text
   from public.tour_departures d, public.reservation_amounts a
   where d.id = 'f0000000-0000-4000-8000-0000000000e1' and a.reservation_id = 'f0000000-0000-4000-8000-0000000000b1'),
  '(4,10000)',
  'a people change moves the counter and recomputes the total'
);

update public.reservation_amounts set total_minor = 9000 where reservation_id = 'f0000000-0000-4000-8000-0000000000b1';
update public.reservations set people = 2 where id = 'f0000000-0000-4000-8000-0000000000b1';
select is(
  (select row(total_minor, amount_overridden)::text from public.reservation_amounts
   where reservation_id = 'f0000000-0000-4000-8000-0000000000b1'),
  '(9000,t)',
  'a direct total update is an override that people changes keep'
);

update public.customers set phone = '+506 8888 0000' where id = 'f0000000-0000-4000-8000-0000000000a1';
select ok(
  not (select has_incomplete_data from public.reservations where id = 'f0000000-0000-4000-8000-0000000000b1'),
  'adding a phone clears the flag'
);

select throws_ok(
  $q$ update public.reservations set status = 'cancelled' where id = 'f0000000-0000-4000-8000-0000000000b1' $q$,
  '23514', null,
  'cancelling without a reason violates reservations_cancel_reason_required'
);
select throws_ok(
  $q$ update public.reservations set status = 'pending_review' where id = 'f0000000-0000-4000-8000-0000000000b1' $q$,
  'P0001', 'forbidden_transition',
  'confirmed never goes back to pending_review'
);
update public.reservations set status = 'cancelled', cancel_reason = 'cliente' where id = 'f0000000-0000-4000-8000-0000000000b1';
select is(
  (select seats_booked from public.tour_departures where id = 'f0000000-0000-4000-8000-0000000000e1'),
  0,
  'cancelling releases the seats'
);
select throws_ok(
  $q$ update public.reservations set status = 'confirmed' where id = 'f0000000-0000-4000-8000-0000000000b1' $q$,
  'P0001', 'forbidden_transition',
  'cancelled is terminal'
);
select throws_ok(
  $q$ update public.reservations set people = 1 where id = 'f0000000-0000-4000-8000-0000000000b1' $q$,
  'P0001', 'forbidden_transition',
  'a cancelled reservation is read-only'
);

-- the reconciliation runbook (the jwt paths are covered by the db suite).
insert into public.reservations (id, operator_id, departure_id, customer_id, people)
values ('f0000000-0000-4000-8000-0000000000b2', 'f0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-0000000000e1', 'f0000000-0000-4000-8000-0000000000a1', 2);
select is(
  (select code from public.reservations where id = 'f0000000-0000-4000-8000-0000000000b2'),
  'D-000002',
  'codes are consecutive per operator'
);
select is_empty(
  $q$ select * from public.admin_seat_drift() where operator_id = 'f0000000-0000-4000-8000-000000000001' $q$,
  'no drift while every write goes through the triggers'
);
update public.tour_departures set seats_booked = 3 where id = 'f0000000-0000-4000-8000-0000000000e1';
select results_eq(
  $q$ select departure_id, seats_booked, held from public.admin_seat_drift()
      where operator_id = 'f0000000-0000-4000-8000-000000000001' $q$,
  $q$ values ('f0000000-0000-4000-8000-0000000000e1'::uuid, 3, 2) $q$,
  'admin_seat_drift reports a corrupted counter'
);
select is(public.admin_reconcile_seats(null), 1, 'admin_reconcile_seats rewrites the one drifting counter');
select is(
  (select seats_booked from public.tour_departures where id = 'f0000000-0000-4000-8000-0000000000e1'),
  2,
  'the counter equals the held sum again'
);

select * from finish();

rollback;
