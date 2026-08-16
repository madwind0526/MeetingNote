import { useCallback, useEffect, useMemo, useState } from "react";
import { TopToolbar } from "./components/TopToolbar";
import { LeftSidebar } from "./components/LeftSidebar";
import { SettingsView } from "./components/SettingsView";
import { CardView } from "./components/views/CardView";
import { ListView } from "./components/views/ListView";
import type { ListSortKey } from "./components/views/ListView";
import { MeetingFormModal } from "./components/modals/MeetingFormModal";
import { MeetingDetailModal } from "./components/modals/MeetingDetailModal";
import { SearchModal } from "./components/modals/SearchModal";
import { FilterModal } from "./components/modals/FilterModal";
import { QueryModal } from "./components/modals/QueryModal";
import { ImportModal } from "./components/modals/ImportModal";
import { ExportModal } from "./components/modals/ExportModal";
import { SingleExportModal } from "./components/modals/SingleExportModal";
import { ConfirmModal } from "./components/modals/ConfirmModal";
import { ApiKeyModal } from "./components/modals/ApiKeyModal";
import { OllamaConfigModal } from "./components/modals/OllamaConfigModal";
import { NaverClovaConfigModal } from "./components/modals/NaverClovaConfigModal";
import { IntroScreen } from "./components/IntroScreen";
import type { AppSettings, LlmProviderId, Meeting, MeetingDraft, MeetingFilters, SttProviderId, ViewMode } from "./types/domain";
import { attendeeSummary, computeMeetingStatus, emptyFilters } from "./types/domain";
import {
  createMeetingRequest,
  deleteMeetingRequest,
  fetchMeetings,
  resetMeetingsRequest,
  saveLogoImage,
  updateMeetingRequest
} from "./lib/api";
import type { ImportSummary } from "./lib/api";
import { loadSettings, loadSettingsFile, saveSettings } from "./lib/settings";
import type { LlmStatus, SttStatus } from "./lib/llm";
import { clearApiKey, clearNaverClovaConfig, fetchLlmStatus, fetchSttStatus, saveApiKey, saveNaverClovaConfig } from "./lib/llm";
import { FALLBACK_BUILD_INFO, loadRuntimeBuildInfo } from "./lib/buildInfo";
import type { BuildInfo } from "./lib/buildInfo";

type SidebarModalMode = "search" | "filter" | "query" | "dbRestore" | "dbSave" | "singleExport" | null;
type FormModalState = { mode: "create"; autoImport?: boolean } | { mode: "edit"; meeting: Meeting } | null;

function meetingSearchText(meeting: Meeting) {
  return [
    meeting.title,
    meeting.organizer,
    attendeeSummary(meeting.attendees),
    meeting.agenda.map((item) => item.title).join(" "),
    meeting.minutes
  ]
    .join(" ")
    .toLowerCase();
}

