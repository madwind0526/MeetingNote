import { useCallback, useEffect, useMemo, useState } from "react";
import { TopToolbar } from "./components/TopToolbar";
import { LeftSidebar } from "./components/LeftSidebar";
import { SettingsView } from "./components/SettingsView";
import { CardView } from "./components/views/CardView";
import { ListView } from "./components/views/ListView";
import { MeshView } from "./components/views/MeshView";
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
import { MemberManagementModal } from "./components/modals/MemberManagementModal";
import { IntroScreen } from "./components/IntroScreen";
import { LoginView } from "./components/LoginView";
import { BoardView } from "./components/views/BoardView";
import { DictionaryModal } from "./components/modals/DictionaryModal";
import { FileNavigatorHost } from "./components/modals/FileNavigatorHost";
import type {
  AppSettings,
  BoardPost,
  DictionaryEntry,
  LlmProviderId,
  Meeting,
  MeetingDraft,
  MeetingFilters,
  PublicMember,
  SttProviderId,
  ViewMode
} from "./types/domain";
import {
  attendeeSummary,
  computeMeetingConnectionCounts,
  computeMeetingStatus,
  emptyFilters,
  extractMeetingTags,
  matchesFilterTerms,
  parseFilterTerms
} from "./types/domain";
import { clearSession, fetchMembers, loadSession } from "./lib/auth";
import { listBoardPosts, saveBoardPosts } from "./lib/board";
import { applyDictionaryToAllMeetings, fetchDictionary, saveDictionary } from "./lib/dictionary";
import type { DictionaryState } from "./lib/dictionary";
import {
  addMeetingCommentRequest,
  createMeetingRequest,
  deleteMeetingCommentRequest,
  deleteMeetingRequest,
  fetchMeetings,
  resetMeetingsRequest,
  saveLogoImage,
  updateMeetingRequest
} from "./lib/api";
import type { ImportSummary } from "./lib/api";
import { loadSettings, loadSettingsFile, saveSettings } from "./lib/settings";
import { setSettingsMirror } from "./lib/settingsMirror";
import type { LlmStatus, SttStatus } from "./lib/llm";
import { clearApiKey, clearNaverClovaConfig, fetchLlmStatus, fetchSttStatus, saveApiKey, saveNaverClovaConfig } from "./lib/llm";
import { FALLBACK_BUILD_INFO, loadRuntimeBuildInfo } from "./lib/buildInfo";
import type { BuildInfo } from "./lib/buildInfo";

type SidebarModalMode = "search" | "filter" | "query" | "dbRestore" | "dbSave" | "singleExport" | null;
type FormModalState = { mode: "create" } | { mode: "edit"; meeting: Meeting } | null;

// Quick search (top toolbar) matches against every meaningful text field on a meeting - title,
// organizer, secretary, attendees, Agenda/A-I List titles and presenters, B5's per-presentation
// summaries, and the final minutes.
function meetingSearchText(meeting: Meeting) {
  return [
    meeting.title,
    meeting.organizer,
    meeting.secretary,
    attendeeSummary(meeting.attendees),
    meeting.agenda.map((item) => item.title).join(" "),
    meeting.agenda.map((item) => item.presenter).join(" "),
    meeting.agenda.map((item) => item.presentationSummary ?? "").join(" "),
    meeting.actionItems.map((item) => item.title).join(" "),
    meeting.actionItems.map((item) => item.presenter).join(" "),
    meeting.minutes
  ]
    .join(" ")
    .toLowerCase();
}

