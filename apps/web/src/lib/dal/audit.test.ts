import { describe, expect, it, vi } from "vitest";
import es from "../../../messages/es.json";

// audit.ts is server-only; the diff is pure and tested here without a database.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

import { buildHistory, changedKeys, historyReferences, type AuditEvent, type HistoryLabels } from "./audit";

const RESERVATION = "e0000000-0000-4000-8000-000000000001";
const DEPARTURE_1 = "1d000000-0000-4000-8000-000000000001";
const DEPARTURE_2 = "1d000000-0000-4000-8000-000000000002";
const CUSTOMER = "c0000000-0000-4000-8000-000000000001";
const ADMIN = "a0000000-0000-4000-8000-000000000001";
const GONE = "a0000000-0000-4000-8000-0000000000ff";
const OPERATOR = "0a000000-0000-4000-8000-00000000000a";

const reservation = {
  id: RESERVATION,
  operator_id: OPERATOR,
  code: "D-000007",
  channel: "direct",
  external_code: null,
  departure_id: DEPARTURE_1,
  customer_id: CUSTOMER,
  people: 2,
  status: "confirmed",
  has_incomplete_data: false,
  cancel_reason: null,
  created_by: ADMIN,
  created_at: "2026-11-12T14:00:00+00:00",
  updated_at: "2026-11-12T14:00:00+00:00",
};

const amount = {
  reservation_id: RESERVATION,
  operator_id: OPERATOR,
  unit_price_minor: 5000,
  currency: "USD",
  total_minor: 10000,
  amount_overridden: false,
  created_at: "2026-11-12T14:00:00+00:00",
  updated_at: "2026-11-12T14:00:00+00:00",
};

const notes = {
  reservation_id: RESERVATION,
  operator_id: OPERATOR,
  notes: "Vegetariana",
  created_at: "2026-11-12T14:00:00+00:00",
  updated_at: "2026-11-12T14:00:00+00:00",
};

let nextId = 1;

function event(fields: Partial<AuditEvent> & Pick<AuditEvent, "table_name" | "op" | "at">): AuditEvent {
  return { id: nextId++, old_record: null, new_record: null, actor_id: ADMIN, actor_source: "jwt", ...fields };
}

const labels: HistoryLabels = {
  departures: new Map([
    [DEPARTURE_1, { tourName: "Volcán", date: "2026-11-24", startTime: "08:00" }],
    [DEPARTURE_2, { tourName: "Volcán", date: "2026-11-25", startTime: "13:30" }],
  ]),
  customers: new Map([[CUSTOMER, "Ana Pérez"]]),
  actors: new Map([[ADMIN, "Admin A"]]),
};

const T1 = "2026-11-12T14:00:00.100000+00:00";
const T2 = "2026-11-12T15:00:00.200000+00:00";
const T3 = "2026-11-12T16:00:00.300000+00:00";

describe("changedKeys", () => {
  it("lists only changed keys, without the noise keys, in display order", () => {
    const after = { ...reservation, people: 3, departure_id: DEPARTURE_2, updated_at: "2026-11-12T15:00:00+00:00" };
    expect(changedKeys(reservation, after)).toEqual(["departure_id", "people"]);
    expect(changedKeys(reservation, { ...reservation, updated_at: "later", created_at: "x", operator_id: "y", id: "z" })).toEqual([]);
  });

  it("lists the non-null values of an insert and of a delete", () => {
    expect(changedKeys(null, reservation)).toEqual(["status", "departure_id", "people", "customer_id", "has_incomplete_data", "code", "channel"]);
    expect(changedKeys(amount, null)).toEqual(["total_minor", "unit_price_minor", "currency", "amount_overridden"]);
  });
});

