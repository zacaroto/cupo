-- ============================================================================
-- guides: the guía-to-guide link rules and private.my_guide_ids() (r19, u4)
-- ============================================================================
-- self-contained: creates its own operator, auth users and guide inside one
-- transaction that is rolled back, so it does not depend on the seed users.

begin;

create extension if not exists pgtap with schema extensions;

select plan(12);

insert into public.operators (id, name, slug, timezone, currency)
values ('d0000000-0000-4000-8000-000000000001', 'Pgtap Guides', 'pgtap-guides', 'America/Costa_Rica', 'USD');

insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data)
values
  ('d0000000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pgtap-guide@cupo.test', '{}'),
  ('d0000000-0000-4000-8000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'pgtap-other@cupo.test', '{}');

insert into public.guides (id, operator_id, name, email)
values ('d0000000-0000-4000-8000-0000000000b1', 'd0000000-0000-4000-8000-000000000001', 'Pgtap Guide', 'pgtap-guide@cupo.test');

-- memberships side: a guía needs an active guide linked to them.
select throws_ok(
  $q$ insert into public.memberships (user_id, operator_id, role)
      values ('d0000000-0000-4000-8000-0000000000a1', 'd0000000-0000-4000-8000-000000000001', 'guia') $q$,
  'P0001', 'guide_not_linked',
  'a guía membership without a linked guide is rejected'
);

update public.guides set user_id = 'd0000000-0000-4000-8000-0000000000a1'
where id = 'd0000000-0000-4000-8000-0000000000b1';

select lives_ok(
  $q$ insert into public.memberships (user_id, operator_id, role)
      values ('d0000000-0000-4000-8000-0000000000a1', 'd0000000-0000-4000-8000-000000000001', 'guia') $q$,
  'after linking the guide the guía membership is accepted'
);

select throws_ok(
  $q$ insert into public.memberships (user_id, operator_id, role)
      values ('d0000000-0000-4000-8000-0000000000a2', 'd0000000-0000-4000-8000-000000000001', 'reservas');
      update public.memberships set role = 'guia'
      where user_id = 'd0000000-0000-4000-8000-0000000000a2' $q$,
  'P0001', 'guide_not_linked',
  'promoting a member to guía without a linked guide is rejected'
);

-- guides side: the link cannot move or be cleared while the account holds the role.
select throws_ok(
  $q$ update public.guides set user_id = 'd0000000-0000-4000-8000-0000000000a2'
      where id = 'd0000000-0000-4000-8000-0000000000b1' $q$,
  'P0001', 'guide_has_access',
  'relinking a guide whose account holds the guía role is rejected'
);

select throws_ok(
  $q$ delete from public.guides where id = 'd0000000-0000-4000-8000-0000000000b1' $q$,
  'P0001', 'guide_has_access',
  'deleting a guide whose account holds the guía role is rejected'
);

-- my_guide_ids() for the linked guía, and nothing for another user.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
select results_eq(
  $q$ select private.my_guide_ids() $q$,
  $q$ values ('d0000000-0000-4000-8000-0000000000b1'::uuid) $q$,
  'my_guide_ids() returns the guide of the linked guía'
);
select results_eq(
  $q$ select id from public.guides $q$,
  $q$ values ('d0000000-0000-4000-8000-0000000000b1'::uuid) $q$,
  'the guía reads their own guide row'
);
select set_config('request.jwt.claims', '{"sub":"d0000000-0000-4000-8000-0000000000a2","role":"authenticated"}', true);
select is_empty($q$ select private.my_guide_ids() $q$, 'my_guide_ids() is empty for a user who is not a linked guía');
reset role;
-- back to a session without a jwt user (the definer insert guards read auth.uid()).
select set_config('request.jwt.claims', '{}', true);

-- deactivation revokes the access in the same statement.
update public.guides set active = false where id = 'd0000000-0000-4000-8000-0000000000b1';
select is_empty(
  $q$ select 1 from public.memberships
      where user_id = 'd0000000-0000-4000-8000-0000000000a1' and role = 'guia' $q$,
  'deactivating a guide deletes the guía membership'
);
select throws_ok(
  $q$ insert into public.memberships (user_id, operator_id, role)
      values ('d0000000-0000-4000-8000-0000000000a1', 'd0000000-0000-4000-8000-000000000001', 'guia') $q$,
  'P0001', 'guide_not_linked',
  'an inactive guide grants no guía membership'
);

-- deleting the auth user of a guide with access is not blocked by the link rule.
update public.guides set active = true where id = 'd0000000-0000-4000-8000-0000000000b1';
insert into public.memberships (user_id, operator_id, role)
values ('d0000000-0000-4000-8000-0000000000a1', 'd0000000-0000-4000-8000-000000000001', 'guia');
select lives_ok(
  $q$ delete from auth.users where id = 'd0000000-0000-4000-8000-0000000000a1' $q$,
  'deleting the auth user of a guide with access succeeds'
);
select is(
  (select user_id from public.guides where id = 'd0000000-0000-4000-8000-0000000000b1'),
  null,
  'the guide survives the account with user_id set to null'
);

select * from finish();

rollback;
