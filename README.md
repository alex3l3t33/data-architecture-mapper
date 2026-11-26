# Data Architecture Mapper

Data Architecture Mapper is a local-first Obsidian plugin that discovers Kafka Connect and related data-platform architecture from configuration stored in a vault. It creates an evidence-backed component inventory, data-flow graph, validation findings, interactive dashboard, Mermaid diagrams, and deterministic Markdown documentation.

Static discovery runs locally and only reads configuration files. Connector export and script launch are explicit actions in the dashboard.

## Privacy and external access

Vault scans, diagrams, and history stay local. The plugin has no telemetry. A copied connector export command contacts the Kafka Connect endpoint you configure when you run it in your terminal. Kubernetes exports also use your configured `kubectl` context to reach the Connect service. The optional Ko-fi button opens the author's funding page in your browser.

**Run script** starts a vault-local Bash file that you select and confirm. The script runs under your desktop account and can access the network and files outside the vault with that account's permissions.

## What it discovers

- Any Kafka Connect connector with a `connector.class`, including standalone JSON/properties, Kafka Connect REST exports, ConfigMap-embedded configuration, and Strimzi `KafkaConnector` resources
- Specialized semantics for MongoDB, JDBC, Debezium, HDFS, Elasticsearch, and object-storage connectors
- Connector topics, topic regexes, dynamic source topics, converters, serialization, SMT routing, retries, DLQ settings, batching, flush settings, and consumer/producer overrides
- Strimzi `KafkaTopic` and `KafkaConnect` resources
- Kafka topic JSON, YAML, and properties descriptors
- Spring Boot / Spring Cloud Stream configuration
- Kubernetes Deployments and StatefulSets
- Docker Compose services
- CDP and Kubernetes infrastructure inventories, Kubernetes Node, Namespace and ResourceQuota exports, and MongoDB instances declared in an inventory
- Markdown YAML frontmatter and explicit architecture descriptors for boundaries that static configuration cannot prove

Unknown connector classes remain fully inventoried as generic Kafka Connect connectors. The plugin does not maintain a brittle allow-list of connector vendors.

## Capabilities

- Multiple independently scoped projects and environments
- Recursive discovery with include/exclude folders and glob patterns
- Incremental refresh after vault create, modify, rename, and delete events
- Stable project/environment/cluster-scoped identifiers; same-named topics on different clusters remain distinct
- Fan-in, fan-out, branching, cycles, cross-cluster flows, unresolved regexes, and dynamic dependencies
- Upstream/downstream lineage, shortest and multiple paths, maximum-depth traversal, blast radius, and strongly connected components
- Validation with confidence, evidence, and recommended actions
- Environment property comparison and secret-free local snapshots
- Interactive Cytoscape graph with search, filtering, layouts, zoom/pan, selection, full screen, and Mermaid copy
- Deterministic generated Markdown and JSON in a dedicated output folder
- Secret redaction for credential keys, authenticated URLs, JAAS values, and secret environment references

## Install from a release/build

1. Create `.obsidian/plugins/data-architecture-mapper` inside the target vault.
2. Copy `main.js`, `manifest.json`, and `styles.css` into that folder.
3. Restart Obsidian or reload community plugins.
4. Enable **Data Architecture Mapper** under **Settings → Community plugins**.

## Configure

Open **Settings → Data Architecture Mapper**. For each project, configure:

- Root vault folder containing configuration
- Dedicated generated-documentation folder
- Optional include/exclude folders
- File patterns
- Kafka cluster aliases (`alias=bootstrap.servers`)
- Validation policies
- Automatic incremental refresh

The generated folder is always excluded from discovery. Existing files without the plugin's generated marker are never overwritten.

Open the dashboard from the network ribbon icon or run **Data Architecture Mapper: Open architecture dashboard**. The initial scan is manual; afterward, enabled projects refresh incrementally.

## Subprojects

