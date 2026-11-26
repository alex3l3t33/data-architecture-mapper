/** Only explicitly configured vault-relative shell scripts can be launched. */
export function connectScriptPath(value: string): string {
  const path = value.trim();
  if (!path.endsWith(".sh") || path.includes("\\") || [...path].some((character) => character.charCodeAt(0) < 32)
    || path.split("/").some((segment) => segment === "." || segment === ".." || !segment)) {
    throw new Error("Enter a vault-relative .sh path, such as Scripts/export-dev.sh.");
  }
  return path;
}
