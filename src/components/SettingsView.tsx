import { useState } from "react";
import {
  Bot,
  CheckCircle2,
  Database,
  FolderOpen,
  Image,
  KeyRound,
  Mic,
  Monitor,
  Palette,
  Settings2,
  Upload,
  XCircle
} from "lucide-react";
import type { AppSettings, ExportFormat, ImportDuplicateMode, LlmProviderId, SttProviderId, ViewMode } from "../types/domain";
import { llmProviders, sttProviders } from "../types/domain";
import type { LlmStatus, SttStatus } from "../lib/llm";
import { pickAttachmentsFolder, readFileAsDataUrl } from "../lib/api";

interface SettingsViewProps {
  settings: AppSettings;
  totalMeetings: number;
  llmStatus: LlmStatus | null;
  sttStatus: SttStatus | null;
  logoVersion: number;
  onConfigureApiKey: () => void;
  onConfigureSttApiKey: () => void;
  onConfigureNaverClova: () => void;
  onConfigureHuggingFace: () => void;
  onConfigureOllama: () => void;
  onResetToSample: () => void;
  onSelectLlmProvider: (provider: LlmProviderId) => void;
  onSelectSttProvider: (provider: SttProviderId) => void;
  onUpdate: <Key extends keyof AppSettings>(key: Key, value: AppSettings[Key]) => void;
  onUploadLogo: (dataUrl: string) => void;
}

function providerAvailability(
  provider: LlmProviderId,
  llmStatus: LlmStatus | null,
  settings: AppSettings
): { ready: boolean; note: string } {
  if (provider === "local-preview") {
    return { ready: true, note: "항상 사용 가능" };
  }

  if (provider === "claude-cli") {
    if (!llmStatus) {
      return { ready: false, note: "확인 중..." };
    }
    return llmStatus.claudeCli.available
      ? { ready: true, note: `사용 가능 (${llmStatus.claudeCli.version ?? "claude"})` }
      : { ready: false, note: "claude 명령을 찾을 수 없습니다" };
  }

  if (provider === "ollama") {
    if (!settings.ollamaModel.trim()) {
      return { ready: false, note: "서버/모델 설정 필요" };
    }
    if (!llmStatus) {
      return { ready: false, note: "확인 중..." };
    }
    return llmStatus.ollama.available
      ? { ready: true, note: `연결됨 (${settings.ollamaModel})` }
      : { ready: false, note: "Ollama 서버에 연결할 수 없습니다" };
  }

  if (!llmStatus) {
    return { ready: false, note: "확인 중..." };
  }

  return llmStatus.anthropicApiKeySet ? { ready: true, note: "API 키 등록됨" } : { ready: false, note: "API 키 필요" };
}

function sttAvailability(provider: SttProviderId, sttStatus: SttStatus | null): { ready: boolean; note: string } {
  if (provider === "mock") {
    return { ready: true, note: "항상 사용 가능" };
  }

  if (provider === "local-whisper-cli") {
    if (!sttStatus) {
      return { ready: false, note: "확인 중..." };
    }
    return sttStatus.localWhisperCli.available
      ? { ready: true, note: `설치됨 (${sttStatus.localWhisperCli.version ?? "whisper"})` }
      : { ready: false, note: "whisper 명령을 찾을 수 없습니다" };
  }

  if (provider === "local-whisperx") {
    if (!sttStatus) {
      return { ready: false, note: "확인 중..." };
    }
    return sttStatus.localWhisperX.available
      ? { ready: true, note: `설치됨 (${sttStatus.localWhisperX.version ?? "whisperx"})` }
      : { ready: false, note: "WhisperX 환경을 찾을 수 없습니다" };
  }

  if (provider === "naver-clova") {
    if (!sttStatus) {
      return { ready: false, note: "확인 중..." };
    }
    return sttStatus.naverClovaConfigured
      ? { ready: true, note: "Invoke URL/Secret Key 등록됨" }
      : { ready: false, note: "Invoke URL/Secret Key 필요" };
  }

  if (!sttStatus) {
    return { ready: false, note: "확인 중..." };
  }

  return sttStatus.openaiApiKeySet ? { ready: true, note: "API 키 등록됨" } : { ready: false, note: "API 키 필요" };
}

