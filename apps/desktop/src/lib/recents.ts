const STORAGE_KEY = "helm.recentProjects";
const MAX_RECENTS = 12;

export interface RecentProject {
  id: string;
  name: string;
  rootPath: string;
  lastOpenedAt: number;
}

export function loadRecents(): RecentProject[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is RecentProject =>
          item != null &&
          typeof item === "object" &&
          typeof item.id === "string" &&
          typeof item.name === "string" &&
          typeof item.rootPath === "string" &&
          typeof item.lastOpenedAt === "number",
      )
      .slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

export function saveRecents(recents: RecentProject[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recents.slice(0, MAX_RECENTS)));
  } catch {
    // localStorage may be unavailable (private mode, quota); not critical
  }
}

export function upsertRecent(
  recents: RecentProject[],
  project: { id: string; name: string; rootPath: string },
  options: { preserveExistingPosition?: boolean } = {},
): RecentProject[] {
  const nextRecent = {
    id: project.id,
    name: project.name,
    rootPath: project.rootPath,
    lastOpenedAt: Date.now(),
  };
  if (options.preserveExistingPosition && recents.some((r) => r.id === project.id)) {
    return recents.map((r) => (r.id === project.id ? nextRecent : r)).slice(0, MAX_RECENTS);
  }
  const filtered = recents.filter((r) => r.id !== project.id);
  return [nextRecent, ...filtered].slice(0, MAX_RECENTS);
}

export function shortenPath(rootPath: string): string {
  const parts = rootPath.split("/").filter(Boolean);
  if (parts.length <= 2) return rootPath;
  return `…/${parts.slice(-2).join("/")}`;
}
