import { useRef, useState } from "react";
import {
  Bot,
  CheckCircle2,
  Cpu,
  Database,
  FolderOpen,
  FolderTree,
  Image,
  KeyRound,
  Mic,
  MessageSquare,
  Monitor,
  Settings2,
  ShieldCheck,
  Upload,
  XCircle
} from "lucide-react";
import type { AppSettings, ExportFormat, ImportDuplicateMode, LlmProviderId, SttProviderId, ViewMode } from "../types/domain";
import { llmProviders, sttProviders } from "../types/domain";
import type { LlmStatus, SttStatus } from "../lib/llm";
import { pickAttachmentsFolder, readFileAsDataUrl } from "../lib/api";
import { isBuiltinFilePickerAvailable, pickFileWithConfiguredPicker } from "../lib/filePicker";

interface SettingsViewProps {
  settings: AppSettings;
  totalMeetings: number;
  llmStatus: LlmStatus | null;
  sttStatus: SttStatus | null;
  logoVersion: number;
  isAdmin: boolean;
  onConfigureApiKey: () => void;
  onConfigureSttApiKey: () => void;
  onConfigureNaverClova: () => void;
  onConfigureHuggingFace: () => void;
  onConfigureOllama: () => void;
  onOpenMemberManagement: () => void;
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
  isAdmin,
  onConfigureApiKey,
  onConfigureSttApiKey,
  onConfigureNaverClova,
  onConfigureHuggingFace,
  onConfigureOllama,
  onOpenMemberManagement,
  onResetToSample,
  onSelectLlmProvider,
  onSelectSttProvider,
  onUpdate,
  onUploadLogo
}: SettingsViewProps) {
  const [previewDataUrl, setPreviewDataUrl] = useState("");
  const [folderError, setFolderError] = useState("");
  const logoFileInputRef = useRef<HTMLInputElement>(null);
  const builtinFilePickerAvailable = isBuiltinFilePickerAvailable();

  const processLogoFile = async (file: File) => {
    const dataUrl = await readFileAsDataUrl(file);
    setPreviewDataUrl(dataUrl);
    onUploadLogo(dataUrl);
  };

  const handleLogoFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (file) {
      await processLogoFile(file);
    }
  };

  const triggerLogoPick = async () => {
    const result = await pickFileWithConfiguredPicker([".png", ".jpg", ".jpeg", ".gif", ".webp"], "로고 이미지 선택");
    if (result.handled) {
      if (result.file) {
        await processLogoFile(result.file);
      }
      return;
    }

    logoFileInputRef.current?.click();
  };

  return (
    <div className="settings-panel">
      <section className="settings-section">
        <div className="settings-section-title">
          <Image size={16} />
          로고 화면
          <button className="ghost-action" onClick={() => void triggerLogoPick()} style={{ width: "fit-content" }} type="button">
            <Upload size={16} />
            이미지 업로드
          </button>
        </div>
        <input accept="image/*" hidden onChange={handleLogoFileChange} ref={logoFileInputRef} type="file" />
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
          <Monitor size={16} />
          기본 화면
          <span className="settings-section-desc-inline">앱을 시작했을 때 처음 표시할 보기 선택</span>
        </div>
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
                  <span className="llm-provider-item-title">
                    <strong>{provider.label}</strong>
                    <span className="llm-provider-item-desc">{provider.description}</span>
                  </span>
                  <span className="llm-provider-item-actions">
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
                    <span className={availability.ready ? "llm-provider-status ready" : "llm-provider-status"}>
                      {availability.ready ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                      {availability.note}
                    </span>
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        <div className="field full" style={{ marginTop: 12 }}>
          <label className="settings-section-title" htmlFor="settings-system-message">
            <MessageSquare size={16} />
            System Message
          </label>
          <span className="field-hint">
            질문·회의록 작성·발표 내용 정리 등 모든 LLM 요청에 공통으로 적용되는 지침입니다. 어조나 정리 방식을 지정할 수 있습니다.
          </span>
          <textarea
            id="settings-system-message"
            onChange={(event) => onUpdate("systemMessage", event.target.value)}
            placeholder={
              "당신은 핵심만 정리하는 실무형 회의록 작성자입니다.\n발표 자료와 대본을 바탕으로 결정사항과 액션아이템 중심으로 간결하게 기록하세요.\n배경 설명은 최소화하고, 결론과 담당자·기한이 드러나도록 정리하세요."
            }
            rows={4}
            value={settings.systemMessage}
          />
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-title">
          <Mic size={16} />
          음성 인식 (STT)
          <span className="settings-section-desc-inline">회의 녹음 파일을 대본으로 변환할 때 사용할 방식</span>
        </div>
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
                  <span className="llm-provider-item-title">
                    <strong>{provider.label}</strong>
                    <span className="llm-provider-item-desc">{provider.description}</span>
                  </span>
                  <span className="llm-provider-item-actions">
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
                        Key 설정
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
                        {sttStatus?.huggingFaceTokenSet ? "Hugging Face 토큰 등록됨" : "Hugging Face 토큰 설정"}
                      </span>
                    )}
                    <span className={availability.ready ? "llm-provider-status ready" : "llm-provider-status"}>
                      {availability.ready ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
                      {availability.note}
                    </span>
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-title">
          <Cpu size={16} />
          연산 장치
          <span className="settings-section-desc-inline">로컬 Whisper·WhisperX·Demucs에 모두 적용</span>
          <div className="format-choice-row" style={{ width: "fit-content" }}>
            <button
              className={settings.computeDevice === "gpu" ? "format-choice-button active" : "format-choice-button"}
              onClick={() => onUpdate("computeDevice", "gpu")}
              type="button"
            >
              GPU
            </button>
            <button
              className={settings.computeDevice === "cpu" ? "format-choice-button active" : "format-choice-button"}
              onClick={() => onUpdate("computeDevice", "cpu")}
              type="button"
            >
              CPU
            </button>
          </div>
        </div>

        <p className="settings-section-desc" style={{ marginTop: 12 }}>
          WhisperX 전용 음성 감지(VAD) 민감도 - 발화가 자주 끊기면 값을 낮추고, 잡음까지 잡히면 높이세요.
        </p>
        <div className="field" style={{ display: "flex", gap: 24 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              max={1}
              min={0}
              onChange={(event) => onUpdate("vadOnset", Number(event.target.value))}
              step={0.05}
              style={{ width: 72, flexShrink: 0 }}
              type="number"
              value={settings.vadOnset}
            />
            VAD onset (발화 시작 민감도)
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              max={1}
              min={0}
              onChange={(event) => onUpdate("vadOffset", Number(event.target.value))}
              step={0.05}
              style={{ width: 72, flexShrink: 0 }}
              type="number"
              value={settings.vadOffset}
            />
            VAD offset (발화 종료 민감도)
          </label>
        </div>

        <p className="settings-section-desc" style={{ marginTop: 12 }}>
          무음 임계값 - 이 값보다 조용한 구간은 STT에 보내지 않아 없는 말을 만들어내는 환각을 방지합니다. WhisperX 외의 모든 프로바이더에도
          적용됩니다.
        </p>
        <div className="field" style={{ display: "flex", gap: 24 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              max={0.5}
              min={0}
              onChange={(event) => onUpdate("silenceThreshold", Number(event.target.value))}
              step={0.001}
              style={{ width: 72, flexShrink: 0 }}
              type="number"
              value={settings.silenceThreshold}
            />
            무음 임계값 (환각 방지)
          </label>
        </div>

        <p className="settings-section-desc" style={{ marginTop: 12 }}>
          회의 길이별 STT 청크 크기 - 오디오를 몇 분 단위로 잘라서 STT를 호출할지 결정합니다. 회의가 길수록 큰 청크가
          유리합니다(모델 로딩 등 청크당 고정 비용이 덜 반복됨). 비워두면 괄호 안 기본값을 사용합니다.
        </p>
        <div className="field" style={{ display: "flex", gap: 24 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              min={1}
              onChange={(event) => onUpdate("chunkMinutesShort", event.target.value)}
              placeholder="1"
              step={1}
              style={{ width: 60, flexShrink: 0 }}
              type="number"
              value={settings.chunkMinutesShort}
            />
            10분 미만 회의 (기본 1분)
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              min={1}
              onChange={(event) => onUpdate("chunkMinutesMedium", event.target.value)}
              placeholder="2"
              step={1}
              style={{ width: 60, flexShrink: 0 }}
              type="number"
              value={settings.chunkMinutesMedium}
            />
            10~30분 회의 (기본 2분)
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              min={1}
              onChange={(event) => onUpdate("chunkMinutesLong", event.target.value)}
              placeholder="5"
              step={1}
              style={{ width: 60, flexShrink: 0 }}
              type="number"
              value={settings.chunkMinutesLong}
            />
            30분 이상 회의 (기본 5분)
          </label>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-title">
          <FolderTree size={16} />
          탐색기 방식
          <span className="settings-section-desc-inline">파일을 열고 저장하는 방식 결정</span>
        </div>
        <div className="format-choice-row">
          <button
            className={settings.filePickerMode === "native" ? "format-choice-button active" : "format-choice-button"}
            onClick={() => onUpdate("filePickerMode", "native")}
            type="button"
          >
            탐색기 (OS 기본)
          </button>
          <button
            className={settings.filePickerMode === "builtin" ? "format-choice-button active" : "format-choice-button"}
            disabled={!builtinFilePickerAvailable}
            onClick={() => onUpdate("filePickerMode", "builtin")}
            type="button"
          >
            내장 파일 탐색기
          </button>
        </div>
      </section>

      <section className="settings-section">
        <div className="settings-section-title">
          <FolderOpen size={16} />
          저장 폴더
        </div>
        <p className="settings-section-desc">
          Agenda·A/I List에 첨부한 발표 자료 저장 (회의별로 <code>&lt;폴더&gt;/YYYY-MM-DD-회의 제목/materials/</code>)
        </p>
        <div className="field">
          <label>현재 위치 (프로젝트 폴더 기준 상대 경로)</label>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input readOnly style={{ flex: 1 }} value={settings.attachmentsFolder || "기본 위치 사용 (data/attachments)"} />
            {window.meetingNote?.openFolderDialog || builtinFilePickerAvailable ? (
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
                style={{ width: "fit-content", flexShrink: 0 }}
                type="button"
              >
                <FolderOpen size={16} />
                폴더 선택
              </button>
            ) : (
              <span className="field-hint" style={{ flexShrink: 0 }}>
                폴더 선택은 데스크톱 앱(Electron)에서만 가능합니다.
              </span>
            )}
            {settings.attachmentsFolder && (
              <button
                className="ghost-action"
                onClick={() => onUpdate("attachmentsFolder", "")}
                style={{ width: "fit-content", flexShrink: 0 }}
                type="button"
              >
                기본 위치로 되돌리기
              </button>
            )}
          </div>
        </div>
        {folderError && <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{folderError}</span>}
      </section>

      <section className="settings-section">
        <div className="settings-section-title">
          <Database size={16} />
          데이터
          <span className="settings-section-desc-inline">
            총 회의록 <strong>{totalMeetings}건</strong> · <code>data/db/meetings.json</code>
          </span>
        </div>
        <div className="settings-field-row">
          <div className="field">
            <label htmlFor="settings-import-duplicate-mode">
              가져오기 중복 처리 <span className="field-hint">(제목·날짜 같으면 중복)</span>
            </label>
            <select
              id="settings-import-duplicate-mode"
              onChange={(event) => onUpdate("importDuplicateMode", event.target.value as ImportDuplicateMode)}
              value={settings.importDuplicateMode}
            >
              <option value="replace">기존 회의록 갱신</option>
              <option value="add">항상 새 회의록으로 추가</option>
              <option value="skip">기존 회의록 건너뛰기</option>
            </select>
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
        </div>
        <button className="danger-action" onClick={onResetToSample} style={{ width: "fit-content" }} type="button">
          샘플 데이터로 초기화
        </button>
      </section>

      {isAdmin && (
        <section className="settings-section">
          <div className="settings-section-title">
            <ShieldCheck size={16} />
            계정 관리
            <span className="settings-section-desc-inline">로그인 계정을 추가·관리, admin 전용</span>
            <button className="ghost-action" onClick={onOpenMemberManagement} style={{ width: "fit-content" }} type="button">
              <ShieldCheck size={16} />
              계정 관리 열기
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