export function SettingsView({
  settings,
  totalMeetings,
  llmStatus,
  sttStatus,
  logoVersion,
  onConfigureApiKey,
  onConfigureSttApiKey,
  onConfigureNaverClova,
  onConfigureHuggingFace,
  onConfigureOllama,
  onResetToSample,
  onSelectLlmProvider,
  onSelectSttProvider,
  onUpdate,
  onUploadLogo
}: SettingsViewProps) {
  const [previewDataUrl, setPreviewDataUrl] = useState("");
  const [folderError, setFolderError] = useState("");

  const handleLogoFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const dataUrl = await readFileAsDataUrl(file);
    setPreviewDataUrl(dataUrl);
    onUploadLogo(dataUrl);
    event.target.value = "";
  };

  return (
    <div className="settings-panel">
      <section className="settings-section">
        <div className="settings-section-title">
          <Image size={16} />
          로고 화면
        </div>
        <p className="settings-section-desc">
          왼쪽 위 "MeetingNote"를 누르면 뜨는 로고 화면에 표시할 이미지를 등록합니다 (<code>assets/logo.png</code>).
        </p>
        <label className="ghost-action" style={{ cursor: "pointer", width: "fit-content" }}>
          <Upload size={16} />
          이미지 업로드
          <input accept="image/*" onChange={handleLogoFileChange} style={{ display: "none" }} type="file" />
        </label>
        <div className="logo-preview-frame">
          <img
            alt="로고 미리보기"
            key={previewDataUrl || logoVersion}
            onError={(event) => {
              event.currentTarget.style.visibility = "hidden";
            }}
            onLoad={(event) => {
              event.currentTarget.style.visibility = "visible";
            }}
            src={previewDataUrl || `/logo.png?v=${logoVersion}`}
          />
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-title">
          <Palette size={16} />
          테마
        </div>
        <p className="settings-section-desc">앱 전체의 밝기 모드를 선택합니다.</p>
        <div className="format-choice-row">
          <button
            className={settings.theme === "light" ? "format-choice-button active" : "format-choice-button"}
            onClick={() => onUpdate("theme", "light")}
            type="button"
          >
            라이트
          </button>
          <button
            className={settings.theme === "dark" ? "format-choice-button active" : "format-choice-button"}
            onClick={() => onUpdate("theme", "dark")}
            type="button"
          >
            다크
          </button>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-title">
          <Monitor size={16} />
          기본 화면
        </div>
        <p className="settings-section-desc">앱을 시작했을 때 처음 표시할 보기를 선택합니다.</p>
        <div className="field">
          <select
            id="settings-default-view"
            onChange={(event) => onUpdate("defaultView", event.target.value as ViewMode)}
            value={settings.defaultView}
          >
            <option value="card">카드 보기</option>
            <option value="list">표 보기</option>
          </select>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-title">
          <Bot size={16} />
          AI 질문 및 회의록 작성 (LLM)
        </div>
        <p className="settings-section-desc">
          사이드바의 "질문" 기능과 회의 상세의 "회의록 작성" 버튼에서 공통으로 사용할 답변/생성 방식을 선택합니다.
        </p>
        <div className="llm-provider-list">
          {llmProviders.map((provider) => {
            const availability = providerAvailability(provider.id, llmStatus, settings);
            const isSelected = settings.llmProvider === provider.id;

            return (
              <button
                className={isSelected ? "llm-provider-item active" : "llm-provider-item"}
                key={provider.id}
                onClick={() => onSelectLlmProvider(provider.id)}
                type="button"
              >
                <div className="llm-provider-item-header">
                  <strong>{provider.label}</strong>
                  <span className={availability.ready ? "llm-provider-status ready" : "llm-provider-status"}>
                    {availability.ready ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                    {availability.note}
                  </span>
                </div>
                <p>{provider.description}</p>
                {provider.requiresApiKey && (
                  <span
                    className="ghost-action"
                    onClick={(event) => {
                      event.stopPropagation();
                      onConfigureApiKey();
                    }}
                    role="button"
                    style={{ width: "fit-content", cursor: "pointer" }}
                    tabIndex={0}
                  >
                    <KeyRound size={14} />
                    API 키 설정
                  </span>
                )}
                {provider.requiresOllamaConfig && (
                  <span
                    className="ghost-action"
                    onClick={(event) => {
                      event.stopPropagation();
                      onConfigureOllama();
                    }}
                    role="button"
                    style={{ width: "fit-content", cursor: "pointer" }}
                    tabIndex={0}
                  >
                    <Settings2 size={14} />
                    서버/모델 설정
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-title">
          <Mic size={16} />
          음성 인식 (STT)
        </div>
        <p className="settings-section-desc">회의 녹음 파일을 대본으로 변환할 때 사용할 음성 인식 방식을 선택합니다.</p>
        <div className="llm-provider-list">
          {sttProviders.map((provider) => {
            const availability = sttAvailability(provider.id, sttStatus);
            const isSelected = settings.sttProvider === provider.id;

            return (
              <button
                className={isSelected ? "llm-provider-item active" : "llm-provider-item"}
                key={provider.id}
                onClick={() => onSelectSttProvider(provider.id)}
                type="button"
              >
                <div className="llm-provider-item-header">
                  <strong>{provider.label}</strong>
                  <span className={availability.ready ? "llm-provider-status ready" : "llm-provider-status"}>
                    {availability.ready ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                    {availability.note}
                  </span>
                </div>
                <p>{provider.description}</p>
                {provider.requiresApiKey && (
                  <span
                    className="ghost-action"
                    onClick={(event) => {
                      event.stopPropagation();
                      onConfigureSttApiKey();
                    }}
                    role="button"
                    style={{ width: "fit-content", cursor: "pointer" }}
                    tabIndex={0}
                  >
                    <KeyRound size={14} />
                    API 키 설정
                  </span>
                )}
                {provider.requiresNaverClovaConfig && (
                  <span
                    className="ghost-action"
                    onClick={(event) => {
                      event.stopPropagation();
                      onConfigureNaverClova();
                    }}
                    role="button"
                    style={{ width: "fit-content", cursor: "pointer" }}
                    tabIndex={0}
                  >
                    <Settings2 size={14} />
                    Invoke URL/Secret Key 설정
                  </span>
                )}
                {provider.requiresHuggingFaceToken && (
                  <span
                    className="ghost-action"
                    onClick={(event) => {
                      event.stopPropagation();
                      onConfigureHuggingFace();
                    }}
                    role="button"
                    style={{ width: "fit-content", cursor: "pointer" }}
                    tabIndex={0}
                  >
                    <KeyRound size={14} />
                    {sttStatus?.huggingFaceTokenSet ? "Hugging Face 토큰 등록됨 (화자 분리 켜짐)" : "화자 분리용 Hugging Face 토큰 설정"}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-title">
          <FolderOpen size={16} />
          저장 폴더
        </div>
        <p className="settings-section-desc">
          Agenda·A/I List에 첨부한 발표 자료 파일을 회의별 폴더로 복사해 두는 위치입니다. 회의별로{" "}
          <code>&lt;폴더&gt;/YYYY-MM-DD-회의 제목/materials/</code>에 저장됩니다. 프로젝트 폴더(<code>C:\Claude\MeetingNote</code>)를
          기준으로 한 상대 경로만 사용하며, 그 하위 폴더만 선택할 수 있습니다.
        </p>
        <div className="field">
          <label>현재 위치 (프로젝트 폴더 기준 상대 경로)</label>
          <input readOnly value={settings.attachmentsFolder || "기본 위치 사용 (data/attachments)"} />
        </div>
        {window.meetingNote?.openFolderDialog ? (
          <button
            className="ghost-action"
            onClick={async () => {
              setFolderError("");
              try {
                const picked = await pickAttachmentsFolder();
                if (picked) {
                  onUpdate("attachmentsFolder", picked);
                }
              } catch (error) {
                setFolderError(error instanceof Error ? error.message : "폴더를 선택하지 못했습니다.");
              }
            }}
            style={{ width: "fit-content" }}
            type="button"
          >
            <FolderOpen size={16} />
            폴더 선택
          </button>
        ) : (
          <span className="field-hint">폴더 선택은 데스크톱 앱(Electron)에서만 가능합니다.</span>
        )}
        {settings.attachmentsFolder && (
          <button className="ghost-action" onClick={() => onUpdate("attachmentsFolder", "")} style={{ width: "fit-content" }} type="button">
            기본 위치로 되돌리기
          </button>
        )}
        {folderError && <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{folderError}</span>}
      </section>

      <section className="settings-section">
        <div className="settings-section-title">
          <Database size={16} />
          데이터
        </div>
        <p className="settings-section-desc">
          총 회의록 <strong>{totalMeetings}건</strong> · <code>data/db/meetings.json</code>
        </p>
        <div className="field">
          <label htmlFor="settings-import-duplicate-mode">가져오기 중복 처리</label>
          <select
            id="settings-import-duplicate-mode"
            onChange={(event) => onUpdate("importDuplicateMode", event.target.value as ImportDuplicateMode)}
            value={settings.importDuplicateMode}
          >
            <option value="replace">기존 회의록 갱신</option>
            <option value="add">항상 새 회의록으로 추가</option>
            <option value="skip">기존 회의록 건너뛰기</option>
          </select>
          <span className="field-hint">제목과 날짜가 같으면 중복으로 판단합니다.</span>
        </div>
        <div className="field">
          <label htmlFor="settings-export-default-format">내보내기 기본 형식</label>
          <select
            id="settings-export-default-format"
            onChange={(event) => onUpdate("exportDefaultFormat", event.target.value as ExportFormat)}
            value={settings.exportDefaultFormat}
          >
            <option value="pdf">PDF</option>
            <option value="docx">Word (docx)</option>
            <option value="pptx">PowerPoint (pptx)</option>
            <option value="json">JSON</option>
          </select>
        </div>
        <button className="danger-action" onClick={onResetToSample} style={{ width: "fit-content" }} type="button">
          샘플 데이터로 초기화
        </button>
      </section>
    </div>
  );
}
