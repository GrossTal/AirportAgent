CREATE TABLE "airport_month_ops" (
	"code" varchar(3) NOT NULL,
	"month" date NOT NULL,
	"days_in_month" integer NOT NULL,
	"dep_scheduled" integer NOT NULL,
	"dep_cancelled" integer NOT NULL,
	"dep_operated" integer NOT NULL,
	"dep_delayed15" integer NOT NULL,
	"dep_delay_minutes" double precision NOT NULL,
	"taxi_out_minutes" double precision NOT NULL,
	"taxi_out_count" integer NOT NULL,
	"arr_scheduled" integer NOT NULL,
	"arr_flights" integer NOT NULL,
	"arr_delayed15" integer NOT NULL,
	"arr_delay_minutes" double precision NOT NULL,
	"nas_delay_minutes" double precision NOT NULL,
	"taxi_in_minutes" double precision NOT NULL,
	"taxi_in_count" integer NOT NULL,
	"dep_by_distance_group" jsonb NOT NULL,
	"dep_by_hour" jsonb NOT NULL,
	"source_id" text NOT NULL,
	CONSTRAINT "airport_month_ops_code_month_pk" PRIMARY KEY("code","month")
);
--> statement-breakpoint
CREATE TABLE "airport_month_traffic" (
	"code" varchar(3) NOT NULL,
	"month" date NOT NULL,
	"departures" integer NOT NULL,
	"passengers" integer NOT NULL,
	"seats" integer NOT NULL,
	"domestic_departures" integer NOT NULL,
	"domestic_passengers" integer NOT NULL,
	"domestic_seats" integer NOT NULL,
	"intl_departures" integer NOT NULL,
	"intl_passengers" integer NOT NULL,
	"intl_seats" integer NOT NULL,
	"freight_lbs" double precision NOT NULL,
	"mail_lbs" double precision NOT NULL,
	"avg_distance_per_flight" double precision,
	"source_id" text NOT NULL,
	CONSTRAINT "airport_month_traffic_code_month_pk" PRIMARY KEY("code","month")
);
--> statement-breakpoint
CREATE TABLE "airport_scores" (
	"code" varchar(3) NOT NULL,
	"score_version" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"score" double precision NOT NULL,
	"rank" integer NOT NULL,
	"universe_size" integer NOT NULL,
	"confidence" text NOT NULL,
	"components" jsonb NOT NULL,
	"notes" jsonb NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "airport_scores_code_score_version_pk" PRIMARY KEY("code","score_version")
);
--> statement-breakpoint
CREATE TABLE "airports" (
	"code" varchar(3) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"city" text,
	"state" varchar(2) NOT NULL,
	"census_division" text NOT NULL,
	"census_region" text NOT NULL,
	"airport_type" text NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"description" text NOT NULL,
	"period_start" date,
	"period_end" date,
	"row_count" integer DEFAULT 0 NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "airport_month_ops" ADD CONSTRAINT "airport_month_ops_code_airports_code_fk" FOREIGN KEY ("code") REFERENCES "public"."airports"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "airport_month_ops" ADD CONSTRAINT "airport_month_ops_source_id_data_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."data_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "airport_month_traffic" ADD CONSTRAINT "airport_month_traffic_code_airports_code_fk" FOREIGN KEY ("code") REFERENCES "public"."airports"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "airport_month_traffic" ADD CONSTRAINT "airport_month_traffic_source_id_data_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."data_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "airport_scores" ADD CONSTRAINT "airport_scores_code_airports_code_fk" FOREIGN KEY ("code") REFERENCES "public"."airports"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "airport_scores_rank_idx" ON "airport_scores" USING btree ("score_version","rank");--> statement-breakpoint
CREATE INDEX "airports_state_idx" ON "airports" USING btree ("state");--> statement-breakpoint
CREATE INDEX "airports_division_idx" ON "airports" USING btree ("census_division");