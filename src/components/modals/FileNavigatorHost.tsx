import { useEffect, useState } from "react";
import { registerFileNavigatorHost } from "../../lib/filePicker";
import type { PendingFileNavigatorRequest } from "../../lib/filePicker";
import { FileNavigatorModal } from "./FileNavigatorModal";

// Mounted once near the app root (see App.tsx). Listens for pickFileWithNavigator/
// pickSaveTargetWithNavigator/pickFolderWithNavigator calls from anywhere in the app - including
// plain lib functions with no JSX of their own - and renders the modal for whichever one is
// currently pending.
export function FileNavigatorHost() {
  const [request, setRequest] = useState<PendingFileNavigatorRequest | null>(null);

  useEffect(() => registerFileNavigatorHost(setRequest), []);

  if (!request) {
    return null;
  }

  return <FileNavigatorModal {...request} onDone={() => setRequest(null)} />;
}
