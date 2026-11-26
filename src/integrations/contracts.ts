import type { ArchitectureComponent, ArchitectureRelationship, SourceEvidence } from "../model/types";

export interface IntegrationContext {
  projectId: string;
  environment: string;
  signal: AbortSignal;
}

export interface IntegrationResult {
  components: ArchitectureComponent[];
  relationships: ArchitectureRelationship[];
  evidence: SourceEvidence[];
}

/** Future integrations are read-only and opt-in. Static discovery never calls them. */
export interface ReadOnlyInfrastructureIntegration {
  readonly id: string;
  readonly displayName: string;
  testConnection(context: IntegrationContext): Promise<{ ok: boolean; message: string }>;
  discover(context: IntegrationContext): Promise<IntegrationResult>;
}

export type PlannedIntegration =
  | "kafka-connect-rest"
  | "kafka-admin"
  | "schema-registry"
  | "kubernetes-api"
  | "mongodb-metadata"
  | "prometheus";
