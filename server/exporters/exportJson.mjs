export function buildJsonExport(meetings) {
  const payload = {
    exportedAt: new Date().toISOString(),
    count: meetings.length,
    meetings
  };

  return Buffer.from(JSON.stringify(payload, null, 2), "utf8");
}