export function App() {
  const [session, setSession] = useState<PublicMember | null>(() => loadSession());
  const [members, setMembers] = useState<PublicMember[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [boardPosts, setBoardPosts] = useState<BoardPost[]>([]);
  const [dictionary, setDictionary] = useState<DictionaryState>({ abbreviations: [], corrections: [] });
  const [view, setView] = useState<ViewMode>("list");
  const [showSettings, setShowSettings] = useState(false);
  const [showBoard, setShowBoard] = useState(false);
  const [showAbbreviationDictionary, setShowAbbreviationDictionary] = useState(false);
  const [showCorrectionDictionary, setShowCorrectionDictionary] = useState(false);
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [settingsDraft, setSettingsDraft] = useState<AppSettings | null>(null);

  useEffect(() => {
    setSettingsMirror(settings);
  }, [settings]);
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
  const [showMemberManagement, setShowMemberManagement] = useState(false);
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
      // fetchMeetings (HTTP) and loadSettingsFile (Electron IPC) don't depend on each other -
      // only applying their results below does - so run them concurrently instead of waiting for
      // the meetings list before even starting the settings load.
      const [loaded, fileSettings] = await Promise.all([
        fetchMeetings().catch((error: unknown) => {
          if (mounted) {
            setSystemMessage(error instanceof Error ? error.message : "회의록을 불러오지 못했습니다.");
          }
          return null;
        }),
        loadSettingsFile()
      ]);

      if (mounted && loaded) {
        setMeetings(loaded);
        setSystemMessage(`회의록 ${loaded.length}건을 불러왔습니다.`);
      }

      if (mounted && fileSettings) {
        setSettings(fileSettings);
        setView(fileSettings.defaultView);
      }
    })();

    return () => {
      mounted = false;
    };
  }, []);

  // Claude CLI / Whisper CLI / WhisperX status checks each spawn a real subprocess - only worth
  // paying that cost when Settings (the only screen that shows this status) is actually open,
  // not on every app launch.
  useEffect(() => {
    if (!showSettings) {
      return;
    }
    void refreshLlmStatus(settings.ollamaBaseUrl);
    void refreshSttStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSettings]);

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
    if (!session) {
      return;
    }

    let mounted = true;

    (async () => {
      try {
        const list = await fetchMembers();
        if (mounted) {
          setMembers(list);
        }
      } catch {
        // Comment/author name resolution just falls back to "알 수 없음" if this fails.
      }
    })();

    return () => {
      mounted = false;
    };
  }, [session]);

  useEffect(() => {
    if (!session) {
      return;
    }

    let mounted = true;

    (async () => {
      try {
        const posts = await listBoardPosts();
        if (mounted) {
          setBoardPosts(posts);
        }
      } catch {
        // Board just shows an empty list if this fails - not worth surfacing as an error.
      }
    })();

    return () => {
      mounted = false;
    };
  }, [session]);

  const handleSaveBoardPosts = async (posts: BoardPost[]) => {
    setBoardPosts(posts);
    try {
      await saveBoardPosts(posts);
    } catch (error) {
      setSystemMessage(error instanceof Error ? error.message : "게시판 저장에 실패했습니다.");
    }
  };

  useEffect(() => {
    if (!session) {
      return;
    }

    let mounted = true;

    (async () => {
      try {
        const loaded = await fetchDictionary();
        if (mounted) {
          setDictionary(loaded);
        }
      } catch {
        // Dictionary modals just show an empty list if this fails - not worth surfacing as an error.
      }
    })();

    return () => {
      mounted = false;
    };
  }, [session]);

  const handleSaveAbbreviations = async (entries: DictionaryEntry[]) => {
    const next = { ...dictionary, abbreviations: entries };
    setDictionary(next);
    await saveDictionary(next);
  };

  const handleSaveCorrections = async (entries: DictionaryEntry[]) => {
    const next = { ...dictionary, corrections: entries };
    setDictionary(next);
    await saveDictionary(next);
  };

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setDebouncedQuery(query), 220);
    return () => window.clearTimeout(timeoutId);
  }, [query]);

  // Based on the full, unfiltered meeting set (not visibleMeetings) so the Connection range filter
  // and Mesh view's own node degrees never disagree with each other and so opening/clearing the
  // filter can never create a feedback loop that shrinks its own upper bound.
  const connectionCounts = useMemo(() => computeMeetingConnectionCounts(meetings), [meetings]);
  const maxConnectionCount = useMemo(() => Math.max(0, ...Array.from(connectionCounts.values())), [connectionCounts]);

  const visibleMeetings = useMemo(() => {
    const normalizedQuery = debouncedQuery.trim().toLowerCase();
    // Each text field supports the [*]AND / [+]OR / [-]NOT query syntax (comma-separated terms,
    // unprefixed terms default to AND) - see parseFilterTerms/matchesFilterTerms in types/domain.ts.
    const titleTerms = parseFilterTerms(filters.titleText);
    const organizerTerms = parseFilterTerms(filters.organizerText);
    const presenterTerms = parseFilterTerms(filters.presenterText);
    const presentationSummaryTerms = parseFilterTerms(filters.presentationSummaryText);
    const tagTerms = parseFilterTerms(filters.tagText);
    const connectionMax = filters.connectionMax > 0 ? filters.connectionMax : Number.POSITIVE_INFINITY;

    return meetings.filter((meeting) => {
      const queryMatches = !normalizedQuery || meetingSearchText(meeting).includes(normalizedQuery);
      const status = computeMeetingStatus(meeting);
      const statusMatches = filters.statuses.length === 0 || filters.statuses.includes(status);
      const titleMatches = matchesFilterTerms(meeting.title, titleTerms);
      const organizerMatches = matchesFilterTerms(meeting.organizer, organizerTerms);
      const presenterMatches = matchesFilterTerms(
        [...meeting.agenda.map((item) => item.presenter), ...meeting.actionItems.map((item) => item.presenter)].join(" "),
        presenterTerms
      );
      const presentationSummaryMatches = matchesFilterTerms(
        meeting.agenda.map((item) => item.presentationSummary ?? "").join(" "),
        presentationSummaryTerms
      );
      const tagMatches = matchesFilterTerms(extractMeetingTags(meeting).join(" "), tagTerms);
      const connectionCount = connectionCounts.get(meeting.id) ?? 0;
      const connectionMatches = connectionCount >= filters.connectionMin && connectionCount <= connectionMax;
      const dateFromMatches = !filters.dateFrom || meeting.date >= filters.dateFrom;
      const dateToMatches = !filters.dateTo || meeting.date <= filters.dateTo;

      return (
        queryMatches &&
        statusMatches &&
        titleMatches &&
        organizerMatches &&
        presenterMatches &&
        presentationSummaryMatches &&
        tagMatches &&
        connectionMatches &&
        dateFromMatches &&
        dateToMatches
      );
    });
  }, [meetings, debouncedQuery, filters, connectionCounts]);

  const hasActiveFilters =
    filters.statuses.length > 0 ||
    Boolean(
      filters.titleText.trim() ||
        filters.organizerText.trim() ||
        filters.presenterText.trim() ||
        filters.presentationSummaryText.trim() ||
        filters.tagText.trim() ||
        filters.connectionMin > 0 ||
        filters.connectionMax > 0 ||
        filters.dateFrom ||
        filters.dateTo
    );

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
    setShowBoard(false);
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

  const handleCreateSubmit = async (draft: MeetingDraft, presetId?: string) => {
    if (!session) {
      return;
    }

    const meeting = await createMeetingRequest(draft, session.id, presetId);
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

  const handleAddComment = async (meetingId: string, content: string) => {
    if (!session) {
      return;
    }

    try {
      const updated = await addMeetingCommentRequest(meetingId, session.id, content);
      setMeetings((current) => current.map((item) => (item.id === meetingId ? updated : item)));
      setDetailMeeting((current) => (current?.id === meetingId ? updated : current));
    } catch (error) {
      setSystemMessage(error instanceof Error ? error.message : "댓글 등록에 실패했습니다.");
    }
  };

  const handleDeleteComment = async (meetingId: string, commentId: string) => {
    try {
      const updated = await deleteMeetingCommentRequest(meetingId, commentId);
      setMeetings((current) => current.map((item) => (item.id === meetingId ? updated : item)));
      setDetailMeeting((current) => (current?.id === meetingId ? updated : current));
    } catch (error) {
      setSystemMessage(error instanceof Error ? error.message : "댓글 삭제에 실패했습니다.");
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

  if (!session) {
    return <LoginView logoVersion={logoVersion} onLoginSuccess={setSession} theme={settings.theme} />;
  }

  const handleLogout = () => {
    clearSession();
    setSession(null);
  };

  return (
    <main className={`app-shell ${appTheme}`}>
      <FileNavigatorHost />
      {showIntro && <IntroScreen buildLabel={buildInfo.buildLabel} logoVersion={logoVersion} onFinished={() => setShowIntro(false)} />}

      <TopToolbar
        buildLabel={buildInfo.buildLabel}
        currentMemberName={session.name}
        query={query}
        theme={appTheme}
        view={view}
        onLogout={handleLogout}
        onOpenSettings={handleOpenSettings}
        onQueryChange={setQuery}
        onTitleClick={() => {
          setSettingsDraft(null);
          setShowSettings(false);
          setShowBoard(false);
          setQuery("");
          setShowIntro(true);
        }}
        onToggleTheme={handleToggleTheme}
        onViewChange={(nextView) => {
          setSettingsDraft(null);
          setShowSettings(false);
          setShowBoard(false);
          setView(nextView);
        }}
        settingsActive={showSettings}
      />

      <LeftSidebar
        boardActive={showBoard}
        filterActive={hasActiveFilters}
        queryActive={false}
        searchActive={Boolean(query.trim())}
        onAbbreviationDictionary={() => setShowAbbreviationDictionary(true)}
        onBoard={() => {
          setSettingsDraft(null);
          setShowSettings(false);
          setShowBoard(true);
        }}
        onCorrectionDictionary={() => setShowCorrectionDictionary(true)}
        onDbRestore={() => setSidebarModalMode("dbRestore")}
        onDbSave={() => setSidebarModalMode("dbSave")}
        onFilter={() => setSidebarModalMode("filter")}
        onList={() => {
          setSettingsDraft(null);
          setShowSettings(false);
          setShowBoard(false);
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
                isAdmin={session.role === "admin"}
                llmStatus={llmStatus}
                logoVersion={logoVersion}
                onConfigureApiKey={() => setShowLlmApiKeyModal(true)}
                onConfigureSttApiKey={() => setShowSttApiKeyModal(true)}
                onConfigureNaverClova={() => setShowNaverClovaConfig(true)}
                onConfigureHuggingFace={() => setShowHfTokenModal(true)}
                onConfigureOllama={() => setShowOllamaConfig(true)}
                onOpenMemberManagement={() => setShowMemberManagement(true)}
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
        ) : showBoard ? (
          <BoardView
            currentMember={session}
            members={members}
            onSave={handleSaveBoardPosts}
            onSystemMessage={setSystemMessage}
            posts={boardPosts}
          />
        ) : view === "mesh" ? (
          <MeshView meetings={visibleMeetings} onOpen={setDetailMeeting} />
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

            {view === "card" && (
              <CardView currentMember={session} meetings={visibleMeetings} onDelete={setDeleteCandidate} onOpen={setDetailMeeting} />
            )}
            {view === "list" && (
              <ListView
                currentMember={session}
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
          dictionary={dictionary}
          llmProvider={activeLlmProvider}
          mode="create"
          ollamaConfig={ollamaConfig}
          onClose={() => setFormModal(null)}
          onDictionaryChange={setDictionary}
          onSubmit={handleCreateSubmit}
          sttProvider={activeSttProvider}
        />
      )}

      {formModal?.mode === "edit" && (
        <MeetingFormModal
          dictionary={dictionary}
          initial={formModal.meeting}
          llmProvider={activeLlmProvider}
          mode="edit"
          ollamaConfig={ollamaConfig}
          onClose={() => setFormModal(null)}
          onDictionaryChange={setDictionary}
          onSubmit={(draft) => handleEditSubmit(formModal.meeting.id, draft)}
          sttProvider={activeSttProvider}
        />
      )}

      {detailMeeting && (
        <MeetingDetailModal
          currentMember={session}
          meeting={detailMeeting}
          members={members}
          onAddComment={handleAddComment}
          onClose={() => setDetailMeeting(null)}
          onDelete={setDeleteCandidate}
          onDeleteComment={handleDeleteComment}
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
          connectionMax={maxConnectionCount}
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

      {showMemberManagement && <MemberManagementModal onClose={() => setShowMemberManagement(false)} />}

      {showAbbreviationDictionary && (
        <DictionaryModal
          entries={dictionary.abbreviations}
          kind="abbreviation"
          onApply={applyDictionaryToAllMeetings}
          onClose={() => setShowAbbreviationDictionary(false)}
          onSave={handleSaveAbbreviations}
        />
      )}

      {showCorrectionDictionary && (
        <DictionaryModal
          entries={dictionary.corrections}
          kind="correction"
          onApply={applyDictionaryToAllMeetings}
          onClose={() => setShowCorrectionDictionary(false)}
          onSave={handleSaveCorrections}
        />
      )}
    </main>
  );
}
