import { BookMarked, Bot, Database, DatabaseBackup, FilePlus2, List, MessageSquare, SpellCheck2, Search, SlidersHorizontal } from "lucide-react";

interface LeftSidebarProps {
  boardActive: boolean;
  filterActive: boolean;
  queryActive: boolean;
  searchActive: boolean;
  onAbbreviationDictionary: () => void;
  onBoard: () => void;
  onCorrectionDictionary: () => void;
  onDbRestore: () => void;
  onDbSave: () => void;
  onFilter: () => void;
  onList: () => void;
  onNewMeeting: () => void;
  onQuery: () => void;
  onSearch: () => void;
}

export function LeftSidebar({
  boardActive,
  filterActive,
  queryActive,
  searchActive,
  onAbbreviationDictionary,
  onBoard,
  onCorrectionDictionary,
  onDbRestore,
  onDbSave,
  onFilter,
  onList,
  onNewMeeting,
  onQuery,
  onSearch
}: LeftSidebarProps) {
  return (
    <aside className="left-sidebar" aria-label="사이드바">
      <nav className="sidebar-group" aria-label="목록 관리">
        <button className="icon-nav-button" onClick={onList} title="목록" type="button">
          <List size={20} />
        </button>
        <button className="icon-nav-button" onClick={onNewMeeting} title="새 회의록" type="button">
          <FilePlus2 size={20} />
        </button>
        <button className="icon-nav-button" onClick={onAbbreviationDictionary} title="약어 사전" type="button">
          <BookMarked size={20} />
        </button>
        <button className="icon-nav-button" onClick={onCorrectionDictionary} title="수정 사전" type="button">
          <SpellCheck2 size={20} />
        </button>
        <button className={boardActive ? "icon-nav-button active" : "icon-nav-button"} onClick={onBoard} title="게시판" type="button">
          <MessageSquare size={20} />
        </button>
      </nav>

      <div className="sidebar-spacer" />

      <div className="sidebar-tools">
        <button className={searchActive ? "icon-button active" : "icon-button"} onClick={onSearch} title="찾기" type="button">
          <Search size={20} />
        </button>
        <button className={filterActive ? "icon-button active" : "icon-button"} onClick={onFilter} title="필터" type="button">
          <SlidersHorizontal size={20} />
        </button>
        <button className={queryActive ? "icon-button active" : "icon-button"} onClick={onQuery} title="질문" type="button">
          <Bot size={20} />
        </button>
        <button className="icon-button" onClick={onDbSave} title="DB저장" type="button">
          <Database size={20} />
        </button>
        <button className="icon-button" onClick={onDbRestore} title="DB복원" type="button">
          <DatabaseBackup size={20} />
        </button>
      </div>
    </aside>
  );
}
