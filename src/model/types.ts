import type { InfrastructureTimeline } from "../history/infrastructure-changes";

export type Environment = string;

export type InfrastructureComponentType =
  | "infrastructure-cluster"
  | "cluster-node"
  | "edge-node"
  | "cft-service"
  | "kubernetes-namespace"
  | "resource-quota"
  | "mongodb-instance";

export type ComponentType =
  | "application"
  | "kafka-cluster"
  | "kafka-topic"
  | "connect-worker"
  | "kafka-connector"
  | "consumer-group"
  | "database-server"
  | "database"
  | "mongodb-collection"
  | "database-table"
  | "schema-registry"
  | "object-storage"
  | "file-system"
  | "external-source"
  | "external-destination"
  | "dead-letter-queue"
  | "unresolved-dependency"
  | InfrastructureComponentType;

export type RelationshipType =
  | "READS_FROM"
  | "WRITES_TO"
  | "CONSUMES"
  | "PRODUCES"
  | "HOSTED_ON"
  | "BELONGS_TO"
  | "REPLICATES_TO"
  | "USES_SCHEMA"
  | "USES_DATABASE"
  | "ROUTES_ERRORS_TO"
  | "TRANSFORMS";

export type ValueOrigin = "explicit" | "default" | "inferred" | "unknown";

export interface SourceEvidence {
  path: string;
  parser: string;
  location?: string;
  keys?: string[];
  note?: string;
}

export interface ProvenancedValue<T = unknown> {
  value: T;
  origin: ValueOrigin;
  evidence: SourceEvidence[];
}

export interface ArchitectureComponent {
  id: string;
  projectId: string;
  environment: Environment;
  type: ComponentType;
  name: string;
  label: string;
  technology?: string;
  kafkaClusterId?: string;
  infrastructureParentId?: string;
  subprojectIds?: string[];
  properties: Record<string, ProvenancedValue>;
  evidence: SourceEvidence[];
  tags: string[];
  unresolved?: boolean;
}

export interface ArchitectureRelationship {
  id: string;
  projectId: string;
  environment: Environment;
  from: string;
  to: string;
  type: RelationshipType;
  evidence: SourceEvidence[];
  metadata: Record<string, unknown>;
  unresolved?: boolean;
}

export interface ArchitectureGraph {
  projectId: string;
  generatedAt: string;
  components: ArchitectureComponent[];
  relationships: ArchitectureRelationship[];
  diagnostics: ParseDiagnostic[];
}

export interface ParseDiagnostic {
  path: string;
  parser: string;
  severity: "info" | "warning" | "error";
  message: string;
}

export type ArtifactKind =
  | "connector"
  | "topic"
  | "application"
  | "connect-worker"
  | "cluster"
  | "architecture-descriptor"
  | "infrastructure";

export interface ParsedArtifact {
  kind: ArtifactKind;
  name: string;
  environment?: string;
  clusterAlias?: string;
  technology: string;
  config: Record<string, unknown>;
  infrastructure?: {
    type: InfrastructureComponentType;
    cluster?: string;
    edgeNode?: string;
    namespace?: string;
    links?: MongoInstanceLink[];
  };
  evidence: SourceEvidence;
  diagnostics: ParseDiagnostic[];
}

export interface MongoInstanceLink {
  type: "application" | "kafka-connector";
  name: string;
  subproject?: string;
}

export interface DiscoveredFile {
  path: string;
  extension: string;
  mtime: number;
  size: number;
}

export interface ValidationPolicy {
  minimumReplicationFactor?: number;
  requireDlqForSinks?: boolean;
  knownKafkaClusters?: string[];
  severityOverrides?: Record<string, FindingSeverity | "off">;
  ignoredEnvironmentProperties?: string[];
}

export interface EnvironmentRule {
  name: string;
  folderPrefixes: string[];
  propertyValues?: Record<string, string>;
}

export type ConnectExportEnvironment = "DEV" | "STAGING";

export type ConnectExportTarget =
  | { mode: "direct"; url: string; clusterAlias?: string }
  | {
      mode: "kubernetes";
      context: string;
      namespace: string;
      service: string;
      localPort: string;
      servicePort: string;
      clusterAlias?: string;
    };

export interface SubprojectConfig {
  id: string;
  name: string;
  /** Vault folder relative to the parent project's root. */
  folder: string;
}

export interface ProjectConfig {
  id: string;
  name: string;
  rootFolder: string;
  documentationFolder: string;
  includedFolders: string[];
  excludedFolders: string[];
  environments: EnvironmentRule[];
  kafkaClusterAliases: Record<string, string>;
  filePatterns: string[];
  validation: ValidationPolicy;
  automaticRefresh: boolean;
  refreshDebounceMs: number;
  connectExportTargets?: Partial<Record<ConnectExportEnvironment, ConnectExportTarget>>;
  connectScriptPaths?: Partial<Record<ConnectExportEnvironment, string>>;
  subprojects?: SubprojectConfig[];
}

export type FindingSeverity = "info" | "warning" | "error";
export type FindingConfidence = "low" | "medium" | "high";

export interface ValidationFinding {
  id: string;
  ruleId: string;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  affectedComponentIds: string[];
  explanation: string;
  evidence: SourceEvidence[];
  recommendation: string;
}

export interface ArchitectureSnapshot {
  id: string;
  projectId: string;
  name: string;
  capturedAt: string;
  graph: ArchitectureGraph;
  findings: ValidationFinding[];
}

export interface SnapshotDiff {
  addedComponents: string[];
  removedComponents: string[];
  addedRelationships: string[];
  removedRelationships: string[];
  changedComponents: Array<{ id: string; properties: string[] }>;
  introducedCycles: string[][];
  newFindingIds: string[];
}

export interface PropertyDifference {
  componentKey: string;
  property: string;
  values: Record<string, unknown>;
  ignored: boolean;
}

export interface PluginSettings {
  projects: ProjectConfig[];
  activeProjectId?: string;
  snapshots: ArchitectureSnapshot[];
  infrastructureHistory?: Record<string, InfrastructureTimeline>;
}
