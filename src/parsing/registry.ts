import type { ParsedArtifact, ParseDiagnostic } from "../model/types";
import { ArchitectureDescriptorParser } from "./architecture-descriptor-parser";
import { ApplicationParser } from "./application-parser";
import { InfrastructureParser } from "./infrastructure-parser";
import { KafkaConnectParser } from "./kafka-connect-parser";
import type { ArtifactParser, ParseContext } from "./parser";
import { parseStructured } from "./structured";
import { TopicParser } from "./topic-parser";

export interface ParseResult {
  artifacts: ParsedArtifact[];
  diagnostics: ParseDiagnostic[];
}

export class ParserRegistry {
  constructor(private readonly parsers: ArtifactParser[] = [
    new ArchitectureDescriptorParser(),
    new KafkaConnectParser(),
    new TopicParser(),
    new ApplicationParser(),
    new InfrastructureParser()
  ]) {}

  parse(path: string, content: string, context: Omit<ParseContext, "path"> = {}): ParseResult {
    const structured = parseStructured(path, content);
    const parseContext: ParseContext = { path, ...context };
    const artifacts: ParsedArtifact[] = [];
    const diagnostics = [...structured.diagnostics];
    for (const parser of this.parsers) {
      try {
        artifacts.push(...parser.parse(structured.documents, parseContext));
      } catch (error) {
        diagnostics.push({
          path,
          parser: parser.id,
          severity: "error",
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return { artifacts, diagnostics };
  }
}
