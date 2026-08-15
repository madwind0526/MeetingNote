export const APP_VERSION = __MEETINGNOTE_VERSION__;
export const BUILD_VERSION = __MEETINGNOTE_BUILD_VERSION__;
export const BUILD_LABEL = __MEETINGNOTE_BUILD_LABEL__;
export const BUILD_COMMIT_SHA = __MEETINGNOTE_COMMIT_SHA__;
export const BUILD_COMMIT_COUNT = __MEETINGNOTE_COMMIT_COUNT__;
export const BUILD_IS_DIRTY = __MEETINGNOTE_GIT_DIRTY__;

export interface BuildInfo {
  version: string;
  buildVersion: string;
  buildLabel: string;
  commitSha: string;
  commitCount: string;
  dirty: boolean;
}

export const FALLBACK_BUILD_INFO: BuildInfo = {
  version: APP_VERSION,
  buildVersion: BUILD_VERSION,
  buildLabel: BUILD_LABEL,
  commitSha: BUILD_COMMIT_SHA,
  commitCount: BUILD_COMMIT_COUNT,
  dirty: BUILD_IS_DIRTY
};

function normalizeBuildInfo(value: unknown): BuildInfo | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Partial<BuildInfo>;
  if (
    typeof candidate.version !== "string" ||
    typeof candidate.buildVersion !== "string" ||
    typeof candidate.buildLabel !== "string" ||
    typeof candidate.commitSha !== "string" ||
    typeof candidate.commitCount !== "string" ||
    typeof candidate.dirty !== "boolean"
  ) {
    return null;
  }

  return {
    version: candidate.version,
    buildVersion: candidate.buildVersion,
    buildLabel: candidate.buildLabel,
    commitSha: candidate.commitSha,
    commitCount: candidate.commitCount,
    dirty: candidate.dirty
  };
}

export async function loadRuntimeBuildInfo(): Promise<BuildInfo> {
  try {
    if (window.meetingNote?.getBuildInfo) {
      const electronInfo = normalizeBuildInfo(await window.meetingNote.getBuildInfo());
      if (electronInfo) {
        return electronInfo;
      }
    }
  } catch {
    // Fall through to the dev server or compile-time fallback.
  }

  try {
    const response = await fetch("/api/build-info", { cache: "no-store" });
    if (response.ok) {
      const serverInfo = normalizeBuildInfo(await response.json());
      if (serverInfo) {
        return serverInfo;
      }
    }
  } catch {
    // Keep the compile-time fallback when no runtime metadata source is available.
  }

  return FALLBACK_BUILD_INFO;
}
