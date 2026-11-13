# Retain cost provenance in the existing usage journal

The Jmail pilot recorded tokens through Heddle but needed its own ledger for USD charges.
Its native Jev adapter also omitted the meter callback. The requested outcome is to retain
and reproduce the provider/model/stage breakdown without billing journal replays again.

Use additive optional metadata on `Usage`: provider, stage, request ID, and one dollar amount
whose source is either a provider receipt or an estimate. The existing journal already
persists and replays usage arrays, so it remains the only call store. `costBreakdown` reduces
call reports into live and replayed buckets and groups by provider/model/stage/call kind.
Missing costs and missing metering are explicit; failed calls and metered retries count.

An independent project ledger would keep billing outside Heddle, repeating the pilot's
workaround. A built-in price registry would require continual provider pricing updates and
could overwrite actual receipts with estimates. Neither is needed for this request. Keep
reservations and account reconciliation with the experiment; Heddle preserves their receipt
provenance when supplied but does not claim to enforce a spend cap.

Implementation: extend the usage contract; export the reducer; meter Jev's returned usage
with optional caller-supplied input-only pricing; identify the Anthropic provider; document
custom receipt adapters. Verify grouping, invalid values, unknown versus zero, failure/retry
accounting, journal persistence, old token-only compatibility, and replay without a second
provider request using local mocks. No paid calls or cache draws are required.