describe("buildHistory", () => {
  const created = [
    event({ table_name: "reservations", op: "insert", at: T1, new_record: reservation }),
    event({ table_name: "reservation_amounts", op: "insert", at: T1, new_record: amount }),
  ];
  const edited = [
    event({
      table_name: "reservations",
      op: "update",
      at: T2,
      old_record: reservation,
      new_record: { ...reservation, people: 3, departure_id: DEPARTURE_2, updated_at: T2 },
    }),
    event({
      table_name: "reservation_amounts",
      op: "update",
      at: T2,
      old_record: amount,
      new_record: { ...amount, total_minor: 15000, updated_at: T2 },
    }),
  ];
  const cancelled = event({
    table_name: "reservations",
    op: "update",
    at: T3,
    old_record: { ...reservation, people: 3, departure_id: DEPARTURE_2 },
    new_record: { ...reservation, people: 3, departure_id: DEPARTURE_2, status: "cancelled", cancel_reason: "El cliente no viaja" },
  });

  it("groups one transaction into one entry, newest first, and renders only changed keys", () => {
    const history = buildHistory([...created, ...edited, cancelled], labels);
    expect(history.map((entry) => [entry.action, entry.at])).toEqual([
      ["cancelled", T3],
      ["updated", T2],
      ["created", T1],
    ]);
    expect(history[0].changes).toEqual([
      { subject: "reservation", field: "status", before: { kind: "status", value: "confirmed" }, after: { kind: "status", value: "cancelled" } },
      { subject: "reservation", field: "cancel_reason", before: { kind: "empty" }, after: { kind: "reason", value: "El cliente no viaja" } },
    ]);
    expect(history[1].changes.map((change) => `${change.subject}.${change.field}`)).toEqual([
      "reservation.departure_id",
      "reservation.people",
      "amount.total_minor",
    ]);
    expect(history[2].changes.map((change) => change.field)).toEqual([
      "status",
      "departure_id",
      "people",
      "customer_id",
      "has_incomplete_data",
      "code",
      "channel",
      "total_minor",
      "unit_price_minor",
      "currency",
      "amount_overridden",
    ]);
  });

  it("resolves departure and customer ids to labels, amounts to money, and unknown ids to null labels", () => {
    const [, update, create] = buildHistory([...created, ...edited, cancelled], labels);
    expect(update.changes[0]).toMatchObject({
      before: { kind: "departure", label: { tourName: "Volcán", date: "2026-11-24", startTime: "08:00" } },
      after: { kind: "departure", label: { tourName: "Volcán", date: "2026-11-25", startTime: "13:30" } },
    });
    expect(update.changes[2]).toMatchObject({
      before: { kind: "money", minor: 10000, currency: "USD" },
      after: { kind: "money", minor: 15000, currency: "USD" },
    });
    expect(create.changes.find((change) => change.field === "customer_id")?.after).toEqual({ kind: "customer", name: "Ana Pérez" });
    expect(create.changes.find((change) => change.field === "has_incomplete_data")?.after).toEqual({ kind: "boolean", value: false });

    const unknown = { departures: new Map(), customers: new Map(), actors: labels.actors };
    const [entry] = buildHistory([created[0]], unknown);
    expect(entry.changes.find((change) => change.field === "departure_id")?.after).toEqual({ kind: "departure", label: null });
    expect(entry.changes.find((change) => change.field === "customer_id")?.after).toEqual({ kind: "customer", name: null });
  });

  it("resolves the actor: the profile name, Sistema for system rows, Usuario eliminado for a missing profile", () => {
    const flag = (fields: Partial<AuditEvent>, at: string) =>
      event({
        table_name: "reservations",
        op: "update",
        at,
        old_record: { ...reservation, has_incomplete_data: true },
        new_record: reservation,
        ...fields,
      });
    const history = buildHistory(
      [flag({}, T1), flag({ actor_id: null, actor_source: "system" }, T2), flag({ actor_id: GONE, actor_source: "app" }, T3)],
      labels,
    );
    expect(history.map((entry) => entry.actor)).toEqual([{ kind: "deleted_user" }, { kind: "system" }, { kind: "user", name: "Admin A" }]);
    // The labels the history component shows for those two kinds.
    expect(es.history.actor.system).toBe("Sistema");
    expect(es.history.actor.deleted_user).toBe("Usuario eliminado");
  });

  it("does not merge different actors at the same instant, ignores other tables and drops entries without visible changes", () => {
    const history = buildHistory(
      [
        event({ table_name: "reservations", op: "update", at: T1, old_record: reservation, new_record: { ...reservation, people: 4 } }),
        event({ table_name: "reservations", op: "update", at: T1, actor_id: null, actor_source: "system", old_record: reservation, new_record: { ...reservation, people: 5 } }),
        event({ table_name: "tour_departures", op: "update", at: T2, old_record: { seats_booked: 1 }, new_record: { seats_booked: 2 } }),
        event({ table_name: "reservations", op: "update", at: T3, old_record: reservation, new_record: { ...reservation, updated_at: T3 } }),
      ],
      labels,
    );
    expect(history.map((entry) => [entry.at, entry.actor.kind])).toEqual([
      [T1, "system"],
      [T1, "user"],
    ]);
  });
});

