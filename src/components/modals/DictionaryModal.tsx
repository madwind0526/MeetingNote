import { useMemo, useRef, useState } from "react";
import { CheckCheck, Download, FileUp, Plus, Trash2, Upload } from "lucide-react";
import { ModalShell } from "./ModalShell";
import type { DictionaryEntry } from "../../types/domain";
import { saveExportedFile } from "../../lib/api";
import { pickFileWithConfiguredPicker } from "../../lib/filePicker";

interface DictionaryModalProps {
  kind: "abbreviation" | "correction";
  entries: DictionaryEntry[];
  onApply: () => Promise<number>;
  onClose: () => void;
  onSave: (entries: DictionaryEntry[]) => Promise<void>;
}

const LABELS = {
  abbreviation: { title: "약어 사전", fromLabel: "약어", toLabel: "확장글", fileName: "abbreviation-dictionary.json" },
  correction: { title: "수정 사전", fromLabel: "수정 전", toLabel: "수정 후", fileName: "correction-dictionary.json" }
};

function emptyEntry(): DictionaryEntry {
  return { id: crypto.randomUUID(), from: "", to: "", description: "" };
}

interface ImportConflict {
  existing: DictionaryEntry;
  incoming: DictionaryEntry;
}

function stringToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary);
}

export function DictionaryModal({ kind, entries, onApply, onClose, onSave }: DictionaryModalProps) {
  const [draft, setDraft] = useState<DictionaryEntry[]>(entries);
  const [isSaving, setIsSaving] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState("");
  const [resultMessage, setResultMessage] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  // triggered the currently-open file picker so handleImportFileChange knows whether to merge the
  // parsed rows into the existing draft or replace it outright.
  const importModeRef = useRef<"append" | "replace">("replace");
  // this entirely since it wholesale-replaces the list - there is nothing to conflict with there.
  const [importConflicts, setImportConflicts] = useState<ImportConflict[]>([]);
  const [applyToRemaining, setApplyToRemaining] = useState(false);
  const labels = LABELS[kind];

  const sorted = useMemo(() => [...draft].sort((a, b) => a.from.localeCompare(b.from, "ko")), [draft]);

  const updateEntry = (id: string, patch: Partial<DictionaryEntry>) => {
    setDraft((current) => current.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
  };

  const removeEntry = (id: string) => {
    setDraft((current) => current.filter((entry) => entry.id !== id));
  };

  const addEntry = () => {
    setDraft((current) => [...current, emptyEntry()]);
  };

  const handleSave = async () => {
    setIsSaving(true);
    setError("");
    setResultMessage("");

    try {
      await onSave(draft);
      setResultMessage("저장했습니다.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "저장에 실패했습니다.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleApply = async () => {
    setIsApplying(true);
    setError("");
    setResultMessage("");

    try {
      await onSave(draft);
      const updatedCount = await onApply();
      setResultMessage(`저장 후 이미 분석된 회의록 ${updatedCount}건에 적용했습니다.`);
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : "적용에 실패했습니다.");
    } finally {
      setIsApplying(false);
    }
  };

  const handleExport = async () => {
    setError("");

    try {
      const contentBase64 = stringToBase64(JSON.stringify(draft, null, 2));
      await saveExportedFile({ contentBase64, mimeType: "application/json", fileName: labels.fileName });
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "내보내기에 실패했습니다.");
    }
  };

  const processImportFile = async (file: File) => {
    setError("");

    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const rows = Array.isArray(parsed) ? parsed : [];
      const imported = rows.map((row) => {
        const source = row && typeof row === "object" ? (row as Record<string, unknown>) : {};

        return {
          id: crypto.randomUUID(),
          from: typeof source.from === "string" ? source.from : "",
          to: typeof source.to === "string" ? source.to : "",
          description: typeof source.description === "string" ? source.description : ""
        };
      });

      if (importModeRef.current === "replace") {
        setDraft(imported);
        return;
      }

      const existingByFrom = new Map(draft.map((entry) => [entry.from.trim(), entry]));
      const toAdd: DictionaryEntry[] = [];
      const conflicts: ImportConflict[] = [];

      imported.forEach((entry) => {
        const key = entry.from.trim();
        const existing = key ? existingByFrom.get(key) : undefined;

        if (existing) {
          conflicts.push({ existing, incoming: entry });
        } else {
          toAdd.push(entry);
        }
      });

      if (toAdd.length > 0) {
        setDraft((current) => [...current, ...toAdd]);
      }

      if (conflicts.length > 0) {
        setApplyToRemaining(false);
        setImportConflicts(conflicts);
      }
    } catch {
      setError("JSON 파일을 읽지 못했습니다.");
    }
  };

  const resolveImportConflict = (action: "replace" | "skip") => {
    const targets = applyToRemaining ? importConflicts : importConflicts.slice(0, 1);
    const remaining = applyToRemaining ? [] : importConflicts.slice(1);

    if (action === "replace") {
      const replacements = new Map(targets.map((conflict) => [conflict.existing.id, conflict.incoming]));
      setDraft((current) =>
        current.map((entry) => {
          const incoming = replacements.get(entry.id);
          return incoming ? { ...incoming, id: entry.id } : entry;
        })
      );
    }

    setImportConflicts(remaining);
    if (remaining.length === 0) {
      setApplyToRemaining(false);
    }
  };

  const handleImportFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (file) {
      await processImportFile(file);
    }
  };

  const startImport = async (mode: "append" | "replace") => {
    importModeRef.current = mode;

    const result = await pickFileWithConfiguredPicker([".json"], "약어/수정 사전 JSON 선택");
    if (result.handled) {
      if (result.file) {
        await processImportFile(result.file);
      }
      return;
    }

    fileInputRef.current?.click();
  };

  const currentConflict = importConflicts[0];

  return (
    <>
    <ModalShell
      title={`${labels.title} (총 ${draft.length}개)`}
      onClose={onClose}
      width="large"
      footer={
        <>
          <div className="modal-footer-actions">
            <button className="ghost-action" onClick={addEntry} type="button">
              <Plus size={15} />
              추가
            </button>
            <button className="ghost-action" onClick={() => startImport("append")} title="파일의 항목을 현재 목록에 추가합니다." type="button">
              <FileUp size={15} />
              추가하기
            </button>
            <button className="ghost-action" onClick={() => startImport("replace")} title="현재 목록을 파일 내용으로 대체합니다." type="button">
              <Upload size={15} />
              불러오기
            </button>
            <button className="ghost-action" onClick={handleExport} type="button">
              <Download size={15} />
              내보내기
            </button>
          </div>
          <div className="modal-footer-actions">
            <button className="ghost-action" onClick={onClose} type="button">
              닫기
            </button>
            <button className="ghost-action" disabled={isSaving || isApplying} onClick={handleSave} type="button">
              저장
            </button>
            <button className="primary-action" disabled={isSaving || isApplying} onClick={handleApply} type="button">
              <CheckCheck size={16} />
              적용하기
            </button>
          </div>
        </>
      }
    >
      <div className="field full">
        <label>{labels.title}</label>
        <span className="field-hint">
          "적용하기"는 현재 목록을 저장한 뒤, 이미 분석된 모든 회의록의 대본에도 소급 적용합니다. 이후 새로 분석되는 회의록에는 자동으로
          적용됩니다.
        </span>

        <div className="editable-table-wrap">
          <table className="editable-table">
            <colgroup>
              <col style={{ width: "26%" }} />
              <col style={{ width: "26%" }} />
              <col />
              <col style={{ width: 48 }} />
            </colgroup>
            <thead>
              <tr>
                <th>{labels.fromLabel}</th>
                <th>{labels.toLabel}</th>
                <th>설명</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((entry) => (
                <tr key={entry.id}>
                  <td>
                    <input onChange={(event) => updateEntry(entry.id, { from: event.target.value })} value={entry.from} />
                  </td>
                  <td>
                    <input onChange={(event) => updateEntry(entry.id, { to: event.target.value })} value={entry.to} />
                  </td>
                  <td>
                    <input onChange={(event) => updateEntry(entry.id, { description: event.target.value })} value={entry.description} />
                  </td>
                  <td>
                    <button className="row-icon-button" onClick={() => removeEntry(entry.id)} title="삭제" type="button">
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <input accept="application/json" hidden onChange={handleImportFileChange} ref={fileInputRef} type="file" />
      </div>

      {resultMessage && <span className="field-hint">{resultMessage}</span>}
      {error && <span style={{ color: "#ba3030", fontSize: "0.82rem" }}>{error}</span>}
    </ModalShell>

    {currentConflict && (
      <div className="modal-backdrop" role="presentation">
        <div aria-label="중복 항목 확인" aria-modal="true" className="modal-shell narrow" role="dialog">
          <header className="modal-header">
            <h2>중복 항목 확인</h2>
          </header>
          <div className="modal-body">
            <div className="field full">
              <label>{labels.fromLabel}</label>
              <span className="field-hint">
                "{currentConflict.existing.from}"은(는) 이미 등록되어 있습니다. 가져온 항목으로 교체할까요, 건너뛸까요?
              </span>
            </div>
            <div className="field full">
              <label>기존 내용</label>
              <span className="field-hint">
                {currentConflict.existing.to || "(내용 없음)"} — {currentConflict.existing.description || "설명 없음"}
              </span>
            </div>
            <div className="field full">
              <label>가져온 내용</label>
              <span className="field-hint">
                {currentConflict.incoming.to || "(내용 없음)"} — {currentConflict.incoming.description || "설명 없음"}
              </span>
            </div>
            {importConflicts.length > 1 && (
              <label style={{ alignItems: "center", display: "flex", gap: 6 }}>
                <input
                  checked={applyToRemaining}
                  onChange={(event) => setApplyToRemaining(event.target.checked)}
                  type="checkbox"
                />
                남은 {importConflicts.length - 1}개 중복 항목에도 동일하게 적용
              </label>
            )}
          </div>
          <footer className="modal-footer">
            <div className="modal-footer-actions" style={{ marginLeft: "auto" }}>
              <button className="ghost-action" onClick={() => resolveImportConflict("skip")} type="button">
                건너뛰기
              </button>
              <button className="primary-action" onClick={() => resolveImportConflict("replace")} type="button">
                교체
              </button>
            </div>
          </footer>
        </div>
      </div>
    )}
    </>
  );
}
