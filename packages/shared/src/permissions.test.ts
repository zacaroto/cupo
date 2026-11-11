import { describe, expect, it } from "vitest";
import { Constants } from "./database.types";
import { ACTIONS, PERMISSIONS, ROLES, STAFF_ROLES, can, isRole, isStaffRole, type Action, type Role } from "./permissions";

describe("permission map (KTD4)", () => {
  it("covers exactly the roles of the membership_role enum", () => {
    expect([...ROLES].sort()).toEqual([...Constants.public.Enums.membership_role].sort());
    expect(Object.keys(PERMISSIONS).sort()).toEqual([...ROLES].sort());
  });

  it("reservas cannot read amounts; contabilidad can", () => {
    expect(can("reservas", "amounts.read")).toBe(false);
    expect(can("contabilidad", "amounts.read")).toBe(true);
  });

  it("guía reads the agenda and cannot write reservations", () => {
    expect(can("guia", "reservations.write")).toBe(false);
    expect(can("guia", "agenda.read")).toBe(true);
  });

  it("grants every action in the map to administrador", () => {
    for (const action of ACTIONS) {
      expect(can("administrador", action), action).toBe(true);
    }
  });

  it("gives guía nothing but the agenda", () => {
    expect(PERMISSIONS.guia).toEqual(["agenda.read"]);
  });

  it("keeps contabilidad read-only", () => {
    const writes = PERMISSIONS.contabilidad.filter((action) => !action.endsWith(".read"));
    expect(writes).toEqual([]);
    expect(can("contabilidad", "reservations.write")).toBe(false);
    expect(can("contabilidad", "customers.read_full")).toBe(false);
  });

  it("lets reservas write reservations and customers, create ad hoc departures, never manage members", () => {
    const allowed: Action[] = ["reservations.write", "customers.write", "customers.read_full", "departures.ad_hoc"];
    const denied: Action[] = ["members.invite", "members.write", "departures.write", "tours.write", "audit.read", "amounts.write"];
    for (const action of allowed) expect(can("reservas", action), action).toBe(true);
    for (const action of denied) expect(can("reservas", action), action).toBe(false);
  });

  it("gives full customer data to administrador and reservas only; masked names to contabilidad (R11, KTD4)", () => {
    const full = ROLES.filter((role) => can(role, "customers.read_full")).sort();
    expect(full).toEqual(["administrador", "reservas"]);
    expect(ROLES.filter((role) => can(role, "customers.write")).sort()).toEqual(["administrador", "reservas"]);
    expect(ROLES.filter((role) => can(role, "customers.read")).sort()).toEqual(["administrador", "contabilidad", "reservas"]);
    // Every role that reads full data or writes also opens the customers section.
    for (const role of ROLES) {
      if (can(role, "customers.read_full") || can(role, "customers.write")) expect(can(role, "customers.read"), role).toBe(true);
    }
  });

  it("only lists known actions and no duplicates", () => {
    for (const role of ROLES) {
      const list = PERMISSIONS[role];
      expect(new Set(list).size, role).toBe(list.length);
      for (const action of list) expect(ACTIONS).toContain(action);
    }
  });

  it("denies unknown roles and actions at runtime (untyped input)", () => {
    expect(can("owner" as Role, "agenda.read")).toBe(false);
    expect(can("administrador", "everything" as Action)).toBe(false);
  });

  it("classifies staff roles", () => {
    expect([...STAFF_ROLES].sort()).toEqual(["administrador", "contabilidad", "reservas"]);
    expect(isStaffRole("guia")).toBe(false);
    expect(isStaffRole("contabilidad")).toBe(true);
    expect(isRole("guia")).toBe(true);
    expect(isRole("guía")).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });
});