export function App() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [view, setView] = useState<ViewMode>("list");
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [settingsDraft, setSettingsDraft] = useState<AppSettings | null>(null);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [filters, setFilters] = useState<MeetingFilters>(emptyFilters);
  const [sidebarModalMode, setSidebarModalMode] = useState<SidebarModalMode>(null);
  const [formModal, setFormModal] = useState<FormModalState>(null);
  const [detailMeeting, setDetailMeeting] = useState<Meeting | null>(null);
  const [deleteCandidate, setDeleteCandidate] = useState<Meeting | null>(null);
  const [singleExportMeetingId, setSingleExportMeetingId] = useState<string | undefined>(undefined);
  const [showIntro, setShowIntro] = useState(true);
  const [logoVersion, setLogoVersion] = useState(0);
  const [listSortKey, setListSortKey] = useState<ListSortKey>("date");
  const [listSortAsc, setListSortAsc] = useState(false);
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [sttStatus, setSttStatus] = useState<SttStatus | null>(null);
  const [showLlmApiKeyModal, setShowLlmApiKeyModal] = useState(false);
  const [showSttApiKeyModal, setShowSttApiKeyModal] = useState(false);
  const [showNaverClovaConfig, setShowNaverClovaConfig] = useState(false);
  const [showHfTokenModal, setShowHfTokenModal] = useState(false);
  const [showOllamaConfig, setShowOllamaConfig] = useState(false);
  const [systemMessage, setSystemMessage] = useState("준비되었습니다.");
  const [buildInfo, setBuildInfo] = useState<BuildInfo>(FALLBACK_BUILD_INFO);

  const refreshLlmStatus = useCallback(async (ollamaBaseUrl?: string) => {
    try {
      setLlmStatus(await fetchLlmStatus(ollamaBaseUrl));
    } catch {
      // Settings screen just shows "확인 중..." if this fails - not worth surfacing as an error.
    }
  }, []);

  const refreshSttStatus = useCallback(async () => {
    try {
      setSttStatus(await fetchSttStatus());
    } catch {
      // Same as above - Settings just keeps showing "확인 중...".
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    (async () => {
      try {
        const loaded = await fetchMeetings();
        if (mounted) {
          setMeetings(loaded);
          setSystemMessage(`회의록 ${loaded.length}건을 불러왔습니다.`);
        }
      } catch (error) {
        if (mounted) {
          setSystemMessage(error instanceof Error ? error.message : "회의록을 불러오지 못했습니다.");
        }
      }

      const fileSettings = await loadSettingsFile();
      if (mounted && fileSettings) {
        setSettings(fileSettings);
        setView(fileSettings.defaultView);
      }

      void refreshLlmStatus(fileSettings?.ollamaBaseUrl ?? settings.ollamaBaseUrl);
      void refreshSttStatus();
    })();

    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshLlmStatus, refreshSttStatus]);

  useEffect(() => {
    let mounted = true;

    void loadRuntimeBuildInfo().then((runtimeBuildInfo) => {
      if (mounted) {
        setBuildInfo(runtimeBuildInfo);
      }
    });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setDebouncedQuery(query), 220);
    return () => window.clearTimeout(timeoutId);
  }, [query]);

  const visibleMeetings = useMemo(() => {
    const normalizedQuery = debouncedQuery.trim().toLowerCase();
    const organizerText = filters.organizerText.trim().toLowerCase();
    const attendeeText = filters.attendeeText.trim().toLowerCase();
    const keywordText = filters.keywordText.trim().toLowerCase();

    return meetings.filter((meeting) => {
      const queryMatches = !normalizedQuery || meetingSearchText(meeting).includes(normalizedQuery);
      const status = computeMeetingStatus(meeting);
      const statusMatches = filters.statuses.length === 0 || filters.statuses.includes(status);
      const organizerMatches = !organizerText || meeting.organizer.toLowerCase().includes(organizerText);
      const attendeeMatches = !attendeeText || attendeeSummary(meeting.attendees).toLowerCase().includes(attendeeText);
      const keywordMatches =
        !keywordText ||
        [meeting.title, ...meeting.agenda.map((item) => item.title), ...meeting.actionItems.map((item) => item.title)]
          .join(" ")
          .toLowerCase()
          .includes(keywordText);
      const dateFromMatches = !filters.dateFrom || meeting.date >= filters.dateFrom;
      const dateToMatches = !filters.dateTo || meeting.date <= filters.dateTo;

      return queryMatches && statusMatches && organizerMatches && attendeeMatches && keywordMatches && dateFromMatches && dateToMatches;
    });
  }, [meetings, debouncedQuery, filters]);

  const hasActiveFilters =
    filters.statuses.length > 0 ||
    Boolean(filters.organizerText.trim() || filters.attendeeText.trim() || filters.keywordText.trim() || filters.dateFrom || filters.dateTo);

  const updateSettings = useCallback(<Key extends keyof AppSettings>(key: Key, value: AppSettings[Key]) => {
    setSettings((current) => {
      const next = { ...current, [key]: value };
      saveSettings(next);
      return next;
    });
  }, []);

  const updateSettingsDraft = useCallback(
    <Key extends keyof AppSettings>(key: Key, value: AppSettings[Key]) => {
      setSettingsDraft((current) => ({ ...(current ?? settings), [key]: value }));
    },
    [settings]
  );

  const handleOpenSettings = useCallback(() => {
    setSettingsDraft((current) => current ?? settings);
    setShowSettings(true);
  }, [settings]);

  const handleCancelSettings = useCallback(() => {
    setSettingsDraft(null);
    setShowSettings(false);
    setView(settings.defaultView);
  }, [settings.defaultView]);

  const handleSaveSettings = useCallback(() => {
    const next = settingsDraft ?? settings;
    setSettings(next);
    saveSettings(next);
    setSettingsDraft(null);
    setShowSettings(false);
    setView(next.defaultView);
    setSystemMessage("설정을 저장했습니다.");
  }, [settings, settingsDraft]);

  const handleToggleTheme = useCallback(() => {
    const currentTheme = (showSettings ? settingsDraft ?? settings : settings).theme;
    const nextTheme = currentTheme === "dark" ? "light" : "dark";

    if (showSettings) {
      updateSettingsDraft("theme", nextTheme);
      return;
    }

    updateSettings("theme", nextTheme);
  }, [settings, settingsDraft, showSettings, updateSettings, updateSettingsDraft]);

  const handleRefresh = async () => {
    try {
      const loaded = await fetchMeetings();
      setMeetings(loaded);
      setSystemMessage(`회의록 ${loaded.length}건을 새로고침했습니다.`);
    } catch (error) {
      setSystemMessage(error instanceof Error ? error.message : "새로고침에 실패했습니다.");
    }
  };

  const handleQuitApp = async () => {
    try {
      if (window.meetingNote?.quitApp) {
        await window.meetingNote.quitApp();
        return;
      }

      window.close();
    } catch {
      setSystemMessage("앱 종료에 실패했습니다.");
    }
  };

  const handleCreateSubmit = async (draft: MeetingDraft, presetId?: string) => {
    const meeting = await createMeetingRequest(draft, presetId);
    setMeetings((current) => [...current, meeting]);
    setFormModal(null);
    setSystemMessage(`"${meeting.title || "제목 없음"}" 회의록을 등록했습니다.`);
  };

  const handleEditSubmit = async (id: string, draft: MeetingDraft) => {
    const updated = await updateMeetingRequest(id, draft);
    setMeetings((current) => current.map((item) => (item.id === id ? updated : item)));
    setFormModal(null);
    setDetailMeeting((current) => (current?.id === id ? updated : current));
    setSystemMessage(`"${updated.title || "제목 없음"}" 회의록을 수정했습니다.`);
  };

  const handleConfirmDelete = async () => {
    if (!deleteCandidate) {
      return;
    }

    try {
      await deleteMeetingRequest(deleteCandidate.id);
      setMeetings((current) => current.filter((item) => item.id !== deleteCandidate.id));
      setSystemMessage(`"${deleteCandidate.title || "제목 없음"}" 회의록을 삭제했습니다.`);
    } catch (error) {
      setSystemMessage(error instanceof Error ? error.message : "삭제에 실패했습니다.");
    } finally {
      setDeleteCandidate(null);
      setDetailMeeting(null);
    }
  };

  const handleResetToSample = async () => {
    try {
      const loaded = await resetMeetingsRequest();
      setMeetings(loaded);
      setSystemMessage("샘플 데이터로 초기화했습니다.");
    } catch (error) {
      setSystemMessage(error instanceof Error ? error.message : "초기화에 실패했습니다.");
    }
  };

  const openEditFromDetail = (meeting: Meeting) => {
    setDetailMeeting(null);
    setFormModal({ mode: "edit", meeting });
  };

  const openExportFromDetail = (meeting: Meeting) => {
    setDetailMeeting(null);
    setSingleExportMeetingId(meeting.id);
    setSidebarModalMode("singleExport");
  };

  const handleSaveAnthropicApiKey = async (apiKey: string) => {
    await saveApiKey("anthropic", apiKey);
    await refreshLlmStatus(settings.ollamaBaseUrl);
    setShowLlmApiKeyModal(false);
    setSystemMessage("Anthropic API 키를 저장했습니다.");
  };

  const handleClearAnthropicApiKey = async () => {
    await clearApiKey("anthropic");
    await refreshLlmStatus(settings.ollamaBaseUrl);
    setShowLlmApiKeyModal(false);
    setSystemMessage("Anthropic API 키를 삭제했습니다.");
  };

  const handleSaveOpenaiApiKey = async (apiKey: string) => {
    await saveApiKey("openai", apiKey);
    await refreshSttStatus();
    setShowSttApiKeyModal(false);
    setSystemMessage("OpenAI API 키를 저장했습니다.");
  };

  const handleClearOpenaiApiKey = async () => {
    await clearApiKey("openai");
    await refreshSttStatus();
    setShowSttApiKeyModal(false);
    setSystemMessage("OpenAI API 키를 삭제했습니다.");
  };

  const handleSaveNaverClovaConfig = async (invokeUrl: string, secretKey: string) => {
    await saveNaverClovaConfig(invokeUrl, secretKey);
    await refreshSttStatus();
    setShowNaverClovaConfig(false);
    setSystemMessage("Naver Clova 설정을 저장했습니다.");
  };

  const handleClearNaverClovaConfig = async () => {
    await clearNaverClovaConfig();
    await refreshSttStatus();
    setShowNaverClovaConfig(false);
    setSystemMessage("Naver Clova 설정을 삭제했습니다.");
  };

  const handleSaveHfToken = async (token: string) => {
    await saveApiKey("huggingface", token);
    await refreshSttStatus();
    setShowHfTokenModal(false);
    setSystemMessage("Hugging Face 토큰을 저장했습니다.");
  };

  const handleClearHfToken = async () => {
    await clearApiKey("huggingface");
    await refreshSttStatus();
    setShowHfTokenModal(false);
    setSystemMessage("Hugging Face 토큰을 삭제했습니다.");
  };

  const handleSaveOllamaConfig = async (baseUrl: string, model: string) => {
    if (settingsDraft) {
      setSettingsDraft((current) => ({ ...(current ?? settings), ollamaBaseUrl: baseUrl, ollamaModel: model }));
    } else {
      updateSettings("ollamaBaseUrl", baseUrl);
      updateSettings("ollamaModel", model);
    }
    await refreshLlmStatus(baseUrl);
    setShowOllamaConfig(false);
    setSystemMessage("Ollama 설정을 저장했습니다.");
  };

  const handleUploadLogo = async (dataUrl: string) => {
    try {
      await saveLogoImage(dataUrl);
      setLogoVersion((current) => current + 1);
      setSystemMessage("로고 이미지를 저장했습니다.");
    } catch (error) {
      setSystemMessage(error instanceof Error ? error.message : "로고 저장에 실패했습니다.");
    }
  };

  const settingsViewValues = settingsDraft ?? settings;
  const appTheme = showSettings ? settingsViewValues.theme : settings.theme;
  const ollamaConfig = { ollamaBaseUrl: settings.ollamaBaseUrl, ollamaModel: settings.ollamaModel };
  const activeLlmProvider: LlmProviderId = settings.llmProvider;
  const activeSttProvider: SttProviderId = settings.sttProvider;

  return (
    <main className={`app-shell ${appTheme}`}>
      {showIntro && <IntroScreen buildLabel={buildInfo.buildLabel} logoVersion={logoVersion} onFinished={() => setShowIntro(false)} />}

      <TopToolbar
        buildLabel={buildInfo.buildLabel}
        query={query}
        theme={appTheme}
        view={view}
        onOpenSettings={handleOpenSettings}
        onQueryChange={setQuery}
        onPower={handleQuitApp}
        onTitleClick={() => {
          setSettingsDraft(null);
          setShowSettings(false);
          setQuery("");
          setShowIntro(true);
        }}
        onToggleTheme={handleToggleTheme}
        onViewChange={(nextView) => {
          setSettingsDraft(null);
          setShowSettings(false);
          setView(nextView);
        }}
        settingsActive={showSettings}
      />

      <LeftSidebar
        filterActive={hasActiveFilters}
        queryActive={false}
        searchActive={Boolean(query.trim())}
        onDbRestore={() => setSidebarModalMode("dbRestore")}
        onDbSave={() => setSidebarModalMode("dbSave")}
        onFilter={() => setSidebarModalMode("filter")}
        onImportMeeting={() => setFormModal({ mode: "create", autoImport: true })}
        onExportMeeting={() => {
          setSingleExportMeetingId(undefined);
          setSidebarModalMode("singleExport");
        }}
        onList={() => {
          setSettingsDraft(null);
          setShowSettings(false);
          setView("list");
        }}
        onNewMeeting={() => setFormModal({ mode: "create" })}
        onQuery={() => setSidebarModalMode("query")}
        onSearch={() => setSidebarModalMode("search")}
      />

      <section className="main-window">
        {showSettings ? (
          <>
            <div className="view-header">
              <div>
                <p className="eyebrow">Settings</p>
                <h1>설정</h1>
              </div>
              <div className="view-header-actions">
                <button className="primary-action" onClick={handleSaveSettings} type="button">
                  설정 저장
                </button>
              </div>
            </div>
            <div className="settings-content">
              <SettingsView
                llmStatus={llmStatus}
                logoVersion={logoVersion}
                onConfigureApiKey={() => setShowLlmApiKeyModal(true)}
                onConfigureSttApiKey={() => setShowSttApiKeyModal(true)}
                onConfigureNaverClova={() => setShowNaverClovaConfig(true)}
                onConfigureHuggingFace={() => setShowHfTokenModal(true)}
                onConfigureOllama={() => setShowOllamaConfig(true)}
                onResetToSample={handleResetToSample}
                onSelectLlmProvider={(provider) => updateSettingsDraft("llmProvider", provider)}
                onSelectSttProvider={(provider) => updateSettingsDraft("sttProvider", provider)}
                onUpdate={updateSettingsDraft}
                onUploadLogo={handleUploadLogo}
                settings={settingsViewValues}
                sttStatus={sttStatus}
                totalMeetings={meetings.length}
              />
              <div className="settings-action-bar">
                <button className="ghost-action" onClick={handleCancelSettings} type="button">
                  취소
                </button>
                <button className="primary-action" onClick={handleSaveSettings} type="button">
                  저장
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="view-header">
              <div>
                <p className="eyebrow">{view === "card" ? "Card" : "List"}</p>
                <h1>{view === "card" ? "카드 보기" : "목록 보기"}</h1>
              </div>
              <div className="view-header-actions">
                <div className="view-count">
                  <span>표시 중</span>
                  <strong>
                    {visibleMeetings.length} / {meetings.length}
                  </strong>
                </div>
              </div>
            </div>

            {view === "card" && <CardView meetings={visibleMeetings} onOpen={setDetailMeeting} />}
            {view === "list" && (
              <ListView
                meetings={visibleMeetings}
                onDelete={setDeleteCandidate}
                onEdit={(meeting) => setFormModal({ mode: "edit", meeting })}
                onOpen={setDetailMeeting}
                onSortChange={(key, asc) => {
                  setListSortKey(key);
                  setListSortAsc(asc);
                }}
                sortAsc={listSortAsc}
                sortKey={listSortKey}
              />
            )}
          </>
        )}
      </section>

      <footer className="system-message" aria-live="polite">
        <span>System</span>
        <strong>{systemMessage}</strong>
      </footer>

      {formModal?.mode === "create" && (
        <MeetingFormModal
          autoImport={formModal.autoImport}
          llmProvider={activeLlmProvider}
          mode="create"
          ollamaConfig={ollamaConfig}
          onClose={() => setFormModal(null)}
          onSubmit={handleCreateSubmit}
          sttProvider={activeSttProvider}
        />
      )}

      {formModal?.mode === "edit" && (
        <MeetingFormModal
          initial={formModal.meeting}
          llmProvider={activeLlmProvider}
          mode="edit"
          ollamaConfig={ollamaConfig}
          onClose={() => setFormModal(null)}
          onSubmit={(draft) => handleEditSubmit(formModal.meeting.id, draft)}
          sttProvider={activeSttProvider}
        />
      )}

      {detailMeeting && (
        <MeetingDetailModal
          meeting={detailMeeting}
          onClose={() => setDetailMeeting(null)}
          onDelete={setDeleteCandidate}
          onEdit={openEditFromDetail}
          onExport={openExportFromDetail}
        />
      )}

      {deleteCandidate && (
        <ConfirmModal
          message={`"${deleteCandidate.title || "제목 없음"}" 회의록을 삭제할까요? 이 작업은 되돌릴 수 없습니다.`}
          onCancel={() => setDeleteCandidate(null)}
          onConfirm={handleConfirmDelete}
          title="회의록 삭제"
        />
      )}

      {sidebarModalMode === "search" && (
        <SearchModal
          onApply={(nextQuery) => {
            setQuery(nextQuery);
            setSidebarModalMode(null);
          }}
          onClear={() => {
            setQuery("");
            setSidebarModalMode(null);
          }}
          onClose={() => setSidebarModalMode(null)}
          query={query}
        />
      )}

      {sidebarModalMode === "filter" && (
        <FilterModal
          filters={filters}
          onApply={(nextFilters) => {
            setFilters(nextFilters);
            setSidebarModalMode(null);
          }}
          onClear={() => {
            setFilters(emptyFilters);
            setSidebarModalMode(null);
          }}
          onClose={() => setSidebarModalMode(null)}
        />
      )}

      {sidebarModalMode === "query" && (
        <QueryModal
          meetings={meetings}
          ollamaConfig={ollamaConfig}
          onClose={() => setSidebarModalMode(null)}
          onOpenMeeting={(meeting) => {
            setSidebarModalMode(null);
            setDetailMeeting(meeting);
          }}
          provider={activeLlmProvider}
        />
      )}

      {sidebarModalMode === "dbRestore" && (
        <ImportModal
          duplicateMode={settings.importDuplicateMode}
          onClose={() => setSidebarModalMode(null)}
          onImported={(summary: ImportSummary) => {
            void handleRefresh();
            setSidebarModalMode(null);
            setSystemMessage(
              `DB복원 완료: 신규 ${summary.createdCount}건, 갱신 ${summary.updatedCount}건, 건너뜀 ${summary.skippedCount}건.`
            );
          }}
        />
      )}

      {sidebarModalMode === "dbSave" && (
        <ExportModal
          allMeetings={meetings}
          defaultFormat={settings.exportDefaultFormat}
          onClose={() => setSidebarModalMode(null)}
          onExported={(message) => {
            setSidebarModalMode(null);
            setSystemMessage(message);
          }}
          visibleMeetings={visibleMeetings}
        />
      )}

      {sidebarModalMode === "singleExport" && (
        <SingleExportModal
          defaultFormat={settings.exportDefaultFormat}
          initialMeetingId={singleExportMeetingId}
          meetings={meetings}
          onClose={() => {
            setSidebarModalMode(null);
            setSingleExportMeetingId(undefined);
          }}
          onExported={(message) => {
            setSidebarModalMode(null);
            setSingleExportMeetingId(undefined);
            setSystemMessage(message);
          }}
        />
      )}

      {showLlmApiKeyModal && (
        <ApiKeyModal
          hasExistingKey={Boolean(llmStatus?.anthropicApiKeySet)}
          kind="anthropic"
          onClear={handleClearAnthropicApiKey}
          onClose={() => setShowLlmApiKeyModal(false)}
          onSave={handleSaveAnthropicApiKey}
        />
      )}

      {showSttApiKeyModal && (
        <ApiKeyModal
          hasExistingKey={Boolean(sttStatus?.openaiApiKeySet)}
          kind="openai"
          onClear={handleClearOpenaiApiKey}
          onClose={() => setShowSttApiKeyModal(false)}
          onSave={handleSaveOpenaiApiKey}
        />
      )}

      {showNaverClovaConfig && (
        <NaverClovaConfigModal
          hasExistingConfig={Boolean(sttStatus?.naverClovaConfigured)}
          onClear={handleClearNaverClovaConfig}
          onClose={() => setShowNaverClovaConfig(false)}
          onSave={handleSaveNaverClovaConfig}
        />
      )}

      {showHfTokenModal && (
        <ApiKeyModal
          hasExistingKey={Boolean(sttStatus?.huggingFaceTokenSet)}
          kind="huggingface"
          onClear={handleClearHfToken}
          onClose={() => setShowHfTokenModal(false)}
          onSave={handleSaveHfToken}
        />
      )}

      {showOllamaConfig && (
        <OllamaConfigModal
          availableModels={llmStatus?.ollama.models ?? []}
          initialBaseUrl={settingsViewValues.ollamaBaseUrl}
          initialModel={settingsViewValues.ollamaModel}
          onClose={() => setShowOllamaConfig(false)}
          onSave={handleSaveOllamaConfig}
        />
      )}
    </main>
  );
}
