import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import { ModalShell } from "./ModalShell";
import { deleteVoiceProfileRequest, fetchVoiceProfilesRequest } from "../../lib/api";
import type { VoiceProfileSummary } from "../../lib/api";

interface VoiceProfileManagerModalProps {
  onClose: () => void;
  // Fires after any profile is actually deleted - lets a caller with its own cached copy of the
  // registered-name set (e.g. AudioAnalysisModal's SpeakerPicker green/white coloring) refresh it.
  // This modal has no idea such a cache exists, so it just reports "something changed".
  onProfilesChanged?: () => void;
  // Settings opens this as the only modal on screen (default z-index is fine). AudioAnalysisModal
  // opens it nested inside its own already-open "회의 음성 분석" modal, so it needs to stack above
  // that one - same overlayZIndex value that modal's own 수정 사전 등록 popup uses.
  overlayZIndex?: number;
}

// Shared between Settings("음성 프로필 관리" 수정 버튼) and AudioAnalysisModal("화자 편집" 버튼) -
// same card-grid view/delete UI either way (see server/voiceProfiles.mjs's deleteVoiceProfile:
// registerVoiceProfile only ever appends a sample, so this is the only way to walk back a
// wrongly-tagged one).
export function VoiceProfileManagerModal({ onClose, onProfilesChanged, overlayZIndex }: VoiceProfileManagerModalProps) {
  const [profiles, setProfiles] = useState<VoiceProfileSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [deletingName, setDeletingName] = useState("");

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
        ) : profiles.length === 0 ? (
          <p className="settings-section-desc">등록된 음성 프로필이 없습니다.</p>
        ) : (
          <div className="card-grid voice-profile-card-grid">
            {profiles.map((profile) => (
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
              </div>
            ))}
          </div>
        )}
        {error && <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{error}</span>}
      </div>
    </ModalShell>
  );
}
