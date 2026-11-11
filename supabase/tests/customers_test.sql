-- ============================================================================
-- customers: masked display name and grants (plan u9; r11, r27; ktd4)
-- ============================================================================
-- runs with `supabase test db` in one rolled-back transaction. role and
-- cross-operator behavior is covered through the data api in
-- tests/db/customers.test.ts; this file pins the pure helper and the grants.

begin;

create extension if not exists pgtap with schema extensions;

select plan(14);

-- ============================================================================
-- private.customer_display_name: first name plus last initial
-- ============================================================================

select is(private.customer_display_name('Ana María López'), 'Ana L.', 'three words: first name plus last initial');
select is(private.customer_display_name('Ana López'), 'Ana L.', 'two words');
select is(private.customer_display_name('Ana'), 'Ana', 'a single word stays as is');
select is(private.customer_display_name('  Ana   López  '), 'Ana L.', 'surrounding and repeated spaces are ignored');
select is(private.customer_display_name(E'Ana\tlópez'), 'Ana L.', 'tabs separate words and the initial is upper case');
select is(private.customer_display_name('John O''Brien-Smith'), 'John O.', 'punctuation in the last name keeps its first letter');
select is(private.customer_display_name(''), '', 'an empty name yields an empty display');

-- ============================================================================
-- grants (ktd4, r27)
-- ============================================================================

select ok(
  not has_table_privilege('authenticated', 'public.customers', 'delete'),
  'authenticated cannot delete customers (r27)'
);

select ok(
  not has_column_privilege('authenticated', 'public.customers', 'operator_id', 'update'),
  'customers.operator_id cannot be updated by authenticated'
);

select ok(
  has_column_privilege('authenticated', 'public.customers', 'operator_id', 'insert'),
  'customers.operator_id is insertable (the server stamps it, rls checks it)'
);

select ok(
  not has_table_privilege('authenticated', 'public.customer_display', 'insert')
  and not has_table_privilege('authenticated', 'public.customer_display', 'update')
  and not has_table_privilege('authenticated', 'public.customer_display', 'delete'),
  'customer_display has no write grant for authenticated'
);

-- ============================================================================
-- audit exclusion (ktd6) and the display trigger
-- ============================================================================

select is_empty(
  $q$
    select t.tgname
    from pg_trigger t
    join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.customers'::regclass
      and p.proname = 'record_change'
  $q$,
  'customers is not audited (pii erasure, ktd6)'
);

select ok(
  (select prosecdef from pg_proc where oid = 'private.sync_customer_display()'::regprocedure),
  'the display trigger function is security definer'
);

-- the trigger writes the display row for a new customer and follows a rename.
insert into public.customers (id, operator_id, name)
values ('99000000-0000-4000-8000-000000000001', '0a000000-0000-4000-8000-00000000000a', 'Marta Gómez');
update public.customers set name = 'Marta Ruiz' where id = '99000000-0000-4000-8000-000000000001';

select is(
  (select display_name from public.customer_display where customer_id = '99000000-0000-4000-8000-000000000001'),
  'Marta R.',
  'insert creates the display row and a rename updates it'
);

select * from finish();

rollback;
