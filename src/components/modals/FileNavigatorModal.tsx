import { useEffect, useState } from "react";
import { ArrowUp, File as FileIcon, Folder } from "lucide-react";
import { ModalShell } from "./ModalShell";
import { listDirectoryWithNavigator } from "../../lib/filePicker";
import type { PendingFileNavigatorRequest } from "../../lib/filePicker";

interface DirEntry {
  name: string;
  isDirectory: boolean;
}

interface Listing {
  path: string;
  parent: string | null;
  entries: DirEntry[];
  shortcuts: { label: string; path: string }[];
}

function joinPath(dirPath: string, name: string): string {
  const separator = dirPath.endsWith("\\") || dirPath.endsWith("/") ? "" : /\\/.test(dirPath) ? "\\" : "/";
  return `${dirPath}${separator}${name}`;
}

function matchesAccept(name: string, accept?: string[]): boolean {
  if (!accept || accept.length === 0) {
    return true;
  }
  const lowerName = name.toLowerCase();
  return accept.some((extension) => lowerName.endsWith(extension.toLowerCase()));
}

interface FileNavigatorModalProps extends PendingFileNavigatorRequest {
  onDone: () => void;
}

// Backs Settings > 탐색기 방식 > 내장 파일 탐색기: a plain fs.readdir/fs.stat-based folder browser for
// environments where Electron's native dialog module (and the OS Explorer shell it wraps) is
// blocked by security policy. Mounted once by FileNavigatorHost and driven entirely through
// lib/filePicker.ts's request/resolve pair, so it can be triggered from non-component code
// (saveExportedFile, pickAttachmentsFolder) exactly like a native dialog call would be.
export function FileNavigatorModal({ mode, title, accept, defaultFileName, resolve, onDone }: FileNavigatorModalProps) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [pathInput, setPathInput] = useState("");
  const [selectedPath, setSelectedPath] = useState("");
  const [fileName, setFileName] = useState(defaultFileName ?? "");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");

  const load = async (dirPath?: string) => {
    setIsLoading(true);
    try {
      const result = await listDirectoryWithNavigator(dirPath);
      setListing(result);
      setPathInput(result.path);
      setError(result.error ?? "");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "폴더를 열지 못했습니다.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finish = (path: string | null) => {
    resolve(path);
    onDone();
  };

  const handleEntryClick = (entry: DirEntry) => {
    if (!listing) {
      return;
    }
    const fullPath = joinPath(listing.path, entry.name);

    if (entry.isDirectory) {
      void load(fullPath);
      return;
    }
    if (mode === "folder") {
      return;
    }
    if (mode === "open") {
      if (matchesAccept(entry.name, accept)) {
        setSelectedPath(fullPath);
      }
      return;
    }
    setFileName(entry.name);
  };

  const confirmDisabled = mode === "open" ? !selectedPath : mode === "save" ? !fileName.trim() : !listing;

  const handleConfirm = () => {
    if (!listing) {
      return;
    }
    if (mode === "folder") {
      finish(listing.path);
      return;
    }
    if (mode === "open") {
      if (selectedPath) {
        finish(selectedPath);
      }
      return;
    }
    if (fileName.trim()) {
      finish(joinPath(listing.path, fileName.trim()));
    }
  };

  const visibleEntries = mode === "folder" ? (listing?.entries.filter((entry) => entry.isDirectory) ?? []) : (listing?.entries ?? []);

  return (
    <ModalShell
      title={title}
      onClose={() => finish(null)}
      overlayZIndex={1000}
      width="wide"
      footer={
        <div className="modal-footer-actions" style={{ marginLeft: "auto" }}>
          <button className="ghost-action" onClick={() => finish(null)} type="button">
            취소
          </button>
          <button className="primary-action" disabled={confirmDisabled} onClick={handleConfirm} type="button">
            {mode === "open" ? "열기" : mode === "save" ? "저장" : "선택"}
          </button>
        </div>
      }
    >
      <div className="field full">
        <div className="file-navigator-shortcuts">
          {listing?.shortcuts.map((shortcut) => (
            <button className="ghost-action" key={shortcut.path} onClick={() => void load(shortcut.path)} type="button">
              {shortcut.label}
            </button>
          ))}
        </div>

        <div className="file-navigator-pathbar">
          <button
            className="ghost-action"
            disabled={!listing?.parent}
            onClick={() => listing?.parent && void load(listing.parent)}
            title="상위 폴더로 이동"
            type="button"
          >
            <ArrowUp size={15} />
            위로
          </button>
          <input
            onChange={(event) => setPathInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void load(pathInput);
              }
            }}
            value={pathInput}
          />
          <button className="ghost-action" onClick={() => void load(pathInput)} type="button">
            이동
          </button>
        </div>

        <div className="file-navigator-list">
          {isLoading ? (
            <div className="file-navigator-empty">불러오는 중...</div>
          ) : (
            <>
              {listing?.parent && (
                <button className="file-navigator-row" onClick={() => void load(listing.parent!)} type="button">
                  <Folder size={15} />
                  ..
                </button>
              )}
              {visibleEntries.length === 0 && !listing?.parent ? (
                <div className="file-navigator-empty">폴더가 비어 있습니다.</div>
              ) : (
                visibleEntries.map((entry) => {
                  const disabled = mode === "open" && !entry.isDirectory && !matchesAccept(entry.name, accept);
                  const isSelected =
                    (mode === "open" && selectedPath === joinPath(listing?.path ?? "", entry.name)) ||
                    (mode === "save" && !entry.isDirectory && fileName === entry.name);

                  return (
                    <button
                      className={`file-navigator-row${isSelected ? " active" : ""}${disabled ? " disabled" : ""}`}
                      disabled={disabled}
                      key={entry.name}
                      onClick={() => handleEntryClick(entry)}
                      type="button"
                    >
                      {entry.isDirectory ? <Folder size={15} /> : <FileIcon size={15} />}
                      {entry.name}
                    </button>
                  );
                })
              )}
            </>
          )}
        </div>

        {mode !== "folder" && (
          <div className="field full">
            <label>{mode === "open" ? "선택한 파일" : "파일 이름"}</label>
            {mode === "open" ? (
              <input readOnly placeholder="목록에서 파일을 선택하세요" value={selectedPath} />
            ) : (
              <input onChange={(event) => setFileName(event.target.value)} value={fileName} />
            )}
          </div>
        )}

        {error && <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{error}</span>}
      </div>
    </ModalShell>
  );
}
