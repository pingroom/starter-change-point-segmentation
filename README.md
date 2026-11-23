# Change-point segmentation with PingRoom

Split a frozen measurement sequence into contiguous constant-mean segments after its owner selects a documented change penalty. Code minimizes squared fitting error plus a penalty for each internal boundary. The output records exact means, errors, boundaries and the owner's selection.

Use this after exporting an ordered series from a measurement pipeline. This starter writes local JSON only. It does not label anomalies, infer causes, estimate confidence or predict future values.

## Try it offline

Choose **Use this template**, clone your copy and use Node.js 22 or newer:

```sh
npm ci
npm test
npm run demo
```

The demo compares three penalty choices on fictional measurements, plus Unknown. Tests and demos use published `@pingroom/sdk` **0.8.0** through local mock transports. After installation they need no credentials or network and send no live pings. The lockfile pins dependencies; `.npmrc` requests a 14-day release age where supported by npm.

## Prepare a series

```sh
cp examples/series.json series.json
cp config.example.json config.json
npm run preview
```

| Field | Contract |
| --- | --- |
| `seriesId` | 1–40 characters: lowercase letter first, then lowercase letters, digits, `_` or `-`. |
| `title`, `context`, `unit` | Nonempty trimmed single lines, at most 40, 80 and 12 UTF-16 code units. The unit describes each integer measurement, such as `ms`. |
| `measurements` | 1–64 signed integers between −1,000,000 and 1,000,000, in their original order. |
| `profiles` | 1–3 `{id, label, reference, penalty}` records describing documented analysis settings. |
| Profile `id` | At most 12 characters using the `seriesId` alphabet; unique. `unknown`, `constructor`, `prototype` and `__proto__` are reserved. |
| `label`, `reference` | Trimmed single lines, at most 24 and 40 UTF-16 units. Labels are unique and cannot be `Unknown`, ignoring case. |
| `penalty` | A distinct integer from 0 to 1,000,000,000,000, in squared measurement units per additional segment. |

The entire Question must fit 500 UTF-16 units and the input file 64 KiB. Preview validates both the input and the Question. Extra fields, sparse arrays, malformed Unicode, control/format characters and fractional measurements or penalties are rejected. Measurement order and profile order are preserved.

Verify the export's order, sampling convention and unit before starting. For fractional source measurements, define a fixed integer scale in your adapter and document it; scaling values by a factor of `k` requires scaling a comparable penalty by `k²`. This model gives every sample equal weight and uses index positions, not elapsed time.

## Connect and choose a profile

Install [PingRoom](https://pingroom.io/i), then:

```sh
npm run connect
npm run inspect
```

Approve pairing and grant a standard private room containing the series owner, with room-list and Question create/read permissions. Verify the person in the app and enter their exact member UUID and a descriptive label in `config.json`. Names alone do not establish identity.

For an existing granted connection, copy `.env.example` to `.env` and set **both** `PINGROOM_TOKEN` and `PINGROOM_ROOM`. Partial or blank pairs are rejected; credential sources cannot be mixed.

```sh
npm run preview
npm start
# After the owner answers:
npm start
npm run export
```

Each run creates at most one direct, 15-minute Question or reads the original Question once. The owner selects a documented penalty profile or **Unknown**. The Question includes each penalty and reference and identifies its squared units. Raw measurements stay local. PingRoom receives the series ID, title/context, unit, profile labels/references/penalties, owner UUID and input/measurements/policy hashes.

Missing, Unknown, expired, cancelled, invalid or misattributed answers withhold export. There is no background polling or replacement Question.

## Read the result

```sh
npm run status
npm run report
npm run export
```

These commands run locally without credentials. `report` writes `state.segmentation/report.json`, including incomplete selection evidence. Completed `export` writes private `state.segmentation/segmentation.json` with the frozen source, attributed choice, source hash and analysis.

For a segment of length `m`, code computes `SSE = sum(x²) − sum(x)² / m`. The objective is:

```text
totalSse + penaltyPerChange × (segmentCount − 1)
```

`boundaries` contains only internal, zero-based indices. Each segment is a nonempty `[start, end)` range; ranges cover the entire sequence exactly once. `segments` records its count, mean and SSE. `sampleCount`, `segmentCount`, `changeCount`, `totalSse`, `penaltyCost` and `objective` reconcile the calculation. Means, SSE values, `penaltyCost` and `objective` use reduced `{numerator, denominator}` decimal strings with positive denominators; integer results have denominator `"1"`. `penaltyPerChange` retains the selected numeric integer.

The dynamic program considers every final segment of each prefix, giving `n(n+1)/2` candidate transitions. It uses exact BigInt fractions, with no rounding. Ties prefer fewer segments and then lexicographically earlier **numeric** internal boundary indices. Zero penalty still merges adjacent equal values under the fewer-segments rule; a sufficiently large penalty yields one segment. The additive recurrence follows [optimal partitioning](https://pmc.ncbi.nlm.nih.gov/articles/PMC7175693/).

The result is optimal only for this fixed series and objective. A selected penalty is a documented analysis choice, not evidence that a boundary has a physical cause or statistical significance.

## Adapt and resume

Write an adapter that exports your ordered measurements, integer unit and documented penalty choices. Call `solveSegmentation(rawInput, profileId)` in `src/model.js` for the pure calculation; CLI export also requires the owner's attributed selection. Feed the resulting ranges and exact means into your analysis tool. No deployment or external-action adapter is included.

Real inputs, configuration, credentials, state and outputs are ignored by Git. Keep `state.segmentation/` and `.pingroom/` private. Writes are atomic under a local lock; changed input, owner, room or credentials cannot reuse the session.

A lost creation response leaves `create_unknown` and never causes an automatic resend:

```sh
npm run status
npm run find-id
npm run recover -- EXACT-QUESTION-UUID
```

Recover only the original Question. An empty bounded search does not prove creation failed. Resolve or revoke uncertain/expired pairing in Connected Agents before archiving its pending record. Remove a stale `.lock` only after confirming its process stopped. Keep the original input and session while resolving uncertainty.

Run commands serially. Exit codes: `0` complete/local result; `1` invalid setup/evidence or refused export; `2` incomplete/Unknown/failed answer; `3` ready/pending/interrupted; `4` uncertain creation. Local status/report return 0 even for incomplete states; inspect their JSON status.

Tests compare complete partitions against an independent residual-based oracle across 5,460 signed-series/penalty combinations, plus large values, ties, maximum inputs, provenance, recovery, pairing and real CLI subprocesses. GitHub Actions checks Node.js 22 and 24. Live phone delivery is not tested. MIT licensed.
