import {
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

// Provenance: every fact table row points at the source it came from.
export const dataSources = pgTable("data_sources", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  description: text("description").notNull(),
  periodStart: date("period_start"),
  periodEnd: date("period_end"),
  rowCount: integer("row_count").notNull().default(0),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});

export const airports = pgTable(
  "airports",
  {
    code: varchar("code", { length: 3 }).primaryKey(), // IATA
    // BTS's stable airport ID (survives renames/code changes, e.g. PBI -> DJT). Set by the T-100 step.
    btsAirportId: integer("bts_airport_id"),
    name: text("name").notNull(),
    city: text("city"),
    state: varchar("state", { length: 2 }).notNull(),
    censusDivision: text("census_division").notNull(), // e.g. "New England"
    censusRegion: text("census_region").notNull(), // e.g. "Northeast"
    airportType: text("airport_type").notNull(), // OurAirports type: large_airport, medium_airport, ...
    latitude: doublePrecision("latitude").notNull(),
    longitude: doublePrecision("longitude").notNull(),
  },
  (t) => [index("airports_state_idx").on(t.state), index("airports_division_idx").on(t.censusDivision)],
);

// BTS T-100 segment data summed by origin airport: capacity and demand.
export const airportMonthTraffic = pgTable(
  "airport_month_traffic",
  {
    code: varchar("code", { length: 3 })
      .notNull()
      .references(() => airports.code),
    month: date("month").notNull(), // first day of month
    departures: integer("departures").notNull(),
    passengers: integer("passengers").notNull(), // enplaned on flights departing this airport
    seats: integer("seats").notNull(),
    domesticDepartures: integer("domestic_departures").notNull(),
    domesticPassengers: integer("domestic_passengers").notNull(),
    domesticSeats: integer("domestic_seats").notNull(),
    intlDepartures: integer("intl_departures").notNull(),
    intlPassengers: integer("intl_passengers").notNull(),
    intlSeats: integer("intl_seats").notNull(),
    freightLbs: doublePrecision("freight_lbs").notNull(),
    mailLbs: doublePrecision("mail_lbs").notNull(),
    avgDistancePerFlight: doublePrecision("avg_distance_per_flight"), // statute miles
    sourceId: text("source_id")
      .notNull()
      .references(() => dataSources.id),
  },
  (t) => [primaryKey({ columns: [t.code, t.month] })],
);

// BTS Reporting Carrier On-Time Performance aggregated per airport-month.
// Stored as sums/counts (not averages) so any multi-month window can be re-aggregated exactly.
export const airportMonthOps = pgTable(
  "airport_month_ops",
  {
    code: varchar("code", { length: 3 })
      .notNull()
      .references(() => airports.code),
    month: date("month").notNull(),
    daysInMonth: integer("days_in_month").notNull(),
    // departures (airport as origin)
    depScheduled: integer("dep_scheduled").notNull(),
    depCancelled: integer("dep_cancelled").notNull(),
    depOperated: integer("dep_operated").notNull(),
    depDelayed15: integer("dep_delayed15").notNull(),
    depDelayMinutes: doublePrecision("dep_delay_minutes").notNull(),
    taxiOutMinutes: doublePrecision("taxi_out_minutes").notNull(),
    taxiOutCount: integer("taxi_out_count").notNull(),
    // arrivals (airport as destination)
    arrScheduled: integer("arr_scheduled").notNull(),
    arrFlights: integer("arr_flights").notNull(), // arrived, not cancelled/diverted
    arrDelayed15: integer("arr_delayed15").notNull(),
    arrDelayMinutes: doublePrecision("arr_delay_minutes").notNull(),
    nasDelayMinutes: doublePrecision("nas_delay_minutes").notNull(), // National Airspace System (volume/ATC/airport) delay
    taxiInMinutes: doublePrecision("taxi_in_minutes").notNull(),
    taxiInCount: integer("taxi_in_count").notNull(),
    // histograms
    depByDistanceGroup: jsonb("dep_by_distance_group").$type<number[]>().notNull(), // index = BTS DistanceGroup (250-mile bands)
    depByHour: jsonb("dep_by_hour").$type<number[]>().notNull(), // 24 buckets by scheduled departure hour
    sourceId: text("source_id")
      .notNull()
      .references(() => dataSources.id),
  },
  (t) => [primaryKey({ columns: [t.code, t.month] })],
);

export type ScoreComponent = {
  key: string;
  label: string;
  rawValue: number | null;
  unit: string;
  percentile: number | null;
  weight: number;
  contribution: number;
  caveat: string;
  details?: Record<string, number | null>;
};

export const airportScores = pgTable(
  "airport_scores",
  {
    code: varchar("code", { length: 3 })
      .notNull()
      .references(() => airports.code),
    scoreVersion: text("score_version").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    score: doublePrecision("score").notNull(), // 0-100
    rank: integer("rank").notNull(),
    universeSize: integer("universe_size").notNull(),
    // Which components could be computed (not data quality or investment confidence); see services/scoring.ts.
    coverage: text("coverage").$type<"full" | "partial" | "limited">().notNull(),
    components: jsonb("components").$type<ScoreComponent[]>().notNull(),
    notes: jsonb("notes").$type<string[]>().notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.code, t.scoreVersion] }), index("airport_scores_rank_idx").on(t.scoreVersion, t.rank)],
);
