import { useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { ModalShell } from "./ModalShell";
import { deleteVoiceProfileRequest, fetchVoiceProfilesRequest } from "../../lib/api";
import type { VoiceProfileSummary } from "../../lib/api";

// Below this, a profile is flagged as needing re-registration - matches server/voiceProfiles.mjs's
// RELAXED_SIMILARITY_THRESHOLD baseline (0.75 -> 75) so the same number means the same thing on
// both sides: a profile this inconsistent is already getting the stricter end of the per-profile
// threshold range (see effectiveThresholds), not just cosmetically flagged here.
const LOW_RELIABILITY_SCORE = 75;
// 85 matches SIMILARITY_THRESHOLD's baseline (see reliabilityScore/RELIABILITY_ANCHOR in
// server/voiceProfiles.mjs) - a profile at or above this is at least as consistent as the default
// bar every profile used to share.
const GOOD_RELIABILITY_SCORE = 85;

function reliabilityScoreClass(score: number | null): string {
  if (score === null) {
    return "unverified";
  }
  if (score < LOW_RELIABILITY_SCORE) {
    return "bad";
  }
  if (score < GOOD_RELIABILITY_SCORE) {
    return "warn";
  }
  return "good";
}

interface VoiceProfileManagerModalProps {
  onClose: () => void;
  // Fires after any profile is actually deleted - lets a caller with its own cached copy of the
  // registered-name set (e.g. AudioAnalysisModal's SpeakerPicker green/white coloring) refresh it.
  // This modal has no idea such a cache exists, so it just reports "something changed".
  onProfilesChanged?: () => void;
  // Settings opens this as the only modal on screen (default z-index is fine). AudioAnalysisModal
  overlayZIndex?: number;
}

// same card-grid view/delete UI either way (see server/voiceProfiles.mjs's deleteVoiceProfile:
// registerVoiceProfile only ever appends a sample, so this is the only way to walk back a
// wrongly-tagged one).
export function VoiceProfileManagerModal({ onClose, onProfilesChanged, overlayZIndex }: VoiceProfileManagerModalProps) {
  const [profiles, setProfiles] = useState<VoiceProfileSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [deletingName, setDeletingName] = useState("");

  // fetchVoiceProfilesRequest returns whatever order the JSON file happens to store them in
  // (registration order, not alphabetical) - sorted here the same way SpeakerPicker's dropdown
  // already sorts its own name list, so the two stay consistent.
  const sortedProfiles = useMemo(() => [...profiles].sort((a, b) => a.name.localeCompare(b.name, "ko")), [profiles]);

  const refresh = async () => {
    try {
      setProfiles(await fetchVoiceProfilesRequest());
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "음성 프로필 목록을 불러오지 못했습니다.");
    }
  };

  useEffect(() => {
    let mounted = true;
    (async () => {
      await refresh();
      if (mounted) {
        setIsLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const handleDelete = async (name: string) => {
    if (!window.confirm(`"${name}" 음성 프로필을 삭제할까요? 지금까지 등록된 샘플이 모두 사라지며, 되돌릴 수 없습니다.`)) {
      return;
    }
    setDeletingName(name);
    try {
      await deleteVoiceProfileRequest(name);
      await refresh();
      onProfilesChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "음성 프로필을 삭제하지 못했습니다.");
    } finally {
      setDeletingName("");
    }
  };

  return (
    <ModalShell
      footer={
        <div className="modal-footer-actions" style={{ marginLeft: "auto" }}>
          <button className="ghost-action" onClick={onClose} type="button">
            닫기
          </button>
        </div>
      }
      onClose={onClose}
      overlayZIndex={overlayZIndex}
      title="음성 프로필 관리"
      width="wide"
    >
      <div className="field full">
        <span className="field-hint">
          회의 음성 분석에서 화자에게 이름을 등록하면 여기 쌓입니다. 잘못된 구간이 엉뚱한 이름으로 등록됐다면 삭제 후 다시 등록하세요.
        </span>
        {isLoading ? (
          <span className="field-hint">불러오는 중...</span>
        ) : sortedProfiles.length === 0 ? (
          <p className="settings-section-desc">등록된 음성 프로필이 없습니다.</p>
        ) : (
          <div className="card-grid voice-profile-card-grid">
            {sortedProfiles.map((profile) => (
              <div className="voice-profile-card" key={profile.name}>
                <button
                  className="voice-profile-card-delete"
                  disabled={deletingName === profile.name}
                  onClick={() => void handleDelete(profile.name)}
                  title="삭제"
                  type="button"
                >
                  <Trash2 size={14} />
                </button>
                <strong className="voice-profile-card-name">{profile.name}</strong>
                <span className="voice-profile-card-count">샘플 {profile.sampleCount}개</span>
                <span className={`voice-profile-card-score ${reliabilityScoreClass(profile.reliabilityScore)}`}>
                  {profile.reliabilityScore === null
                    ? "샘플 부족 - 최소 2개 필요"
                    : profile.reliabilityScore < LOW_RELIABILITY_SCORE
                      ? `신뢰도 ${profile.reliabilityScore}점 - 재등록 권장`
                      : `신뢰도 ${profile.reliabilityScore}점`}
                </span>
              </div>
            ))}
          </div>
        )}
        {error && <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{error}</span>}
      </div>
    </ModalShell>
  );
}
