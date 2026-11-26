import { parseAllDocuments } from "yaml";
import type { ParseDiagnostic } from "../model/types";
import { parseProperties } from "./properties";

export interface StructuredInput {
  documents: unknown[];
  diagnostics: ParseDiagnostic[];
}

export function parseStructured(path: string, content: string): StructuredInput {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  try {
    if (extension === "properties" || extension === "conf" || extension === "cfg") {
      return { documents: [parseProperties(content)], diagnostics: [] };
    }
    if (extension === "md" || extension === "markdown") {
      const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/);
      if (!frontmatter) return { documents: [], diagnostics: [] };
      return parseYaml(path, frontmatter[1] ?? "");
    }
    if (extension === "json") {
      const parsed = JSON.parse(content) as unknown;
      return { documents: Array.isArray(parsed) ? parsed : [parsed], diagnostics: [] };
    }
    return parseYaml(path, content);
  } catch (error) {
    return {
      documents: [],
      diagnostics: [{ path, parser: "structured", severity: "error", message: errorMessage(error) }]
    };
  }
}

function parseYaml(path: string, content: string): StructuredInput {
  const documents = parseAllDocuments(content, { strict: false });
  const diagnostics: ParseDiagnostic[] = [];
  const values: unknown[] = [];
  for (const document of documents) {
    for (const error of document.errors) {
      diagnostics.push({ path, parser: "yaml", severity: "error", message: error.message });
    }
    if (document.errors.length === 0 && document.contents !== null) values.push(document.toJS() as unknown);
  }
  return { documents: values, diagnostics };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