describe("buildHistory with notes (U8: reservation_notes is audited)", () => {
  it("puts the notes of a create between the reservation and the amount, and shows a notes-only edit as an update", () => {
    const history = buildHistory(
      [
        event({ table_name: "reservation_amounts", op: "insert", at: T1, new_record: amount }),
        event({ table_name: "reservation_notes", op: "insert", at: T1, new_record: notes }),
        event({ table_name: "reservations", op: "insert", at: T1, new_record: reservation }),
        event({
          table_name: "reservation_notes",
          op: "update",
          at: T2,
          old_record: notes,
          new_record: { ...notes, notes: "Vegetariana, llega tarde", updated_at: T2 },
        }),
      ],
      labels,
    );
    expect(history.map((entry) => entry.action)).toEqual(["updated", "created"]);
    expect(history[0].changes).toEqual([
      {
        subject: "notes",
        field: "notes",
        before: { kind: "text", value: "Vegetariana" },
        after: { kind: "text", value: "Vegetariana, llega tarde" },
      },
    ]);
    const subjects = history[1].changes.map((change) => change.subject);
    expect(subjects.indexOf("notes")).toBeGreaterThan(subjects.lastIndexOf("reservation"));
    expect(subjects.lastIndexOf("notes")).toBeLessThan(subjects.indexOf("amount"));
    expect(history[1].changes.find((change) => change.subject === "notes")).toEqual({
      subject: "notes",
      field: "notes",
      before: { kind: "empty" },
      after: { kind: "text", value: "Vegetariana" },
    });
    expect(es.history.fields.notes).toBe("Notas");
  });

  it("shows notes cleared by update_reservation ('') as empty", () => {
    const [entry] = buildHistory(
      [event({ table_name: "reservation_notes", op: "update", at: T3, old_record: notes, new_record: { ...notes, notes: "", updated_at: T3 } })],
      labels,
    );
    expect(entry.changes).toEqual([{ subject: "notes", field: "notes", before: { kind: "text", value: "Vegetariana" }, after: { kind: "empty" } }]);
  });
});

describe("historyReferences", () => {
  it("collects departure and customer ids from both row images and the actors of non-system rows", () => {
    expect(
      historyReferences([
        event({ table_name: "reservations", op: "update", at: T1, old_record: reservation, new_record: { ...reservation, departure_id: DEPARTURE_2 } }),
        event({ table_name: "reservations", op: "update", at: T2, actor_id: GONE, actor_source: "system", new_record: reservation }),
      ]),
    ).toEqual({ departureIds: [DEPARTURE_1, DEPARTURE_2], customerIds: [CUSTOMER], actorIds: [ADMIN] });
  });
});
