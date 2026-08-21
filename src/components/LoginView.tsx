import { useState, type FormEvent } from "react";
import { createMemberRequest, login, saveSession } from "../lib/auth";
import type { PublicMember } from "../types/domain";

interface LoginViewProps {
  theme: "light" | "dark";
  logoVersion: number;
  onLoginSuccess: (member: PublicMember) => void;
}

export function LoginView({ theme, logoVersion, onLoginSuccess }: LoginViewProps) {
  const [mode, setMode] = useState<"login" | "request">("login");

  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [requestName, setRequestName] = useState("");
  const [requestLoginId, setRequestLoginId] = useState("");
  const [requestPassword, setRequestPassword] = useState("");
  const [requestPasswordConfirm, setRequestPasswordConfirm] = useState("");
  const [requestError, setRequestError] = useState("");
  const [requestSuccess, setRequestSuccess] = useState("");
  const [isRequesting, setIsRequesting] = useState(false);

  const switchMode = (nextMode: "login" | "request") => {
    setMode(nextMode);
    setError("");
    setRequestError("");
    setRequestSuccess("");
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();

    if (isSubmitting) {
      return;
    }

    setIsSubmitting(true);
    setError("");

    try {
      const result = await login(loginId.trim(), password);

      if (!result.ok || !result.member) {
        setError(result.error || "로그인에 실패했습니다.");
        return;
      }

      saveSession(result.member);
      onLoginSuccess(result.member);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRequestAccount = async (event: FormEvent) => {
    event.preventDefault();

    if (isRequesting) {
      return;
    }

    if (!requestLoginId.trim() || !requestPassword) {
      setRequestError("아이디와 비밀번호를 입력해 주세요.");
      return;
    }

    if (requestPassword !== requestPasswordConfirm) {
      setRequestError("비밀번호가 일치하지 않습니다.");
      return;
    }

    setIsRequesting(true);
    setRequestError("");

    try {
      // role is always "일반" and disabled: true regardless of anything the form could send - a
      // self-service request can never grant itself admin or immediate access. An admin has to
      // activate the account from 계정 관리 (see MemberManagementModal's 활성화/비활성화 toggle).
      await createMemberRequest({
        name: requestName.trim(),
        loginId: requestLoginId.trim(),
        password: requestPassword,
        role: "일반",
        disabled: true
      });

      setRequestSuccess("계정 신청이 완료되었습니다. 관리자 승인 후 로그인할 수 있습니다.");
      setRequestName("");
      setRequestLoginId("");
      setRequestPassword("");
      setRequestPasswordConfirm("");
    } catch (requestSubmitError) {
      setRequestError(requestSubmitError instanceof Error ? requestSubmitError.message : "계정 신청에 실패했습니다.");
    } finally {
      setIsRequesting(false);
    }
  };

  if (mode === "request") {
    return (
      <div className={`login-screen ${theme}`}>
        <form className="login-card" onSubmit={handleRequestAccount}>
          <img alt="MeetingNote" className="login-logo" src={`/logo.png?v=${logoVersion}`} />
          <strong className="login-title">계정 신청</strong>

          {requestSuccess ? (
            <>
              <span className="field-hint">{requestSuccess}</span>
              <button className="primary-action" onClick={() => switchMode("login")} type="button">
                로그인 화면으로
              </button>
            </>
          ) : (
            <>
              <div className="field full">
                <label htmlFor="request-name">이름</label>
                <input
                  autoFocus
                  id="request-name"
                  onChange={(event) => setRequestName(event.target.value)}
                  placeholder="이름"
                  value={requestName}
                />
              </div>

              <div className="field full">
                <label htmlFor="request-login-id">아이디</label>
                <input
                  id="request-login-id"
                  onChange={(event) => setRequestLoginId(event.target.value)}
                  placeholder="아이디"
                  value={requestLoginId}
                />
              </div>

              <div className="field full">
                <label htmlFor="request-password">비밀번호</label>
                <input
                  id="request-password"
                  onChange={(event) => setRequestPassword(event.target.value)}
                  placeholder="비밀번호"
                  type="password"
                  value={requestPassword}
                />
              </div>

              <div className="field full">
                <label htmlFor="request-password-confirm">비밀번호 확인</label>
                <input
                  id="request-password-confirm"
                  onChange={(event) => setRequestPasswordConfirm(event.target.value)}
                  placeholder="비밀번호 확인"
                  type="password"
                  value={requestPasswordConfirm}
                />
              </div>

              {requestError && <span className="login-error">{requestError}</span>}

              <button
                className="primary-action"
                disabled={isRequesting || !requestLoginId.trim() || !requestPassword || !requestPasswordConfirm}
                type="submit"
              >
                {isRequesting ? "신청 중..." : "신청하기"}
              </button>
              <button className="ghost-action" onClick={() => switchMode("login")} type="button">
                로그인 화면으로
              </button>
            </>
          )}
        </form>
      </div>
    );
  }

  return (
    <div className={`login-screen ${theme}`}>
      <form className="login-card" onSubmit={handleSubmit}>
        <img alt="MeetingNote" className="login-logo" src={`/logo.png?v=${logoVersion}`} />
        <strong className="login-title">MeetingNote</strong>

        <div className="field full">
          <label htmlFor="login-id">아이디</label>
          <input
            autoFocus
            id="login-id"
            onChange={(event) => setLoginId(event.target.value)}
            placeholder="아이디"
            value={loginId}
          />
        </div>

        <div className="field full">
          <label htmlFor="login-password">비밀번호</label>
          <input
            id="login-password"
            onChange={(event) => setPassword(event.target.value)}
            placeholder="비밀번호"
            type="password"
            value={password}
          />
        </div>

        {error && <span className="login-error">{error}</span>}

        <button className="primary-action" disabled={isSubmitting || !loginId.trim() || !password} type="submit">
          {isSubmitting ? "로그인 중..." : "로그인"}
        </button>
        <button className="ghost-action" onClick={() => switchMode("request")} type="button">
          계정 신청
        </button>
      </form>
    </div>
  );
}
