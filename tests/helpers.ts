import type { ProjectConfig } from "../src/model/types";

export function project(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    id: "payments",
    name: "Payments",
    rootFolder: "architecture",
    documentationFolder: "architecture/generated",
    includedFolders: [],
    excludedFolders: ["generated"],
    environments: [
      { name: "DEV", folderPrefixes: ["dev"] },
      { name: "PRODUCTION", folderPrefixes: ["prod"] }
    ],
    kafkaClusterAliases: { primary: "broker-a:9092", secondary: "broker-b:9092" },
    filePatterns: ["**/*.{json,yaml,yml,properties,md}"],
    validation: {},
    automaticRefresh: true,
    refreshDebounceMs: 10,
    ...overrides
  };
}
