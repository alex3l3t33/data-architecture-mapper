import type { ParsedArtifact } from "../model/types";
import { redactedRecord } from "../security/redaction";
import { asString } from "../utils/objects";
import type { ArtifactParser, ParseContext } from "./parser";
import { record } from "./parser";

export class ArchitectureDescriptorParser implements ArtifactParser {
  readonly id = "architecture-descriptor";

  parse(documents: unknown[], context: ParseContext): ParsedArtifact[] {
    const output: ParsedArtifact[] = [];
    for (const value of documents) {
      const document = record(value);
      if (!document) continue;
      const architecture = record(document.dataArchitecture) ?? record(document.architecture);
      if (!architecture) continue;
      output.push({
        kind: "architecture-descriptor",
        name: asString(architecture.name) ?? asString(document.name) ?? context.path,
        environment: asString(architecture.environment) ?? context.environment,
        clusterAlias: asString(architecture.cluster) ?? context.clusterAlias,
        technology: "architecture-descriptor",
        config: redactedRecord(architecture),
        evidence: { path: context.path, parser: this.id, keys: Object.keys(architecture).sort() },
        diagnostics: []
      });
    }
    return output;
  }
}
