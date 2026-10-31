# Terminal Expansion Opportunity Screening Score

A deterministic, explainable **screening** score that ranks US airports by public-data signals
that terminal expansion could plausibly be needed and monetized. It is a starting point for
analyst review, **not an investment recommendation**. The score is computed in code
([`scoring.ts`](../apps/server/src/services/scoring.ts)); the LLM only explains it.

## Thesis

1. **Terminals are sized by passenger throughput.** Larger passenger volume is the most direct
   public signal of terminal load and of the revenue base a renovation can monetize.
2. **Growing throughput eventually exceeds terminal capacity.** Growth is the forward-looking signal.
3. **Full aircraft show lasting demand relative to supplied seats.** Load factor is supporting
   evidence, but it is an airline signal (seat supply decisions), not a terminal one.
4. **Operational congestion is context, not terminal evidence.** Delays, NAS delay, taxi-out and
   cancellations come from runways, air traffic control, weather and airline operations. A new
   terminal does not fix those, so this component has the lowest weight.

## Components and weights

| Component | Raw metric (12-month window) | Source | Weight |
|---|---|---|---|
| Passenger scale | Enplaned passengers on departing flights | BTS T-100 (all carriers) | **35%** |
| Passenger growth | Passengers vs the previous 12 months | BTS T-100 | **35%** |
| Seat demand pressure | Load factor = passengers / seats | BTS T-100 | **20%** |
| Operational congestion proxy | Mean percentile of: arrival delay rate (15+ min), NAS delay minutes per arrival, average taxi-out, cancellation rate | BTS On-Time (large US carriers, domestic) | **10%** |

**Method**
- **Universe:** airports with at least 250,000 annual passengers (about 180 airports). Smaller
  airports are not scored.
- **Percentiles:** each component is converted to a percentile (0–100) within the universe, with
  tied values sharing their average rank. Units therefore don't matter, and a single outlier
  can't dominate.
- **Score:** the weighted mean of the component percentiles (0–100), stored with each
  component's raw value, percentile, weight, contribution and caveat.
- **Fully deterministic:** the same inputs always give the same scores and ranks (unit-tested).

### Why the weights look like this

Most of the weight goes to the two signals most directly tied to terminal throughput: scale and
growth. Load factor gets less because it is driven partly by airline seat supply. Operational
congestion gets the least because weighting it heavily would rank airports on problems a terminal
cannot fix (runway or air-traffic-control congestion). A unit test checks that congestion alone
cannot outrank stronger passenger fundamentals.

## Coverage (not confidence)

Each score has a `coverage` level. **Coverage only describes which components could be
computed.** It says nothing about data quality, and nothing about how confident anyone should be
in the investment case.

| Coverage | Meaning |
|---|---|
| `full` | All four components are available |
| `partial` | Only the operational congestion proxy is missing (the airport has too few large-carrier flights in the on-time data) |
| `limited` | A core component is missing. In practice this means growth, when the previous 12 months are incomplete (e.g. new service) |

Scale and load factor are always available for scored airports, since the eligibility rule
requires passengers and seats.

## Missing components: re-normalization and its implications

When a component is missing, it is dropped and the remaining weights are scaled up so they
still sum to 100%. Each score's `notes` field records the weights actually used.

| Missing | Effective weights | Implication |
|---|---|---|
| Congestion proxy | scale 39%, growth 39%, load factor 22% | Small shift. Since congestion is only 10%, these scores remain comparable with `full` ones. |
| Growth | scale 54%, load factor 31%, **congestion 15%** | Large shift. The score becomes mostly a size ranking, and the congestion proxy's influence grows by 50%. Compare `limited` scores with others only with caution. |
| Growth + congestion | scale 64%, load factor 36% | The score is essentially size plus load factor. |

Re-normalization keeps airports rankable instead of dropping them. The cost is that the
`partial`/`limited` scores answer a slightly different question. The alternative, scoring a missing
component as 0, would penalize airports for gaps in data coverage rather than for their
fundamentals. In the current data, every scored airport has a complete prior year, so no
airport is `limited`.

## Limitations

- No public dataset measures terminal capacity directly (gate counts, terminal design capacity,
  checkpoint wait times). Every component is an indirect signal.
- Operational congestion does not establish a need for terminal expansion.
- Load factor also reflects airline seat supply decisions.
- Growth is a single year-over-year comparison; one unusual year can swing it.
- On-time data covers only domestic flights of large US carriers. T-100 covers all carriers.
- Scope: the 50 states plus DC. US territories (e.g. SJU, GUM) are excluded.
- The weights are analyst judgment. They are explicit and versioned (`SCORING_MODEL`) so they
  can be challenged and changed.

## Data integrity notes

- **Sources are never joined on airport names,** which differ between sources (SNA is "John Wayne
  Airport-Orange County" in BTS). OurAirports joins to T-100 on IATA code.
- **On-time joins on BTS's numeric airport ID,** which stays the same when a code changes. Example:
  Palm Beach was renamed `PBI` → `DJT`. T-100 and OurAirports use `DJT`, while the on-time files
  still report `PBI`; the ID maps them to the same airport.
- **Code fallback:** an airport without a BTS ID falls back to its code, accepted only if the
  states agree. Verified exception: DCA (OurAirports: DC, BTS: VA).

## Future improvements (not implemented)

- **Estimated peak-hour passengers:** (scheduled departures in the busiest hour) × (average seats
  per departure). FAA terminal planning sizes terminals on peak-hour passengers, so this would be
  the most terminal-relevant signal available. Not added yet because it depends on extra
  assumptions: hourly schedules come from large carriers only, and seats are not passengers. It
  is currently reported as context (`peakHourDeparturesPerDay`), not scored.
- **TSA checkpoint throughput:** TSA appears to publish hourly per-checkpoint throughput as PDFs
  in its FOIA reading room. This needs verification and PDF parsing.
- **Multi-year growth** (e.g. a 3-year CAGR), to reduce sensitivity to a single unusual year.
