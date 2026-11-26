import type { ProjectConfig, SubprojectConfig } from "../model/types";
import { isInside } from "./glob";

/** Files belong to the most specific configured subproject folder. */
export function subprojectForPath(project: ProjectConfig, path: string): SubprojectConfig | undefined {
  const root = project.rootFolder.replace(/^\/+|\/+$/g, "");
  const source = path.replace(/^\/+|\/+$/g, "");
  if (!isInside(source, root)) return undefined;
  const relative = root ? source.slice(root.length + 1) : source;

  let best: SubprojectConfig | undefined;
  let bestLength = 0;
  for (const subproject of project.subprojects ?? []) {
    const folder = subproject.folder.trim().replace(/^\/+|\/+$/g, "");
    if (!folder || folder.split("/").some((segment) => !segment || segment === "." || segment === "..")) continue;
    if (!isInside(relative, folder)) continue;
    if (!best || folder.length > bestLength || folder.length === bestLength && subproject.id < best.id) {
      best = subproject;
      bestLength = folder.length;
    }
  }
  return best;
}
