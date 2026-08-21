import { useEffect, useState } from "react";
import { Plus, ShieldCheck, ShieldOff } from "lucide-react";
import { ModalShell } from "./ModalShell";
import type { MemberRole, PublicMember } from "../../types/domain";
import { createMemberRequest, disableMemberRequest, fetchMembers, updateMemberRequest } from "../../lib/auth";

interface MemberManagementModalProps {
  onClose: () => void;
}

export function MemberManagementModal({ onClose }: MemberManagementModalProps) {
  const [members, setMembers] = useState<PublicMember[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [newName, setNewName] = useState("");
  const [newLoginId, setNewLoginId] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<MemberRole>("일반");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        const list = await fetchMembers();
        if (mounted) {
          setMembers(list);
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : "계정 목록을 불러오지 못했습니다.");
        }
      } finally {
        if (mounted) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  const handleAdd = async () => {
    if (!newLoginId.trim() || !newPassword.trim()) {
      setError("아이디와 초기 비밀번호를 입력해 주세요.");
      return;
    }

    setIsSubmitting(true);
    setError("");

    try {
      const next = await createMemberRequest({ name: newName.trim(), loginId: newLoginId.trim(), password: newPassword, role: newRole });
      setMembers(next);
      setNewName("");
      setNewLoginId("");
      setNewPassword("");
      setNewRole("일반");
    } catch (err) {
      setError(err instanceof Error ? err.message : "계정 추가에 실패했습니다.");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRoleChange = async (id: string, role: MemberRole) => {
    setError("");

    try {
      const next = await updateMemberRequest(id, { role });
      setMembers(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "역할 변경에 실패했습니다.");
    }
  };

  const handleToggleDisabled = async (member: PublicMember) => {
    setError("");

    try {
      const next = member.disabled ? await updateMemberRequest(member.id, { disabled: false }) : await disableMemberRequest(member.id);
      setMembers(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "계정 상태 변경에 실패했습니다.");
    }
  };

  return (
    <ModalShell
      title="계정 관리"
      onClose={onClose}
      width="wide"
      footer={
        <div className="modal-footer-actions" style={{ marginLeft: "auto" }}>
          <button className="ghost-action" onClick={onClose} type="button">
            닫기
          </button>
        </div>
      }
    >
      <div className="field full">
        <label>계정 목록</label>
        {isLoading ? (
          <span className="field-hint">불러오는 중...</span>
        ) : (
          <div className="editable-table-wrap">
            <table className="editable-table">
              <thead>
                <tr>
                  <th>이름</th>
                  <th>아이디</th>
                  <th>역할</th>
                  <th>상태</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <tr key={member.id}>
                    <td>{member.name}</td>
                    <td>{member.loginId}</td>
                    <td>
                      <select
                        disabled={member.disabled}
                        onChange={(event) => handleRoleChange(member.id, event.target.value as MemberRole)}
                        value={member.role}
                      >
                        <option value="일반">일반</option>
                        <option value="admin">admin</option>
                      </select>
                    </td>
                    <td>{member.disabled ? "비활성" : "활성"}</td>
                    <td>
                      <button
                        className="row-icon-button"
                        onClick={() => handleToggleDisabled(member)}
                        title={member.disabled ? "활성화" : "비활성화"}
                        type="button"
                      >
                        {member.disabled ? <ShieldCheck size={15} /> : <ShieldOff size={15} />}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="field full">
        <label>새 계정 추가</label>
        <div className="format-choice-row" style={{ flexWrap: "wrap" }}>
          <input onChange={(event) => setNewName(event.target.value)} placeholder="이름" style={{ maxWidth: 140 }} value={newName} />
          <input onChange={(event) => setNewLoginId(event.target.value)} placeholder="아이디" style={{ maxWidth: 140 }} value={newLoginId} />
          <input
            onChange={(event) => setNewPassword(event.target.value)}
            placeholder="초기 비밀번호"
            style={{ maxWidth: 140 }}
            type="password"
            value={newPassword}
          />
          <select onChange={(event) => setNewRole(event.target.value as MemberRole)} value={newRole}>
            <option value="일반">일반</option>
            <option value="admin">admin</option>
          </select>
          <button className="primary-action" disabled={isSubmitting} onClick={handleAdd} type="button">
            <Plus size={15} />
            추가
          </button>
        </div>
        <span className="field-hint">추가된 계정은 이 아이디/초기 비밀번호로 로그인할 수 있습니다.</span>
      </div>

      {error && <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{error}</span>}
    </ModalShell>
  );
}
