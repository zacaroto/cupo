// Loads demo tours into Operator A of the local stack so the app has realistic
// data to work with (issue #27).
//
//   npx supabase db reset && npm run db:seed-users && npm run db:seed-demo
//
// Three tours with daily schedules in the operator's timezone and a direct
// price each, so reservations can be booked right away; departures are
// materialized on the first booking of a slot. Rows use fixed ids and are
// upserted, so the script is idempotent. Durations, capacities, prices and
// meeting points are placeholders.
//
// Runs on plain Node >= 22.18 (type stripping); refuses any non-local
// Supabase URL. Run the db tests on a fresh reset, without this data.
import { resolve } from "node:path";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@cupo/shared";
import { todayIn } from "@cupo/shared/local-date";
import { assertLocalUrl, loadStackEnv } from "./lib/local-stack.ts";
import { OPERATORS } from "../tests/db/fixtures.ts";

const repoRoot = resolve(import.meta.dirname, "..");
const operator = OPERATORS.a;

type DemoTour = {
  id: string;
  name: string;
  description: string;
  durationMinutes: number;
  capacity: number;
  meetingPoint: string;
  /** Direct price in minor units of the operator currency. */
  priceMinor: number;
  /** Local start times `HH:MM`, every day of the week. */
  times: string[];
};

const TOURS: DemoTour[] = [
  {
    id: "de000000-0000-4000-8000-000000000001",
    name: "Reserva Monteverde",
    description: "Caminata guiada por el bosque nuboso de la Reserva Monteverde.",
    durationMinutes: 150,
    capacity: 12,
    meetingPoint: "Entrada de la Reserva Monteverde",
    priceMinor: 4500,
    times: ["08:00", "09:30", "13:00"],
  },
  {
    id: "de000000-0000-4000-8000-000000000002",
    name: "Curicancha",
    description: "Observación de aves temprano en la Reserva Curicancha.",
    durationMinutes: 180,
    capacity: 10,
    meetingPoint: "Entrada de la Reserva Curicancha",
    priceMinor: 5000,
    times: ["07:00"],
  },
  {
    id: "de000000-0000-4000-8000-000000000003",
    name: "Lantana",
    description: "Tour de la tarde en Lantana.",
    durationMinutes: 120,
    capacity: 15,
    meetingPoint: "Recepción de Lantana",
    priceMinor: 3500,
    times: ["17:00"],
  },
];

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];

async function main(): Promise<void> {
  const stack = loadStackEnv(process.env, repoRoot);
  assertLocalUrl(stack.url, "db:seed-demo");

  const admin = createClient<Database>(stack.url, stack.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const validFrom = todayIn(operator.timezone);

  const tours = await admin.from("tours").upsert(
    TOURS.map((tour) => ({
      id: tour.id,
      operator_id: operator.id,
      name: tour.name,
      description: tour.description,
      duration_minutes: tour.durationMinutes,
      default_capacity: tour.capacity,
      meeting_point: tour.meetingPoint,
      archived_at: null,
    })),
    { onConflict: "id" },
  );
  if (tours.error) throw new Error(`tours: ${tours.error.message}`);

  const prices = await admin.from("tour_prices").upsert(
    TOURS.map((tour) => ({
      operator_id: operator.id,
      tour_id: tour.id,
      channel: "direct" as const,
      price_minor: tour.priceMinor,
      currency: operator.currency,
    })),
    { onConflict: "operator_id,tour_id,channel" },
  );
  if (prices.error) throw new Error(`tour_prices: ${prices.error.message}`);

  const schedules = await admin.from("tour_schedules").upsert(
    TOURS.flatMap((tour) =>
      tour.times.flatMap((time) =>
        WEEKDAYS.map((weekday) => ({
          operator_id: operator.id,
          tour_id: tour.id,
          weekday,
          start_time: time,
          valid_from: validFrom,
        })),
      ),
    ),
    { onConflict: "operator_id,tour_id,weekday,start_time", ignoreDuplicates: true },
  );
  if (schedules.error) throw new Error(`tour_schedules: ${schedules.error.message}`);

  console.log(`seeded demo data into ${operator.name} (${stack.url}):`);
  for (const tour of TOURS) {
    console.log(`  ${tour.name.padEnd(20)} ${tour.times.join(", ")} daily, ${tour.capacity} seats, ${(tour.priceMinor / 100).toFixed(2)} ${operator.currency}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
