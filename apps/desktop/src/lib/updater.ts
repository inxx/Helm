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
  unavailableReason: string | null;
}

export async function checkForManualUpdate(): Promise<ManualUpdateCheckResult> {
  const currentVersion = await getVersion();
  let update: Awaited<ReturnType<typeof check>>;
  try {
    update = await check();
  } catch (error) {
    if (isEmptyUpdaterEndpointsError(error)) {
      return {
        currentVersion,
        update: null,
        unavailableReason: "업데이트 배포 채널이 아직 설정되지 않았습니다.",
      };
    }
    throw error;
  }

  if (!update) {
    return { currentVersion, update: null, unavailableReason: null };
  }

  return {
    currentVersion,
    unavailableReason: null,
    update: {
      currentVersion: update.currentVersion ?? currentVersion,
      version: update.version,
      date: update.date ?? null,
      body: update.body ?? null,
      install: () => update.downloadAndInstall(),
    },
  };
}

function isEmptyUpdaterEndpointsError(error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  return message.includes("Updater does not have any endpoints set.");
}
