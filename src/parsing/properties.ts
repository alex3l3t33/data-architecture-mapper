export function parseProperties(content: string): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const logicalLines: string[] = [];
  let current = "";
  for (const physicalLine of content.replace(/\r\n?/g, "\n").split("\n")) {
    current += physicalLine;
    const trailing = current.match(/(\\+)$/)?.[1]?.length ?? 0;
    if (trailing % 2 === 1) current = current.slice(0, -1);
    else {
      logicalLines.push(current);
      current = "";
    }
  }
  if (current) logicalLines.push(current);

  for (const rawLine of logicalLines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    let separator = -1;
    let escaped = false;
    for (let index = 0; index < line.length; index += 1) {
      const character = line[index]!;
      if (!escaped && (character === "=" || character === ":" || /\s/.test(character))) {
        separator = index;
        break;
      }
      escaped = !escaped && character === "\\";
      if (character !== "\\") escaped = false;
    }
    const key = unescapeProperty(separator < 0 ? line : line.slice(0, separator).trim());
    const rawValue = separator < 0 ? "" : line.slice(separator + 1).trim().replace(/^[=:]\s*/, "");
    output[key] = coerceScalar(unescapeProperty(rawValue));
  }
  return output;
}

function unescapeProperty(value: string): string {
  return value
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/\\([:= #!\\])/g, "$1")
    .replace(/\\t/g, "\t")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r");
}

function coerceScalar(value: string): string | number | boolean {
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^-?\d+(?:\.\d+)?$/.test(value) && !/^0\d+/.test(value)) return Number(value);
  return value;
}
