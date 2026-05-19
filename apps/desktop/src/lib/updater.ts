import { getVersion } from "@tauri-apps/api/app";
import { check } from "@tauri-apps/plugin-updater";

export interface ManualUpdateInfo {
  currentVersion: string;
  version: string;
  date: string | null;
  body: string | null;
  install: () => Promise<void>;
}

export interface ManualUpdateCheckResult {
  currentVersion: string;
  update: ManualUpdateInfo | null;
}

export async function checkForManualUpdate(): Promise<ManualUpdateCheckResult> {
  const [currentVersion, update] = await Promise.all([getVersion(), check()]);
  if (!update) {
    return { currentVersion, update: null };
  }

  return {
    currentVersion,
    update: {
      currentVersion: update.currentVersion ?? currentVersion,
      version: update.version,
      date: update.date ?? null,
      body: update.body ?? null,
      install: () => update.downloadAndInstall(),
    },
  };
}
