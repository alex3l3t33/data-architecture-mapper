function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function expandBraces(pattern: string): string[] {
  const match = pattern.match(/\{([^{}]+)\}/);
  if (!match || match.index === undefined) return [pattern];
  return match[1]!.split(",").flatMap((choice) =>
    expandBraces(`${pattern.slice(0, match.index)}${choice}${pattern.slice(match.index! + match[0].length)}`)
  );
}

function globRegex(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      if (pattern[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += escapeRegex(char);
  }
  return new RegExp(`^${source}$`, "i");
}

export function matchesAnyGlob(path: string, patterns: string[]): boolean {
  const normalized = path.replace(/^\/+|\\/g, "/");
  return patterns.some((pattern) => expandBraces(pattern).some((expanded) => globRegex(expanded).test(normalized)));
}

export function isInside(path: string, folder: string): boolean {
  const normalizedPath = path.replace(/^\/+|\/+$/g, "");
  const normalizedFolder = folder.replace(/^\/+|\/+$/g, "");
  return !normalizedFolder || normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}/`);
}
