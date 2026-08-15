import { LayoutGrid, Moon, NotebookText, Power, Search, Settings, Sun, Table2 } from "lucide-react";
import type { ViewMode } from "../types/domain";

interface TopToolbarProps {
  buildLabel: string;
  query: string;
  theme: "light" | "dark";
  view: ViewMode;
  onOpenSettings: () => void;
  onQueryChange: (query: string) => void;
  onPower: () => void;
  onTitleClick: () => void;
  onToggleTheme: () => void;
  onViewChange: (view: ViewMode) => void;
  settingsActive: boolean;
}

const VIEW_BUTTONS: { view: ViewMode; label: string; icon: typeof LayoutGrid }[] = [
  { view: "card", label: "카드", icon: LayoutGrid },
  { view: "list", label: "표", icon: Table2 }
];

export function TopToolbar({
  buildLabel,
  query,
  theme,
  view,
  onOpenSettings,
  onQueryChange,
  onPower,
  onTitleClick,
  onToggleTheme,
  onViewChange,
  settingsActive
}: TopToolbarProps) {
  return (
    <header className="top-toolbar">
      <button className="app-title" onClick={onTitleClick} type="button">
        <span className="app-logo-mark">
          <NotebookText size={18} />
        </span>
        <span className="app-title-text">
          <strong>MeetingNote</strong>
          <span className="app-title-version">{buildLabel}</span>
        </span>
      </button>

      <label className="toolbar-search">
        <Search size={18} />
        <input
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="제목, 주관자, 참석자로 검색"
          value={query}
        />
      </label>

      <nav className="toolbar-actions" aria-label="주요 메뉴">
        {VIEW_BUTTONS.map((button) => (
          <button
            className={view === button.view ? "icon-button active" : "icon-button"}
            key={button.view}
            onClick={() => onViewChange(button.view)}
            title={button.label}
            type="button"
          >
            <button.icon size={20} />
          </button>
        ))}
        <div className="toolbar-divider" />
        <button className={settingsActive ? "icon-button active" : "icon-button"} onClick={onOpenSettings} title="설정" type="button">
          <Settings size={20} />
        </button>
        <button className="icon-button" onClick={onToggleTheme} title={theme === "dark" ? "라이트 모드로 전환" : "다크 모드로 전환"} type="button">
          {theme === "dark" ? <Sun size={20} /> : <Moon size={20} />}
        </button>
        <button className="icon-button power-button" onClick={onPower} title="앱 종료" type="button">
          <Power size={20} />
        </button>
      </nav>
    </header>
  );
}