In **Settings → Data Architecture Mapper**, add named **Subprojects** to a project. Each folder is relative to that project's vault root, such as `apps/order-intake`. The Applications view shows which subproject owns each application, and the **Subproject** selector switches between the full project and one folder's components. The project graph shares Kafka topics across subprojects when their environment, cluster, and topic name match.

When a project has subprojects, **Scan folder…** lets you browse within its root. Selecting a configured subproject switches to that scope. Selecting another folder narrows the connector inventory and Mermaid diagram to that folder.

## Environments

The project defaults map `dev/`, `staging/`, and `prod/` to **DEV**, **STAGING**, and **PRODUCTION**. Manage the labels and folder mappings under **Environments** in the project settings.

An environment folder can sit under the project root or a subproject. The demo keeps shared connector and topic definitions under paths such as `staging/connectors/` and application configs under paths such as `apps/order-intake/staging/`. Use **Environment** to filter the graph and inventories, or **Environment Comparison** to view configuration differences side by side.

## Diagram all connectors in a folder

Open **Connectors** and choose **Scan folder…** to set the active project's vault folder and scan recursively. Select a connector to inspect its source files and dependencies. **Folder Mermaid** shows one diagram per environment in the folder. Select an environment to see its connectors, linked Kafka topics, direct endpoints, and dead-letter queues. Each diagram includes every MongoDB instance linked to the selected connectors and the applications linked to those instances in the same environment. Dotted lines distinguish instance associations from data flow. Use **Full size** to read the labels at their original size in a scrollable panel. The inspector can render a diagram for a single connector. **Generate docs** saves a separate Mermaid note for each environment, linked from `Connector Architecture.md` in the project's documentation folder.

The demo in `examples/connector-pipeline` includes an orders and an audit MongoDB instance in each of DEV, STAGING, and PRODUCTION. Each instance has its own connector and application links.

## Infrastructure inventory and changes

Open **Infrastructure** to find CDP and Kubernetes clusters, worker and edge nodes, CFT services, Kubernetes namespaces and quotas, and MongoDB instances. Select a row to inspect its characteristics and source files. **Generate docs** writes the inventory to `Infrastructure.md`.

Add a YAML or JSON file with an `infrastructure` object to a project folder. Use `clusters` for CDP and Kubernetes cluster records. A cluster can contain `nodes`, `edgeNodes` with `cfts`, and `namespaces` with `quotas`. List MongoDB instances under `mongoInstances` with a unique name for each instance in its environment. Put version, OS, CPU, memory, and other characteristics under each record's `properties`. Set `environment` explicitly for records stored in a shared folder.

You can also scan saved Kubernetes Node, Namespace, and ResourceQuota resources in YAML or JSON, including list exports. Use the `data-architecture-mapper/cluster` annotation to associate them with a named cluster and `data-architecture-mapper/environment` to specify the environment outside its mapped folder. Namespace quotas use the limits and requests under `spec.hard`. Record the Kubernetes control-plane version on the cluster inventory entry.

**Infrastructure Changes** records the first scan as a baseline. Later scans record the previous and new values and the timestamps when the mapper first observed them. For example, a Kubernetes version update, a new RHEL version, and a CPU or memory increase each appear as a changed field. The [sample infrastructure inventory](examples/connector-pipeline/infrastructure.yml) and [previous revision](examples/connector-pipeline/infrastructure.before.yml.sample) provide a demo of those changes.

### Database dependencies

The **Databases** inventory and database inspector show related connectors and applications from the same environment. MongoDB instance links use a unique configured endpoint or explicit `links.connectors` and `links.applications` entries on the instance. Explicit entries accept a component name or an object with `name` and `subproject` when names are shared. The Infrastructure Changes view keeps the workload links and their source evidence from the scan that recorded each change.

## Connector and topic formats

Use Kafka Connect REST JSON for a connector. Put its name at the top level and its properties in `config`. For a sink, `topics` is the comma-separated list of topic names it consumes. For a source with a fixed output, use the connector's output field, such as `topic` for FileStream. The plugin also reads flat definitions, Java properties files, and Strimzi `KafkaConnector` manifests.

