import fs from "node:fs";

const topicCount = Number(process.argv[2] ?? 1000);
const components = [];
const relationships = [];
for (let index = 0; index < topicCount; index += 1) {
  const topic = `topic-${String(index).padStart(4, "0")}`;
  const processor = `processor-${String(index).padStart(4, "0")}`;
  components.push({ id: topic, type: "kafka-topic", name: topic, properties: { partitions: 12, replicas: 3 } });
  components.push({ id: processor, type: "application", name: processor, technology: "synthetic" });
  for (const offset of [0, 1]) relationships.push({ from: `topic-${String((index + offset) % topicCount).padStart(4, "0")}`, to: processor, type: "CONSUMES" });
  for (const offset of [2, 3]) relationships.push({ from: processor, to: `topic-${String((index + offset) % topicCount).padStart(4, "0")}`, type: "PRODUCES" });
}
const fixture = { architecture: { name: "stress-1000-topics", environment: "PERF", cluster: "primary", components, relationships } };
fs.writeFileSync(new URL("./stress-1000-topics.json", import.meta.url), `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`Wrote ${topicCount} topics, ${topicCount} applications, and ${relationships.length} relationships.`);
