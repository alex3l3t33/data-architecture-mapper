# Large synthetic project

Run `node generate-stress-fixture.mjs` to produce the deterministic default fixture with 1,000 Kafka topics, 1,000 applications, and 4,000 relationships. Pass a topic count as the first argument to change its size.

The automated benchmark uses the equivalent in-memory fixture in `tests/fixtures/stress.ts`, avoiding a large generated file in source control while preserving a reproducible workload.