Kafka topic definitions can use JSON, YAML, Java properties, or Strimzi `KafkaTopic` manifests. For plain JSON or YAML, use `type: kafka-topic`, `name`, `partitions`, and `replication.factor`. You can add broker config keys such as `cleanup.policy` and `retention.ms`. JSON accepts one object, an array, or an object with a `topics` array. See `examples/connector-pipeline/dev/topics/review-topics.json` and `examples/connector-pipeline/dev/topics/orders.yaml` for working files.

Set the same topic name, environment, and Kafka cluster on the connector reference and topic definition so the graph links them. The example uses `kafka.cluster` on connectors and `cluster` on topic definitions.

## Export DEV and STAGING connector configs

1. Open **Export configs** in the dashboard and choose **DEV** or **STAGING**.
2. For Kubernetes, enter your kubeconfig context, namespace, Connect Service name, and Service port. For Strimzi, the Service is typically `<connect-name>-connect-api` on port `8083`. You can edit the local port and set a Kafka cluster alias for the imported connectors.
3. Copy the command and run it from the vault root in Bash or Zsh. The Kubernetes command starts a localhost port-forward, fetches the connector inventory with curl, and closes its tunnel. Expand **Use separate terminals** to copy each step independently.
4. Refresh the dashboard to scan `kafka-connect-rest-export.json` in the selected environment folder. A successful re-export replaces the previous plugin export. A failed request keeps it intact.

For a Connect endpoint reachable from your terminal, choose **Direct REST URL** and enter the worker or ingress base URL. If the endpoint requires authentication or custom TLS settings, point the terminal variable `DAM_CONNECT_CURL_CONFIG` at a private curl config file kept outside the vault. The generated command uses the expanded Kafka Connect connector list and requires `curl` and `jq`, plus `kubectl` for port-forwarding. The export masks common credential fields and authenticated URLs.

Expand **Launch a script** to enter or save a vault-relative `.sh` path for the selected environment. On Obsidian desktop for macOS and Linux, **Run script** asks you to confirm the exact file and then starts Bash in the vault root. The script receives `DAM_CONNECT_ENVIRONMENT` and the dashboard refreshes after a successful exit. It runs with your desktop account's permissions, so select a script you trust.

## Architecture descriptor

Static configuration cannot prove every organizational boundary. Add an explicit YAML descriptor when needed:

```yaml
architecture:
  name: payment-boundaries
  environment: PRODUCTION
  cluster: primary
  components:
    - id: gateway
      type: application
      name: Payment Gateway
    - id: network
      type: external-destination
      name: Card Network
  relationships:
    - from: gateway
      to: network
      type: WRITES_TO
```

The same descriptor can live in Markdown YAML frontmatter.

## Development

Requirements: Node.js 20 or newer and npm.

```bash
npm install
npm run typecheck
npm test
npm run build
npm run benchmark
```

`npm run dev` watches and rebuilds `main.js`. For vault development, symlink this directory to `.obsidian/plugins/data-architecture-mapper` or copy the three runtime files after each build.

## Security model

All discovered files are treated as untrusted text. Parsing is data-only. Common secrets are masked before entering normalized components, output, snapshots, and the UI. Export commands run in your terminal and use the target you enter. The script launcher runs only the vault-relative file you select and confirm, and keeps its process output out of the plugin.

## Analysis limits

The graph represents evidence found in static configuration. Missing inventory is not proof that infrastructure is missing. Reachability and cycles do not prove message duplication, runtime failure, feedback, or data loss. Findings use confidence levels and wording that preserves this distinction.

See [ARCHITECTURE.md](ARCHITECTURE.md), [IMPLEMENTATION_PROGRESS.md](IMPLEMENTATION_PROGRESS.md), and [COMMUNITY_PLUGIN_SUBMISSION.md](COMMUNITY_PLUGIN_SUBMISSION.md).

## Support the project

You can support Data Architecture Mapper on [Ko-fi](https://ko-fi.com/alexandre42682).
