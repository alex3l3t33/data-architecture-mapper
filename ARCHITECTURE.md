# Architecture

## Design principles

Data Architecture Mapper is deterministic, local-first, evidence-backed, and fail-soft. A malformed file produces a diagnostic; it does not abort the project scan. No missing value is fabricated. Explicit, defaulted, inferred, and unknown values have distinct provenance in the normalized model.

Every graph edge follows data direction. For example, an application's consumption is represented `topic → application`, while production is `application → topic`. Association edges such as `HOSTED_ON` remain available for grouping but are excluded from lineage traversal.

## Modules

```text
Vault files
   │
   ▼
FileDiscovery ── include/exclude/glob/generated-folder guard
   │
   ▼
ParserRegistry ── JSON/YAML/properties/frontmatter, fail-soft diagnostics
   │
   ├── KafkaConnectParser
   ├── TopicParser
   ├── ApplicationParser
   └── ArchitectureDescriptorParser
   │
   ▼
GraphBuilder ── normalized IDs, provenance, endpoints, topics, SMTs
   │
   ├── LineageAnalyzer
   ├── ValidationEngine
   ├── EnvironmentComparator
   ├── SnapshotService
   ├── MermaidGenerator
   └── MarkdownGenerator
   │
   ▼
Dashboard / generated vault documentation
```

## Stable identity

Component IDs combine project, environment, component type, optional scope, and name. Kafka topics additionally include their Kafka-cluster component ID as scope. Therefore `orders` on DEV/primary, DEV/secondary, and PRODUCTION/primary are three independent nodes.

Relationships use the stable tuple `from | relationship type | to`. Duplicate evidence merges without duplicating edges. Conflicting explicit component definitions remain attached in `_conflicts` for validation.

## Incremental state

`ArchitectureEngine` caches parsed artifacts per project and source path with mtime and size. A full scan reuses unchanged entries. Vault events update or remove only affected cache entries and rebuild the normalized graph from the cache. Generated documentation is outside discovery, preventing feedback loops.

## Security boundaries

Redaction occurs when parser output enters the normalized pipeline and again when snapshots are captured. Sensitive key patterns, URI credentials, JAAS values, and secret environment references are replaced with `[REDACTED]`. Generated output has no raw configuration payload.

The connector export command generator and desktop script launcher are separate from static discovery. The former generates terminal commands for user-selected endpoints. The latter resolves the selected script inside the vault and runs it only after explicit confirmation.

## Large graphs

The interactive graph is filterable and supports focused selection. Markdown generation partitions diagrams by environment and Kafka cluster after 200 nodes rather than emitting a single unusable diagram. The normalized model itself has no fixed topology limit.

## Extension points

- Implement `ArtifactParser` and add it to `ParserRegistry` for new static formats.
- Add validation methods that emit the complete `ValidationFinding` contract.
- Implement `ReadOnlyInfrastructureIntegration` only behind explicit user configuration.
- Add graph exporters without changing discovery or normalization.
