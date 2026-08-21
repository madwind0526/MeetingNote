import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Calendar, GitBranch, Users, X } from "lucide-react";
import type { Meeting } from "../../types/domain";
import { attendeeSummary, computeMeetingStatus, extractMeetingTags, meetingStatusLabels } from "../../types/domain";

// Layout is a static "sunflower"/golden-angle spiral (not a d3-force simulation) - cheap, single-
// pass, and 100% deterministic for the same dataset (via hashToUnit below instead of Math.random),
// so it doesn't jitter/reshuffle between renders of the same meetings. Ported from SNS-Reader's
// mesh view (C:\Claude\SNS-Reader), which uses the same technique for SNS posts connected by tag.
const meshVisibleEdgeLimit = 360;
const meshCanvasSize = 1000;
const meshPanMargin = 180;
// Also caps the Top TAG sidebar list so it never needs to scroll.
const meshTopTagLimit = 10;

type MeshEdge = {
  from: string;
  to: string;
  sharedTags: string[];
  weight: number;
};

function getMeetingKey(meeting: Meeting, fallback = "") {
  return String(meeting.id || fallback);
}

function getEdgeKey(from: string, to: string) {
  return from < to ? `${from}---${to}` : `${to}---${from}`;
}

function hashToUnit(value: string, salt: number) {
  let hash = 2166136261 ^ salt;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

const MESH_TITLE_LABEL_LENGTH = 10;
const MESH_PREVIEW_SUMMARY_LENGTH = 80;

function truncateMeshTitle(title: string) {
  const trimmed = title.trim() || "제목 없음";
  return trimmed.length > MESH_TITLE_LABEL_LENGTH ? `${trimmed.slice(0, MESH_TITLE_LABEL_LENGTH)}…` : trimmed;
}

function meshSummaryPreview(minutes: string) {
  const trimmed = minutes.trim();
  if (!trimmed) {
    return "회의록이 아직 작성되지 않았습니다.";
  }

  return trimmed.length > MESH_PREVIEW_SUMMARY_LENGTH ? `${trimmed.slice(0, MESH_PREVIEW_SUMMARY_LENGTH)}...` : trimmed;
}

function meshFormatTimeRange(startTime: string, endTime: string) {
  if (startTime && endTime) {
    return `${startTime} - ${endTime}`;
  }

  return startTime || endTime || "시간 미정";
}

function getTagCounts(meetings: Meeting[]) {
  const tagCounts = new Map<string, number>();
  meetings.forEach((meeting) => {
    extractMeetingTags(meeting).forEach((tag) => {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    });
  });
  return tagCounts;
}

// Caps how many edges get drawn: without this, a tag shared by many meetings would draw every pair
// (O(n^2)) and the mesh would turn into an unreadable hairball. Multi-pass node-degree capping
// (2 -> 4 -> 7 -> unlimited) spreads visible edges across nodes/tags instead of one hub or one tag
// dominating. Ported as-is from SNS-Reader's mesh view.
function selectBalancedMeshEdges(edges: MeshEdge[], limit: number, focusTag?: string | null) {
  const selected: MeshEdge[] = [];
  const selectedKeys = new Set<string>();
  const nodeVisualCounts = new Map<string, number>();
  const tagVisualCounts = new Map<string, number>();
  const tagLimit = focusTag ? limit : Math.max(18, Math.ceil(limit / 10));
  const nodeCaps = [2, 4, 7, Number.POSITIVE_INFINITY];

  for (const nodeCap of nodeCaps) {
    for (const edge of edges) {
      if (selected.length >= limit) {
        return selected;
      }

      if (focusTag && !edge.sharedTags.includes(focusTag)) {
        continue;
      }

      const key = getEdgeKey(edge.from, edge.to);
      if (selectedKeys.has(key)) {
        continue;
      }

      const primaryTag = focusTag ?? edge.sharedTags[0] ?? "";
      const fromCount = nodeVisualCounts.get(edge.from) ?? 0;
      const toCount = nodeVisualCounts.get(edge.to) ?? 0;
      const currentTagCount = tagVisualCounts.get(primaryTag) ?? 0;

      if (fromCount >= nodeCap || toCount >= nodeCap || (!focusTag && currentTagCount >= tagLimit)) {
        continue;
      }

      selected.push(edge);
      selectedKeys.add(key);
      nodeVisualCounts.set(edge.from, fromCount + 1);
      nodeVisualCounts.set(edge.to, toCount + 1);
      tagVisualCounts.set(primaryTag, currentTagCount + 1);
    }
  }

  return selected;
}

interface MeshViewProps {
  meetings: Meeting[];
  onOpen: (meeting: Meeting) => void;
}

export function MeshView({ meetings, onOpen }: MeshViewProps) {
  const meshSvgRef = useRef<SVGSVGElement | null>(null);
  const [meshViewport, setMeshViewport] = useState({ centerX: 500, centerY: 500, zoom: 1 });
  const [meshDragStart, setMeshDragStart] = useState<{
    centerX: number;
    centerY: number;
    pointerX: number;
    pointerY: number;
  } | null>(null);
  const [selectedMeshTag, setSelectedMeshTag] = useState<string | null>(null);
  // Click a node -> shows this card-level preview; clicking the preview itself opens the full
  // MeetingDetailModal via onOpen (same modal Card/List view use), mirroring "click a card -> open
  // detail" elsewhere in the app.
  const [previewMeeting, setPreviewMeeting] = useState<Meeting | null>(null);

  const meshDataKey = useMemo(() => {
    const firstMeetingId = meetings[0] ? getMeetingKey(meetings[0]) : "";
    const lastMeetingId = meetings[meetings.length - 1] ? getMeetingKey(meetings[meetings.length - 1]) : "";

    return `${meetings.length}:${firstMeetingId}:${lastMeetingId}`;
  }, [meetings]);

  const mesh = useMemo(() => {
    const meetingTagMap = new Map<string, string[]>();
    const graphMeetings = meetings.map((meeting, index) => ({
      ...meeting,
      id: getMeetingKey(meeting, String(index))
    }));
    const tagCounts = getTagCounts(graphMeetings);

    graphMeetings.forEach((meeting) => {
      const tags = extractMeetingTags(meeting);

      if (tags.length === 0) {
        return;
      }

      meetingTagMap.set(meeting.id, tags);
    });

    const topTags = Array.from(tagCounts.entries())
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, meshTopTagLimit);
    const tagNames = new Set(topTags.map(([tag]) => tag));
    const meetingPositions = new Map<string, { x: number; y: number }>();
    const meetingDegrees = new Map<string, number>();
    const edgeWeights = new Map<string, MeshEdge>();
    const meetingsByVisibleTag = new Map<string, string[]>();
    const centerX = 500;
    const centerY = 500;

    graphMeetings.forEach((meeting) => {
      (meetingTagMap.get(meeting.id) ?? [])
        .filter((tag) => tagNames.has(tag))
        .forEach((tag) => {
          meetingsByVisibleTag.set(tag, [...(meetingsByVisibleTag.get(tag) ?? []), meeting.id]);
        });
    });

    meetingsByVisibleTag.forEach((meetingIds, tag) => {
      for (let leftIndex = 0; leftIndex < meetingIds.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < meetingIds.length; rightIndex += 1) {
          const from = meetingIds[leftIndex];
          const to = meetingIds[rightIndex];
          const key = getEdgeKey(from, to);
          const existingEdge = edgeWeights.get(key);

          if (existingEdge) {
            existingEdge.sharedTags.push(tag);
            existingEdge.weight += 1;
          } else {
            edgeWeights.set(key, { from, to, sharedTags: [tag], weight: 1 });
          }

          meetingDegrees.set(from, (meetingDegrees.get(from) ?? 0) + 1);
          meetingDegrees.set(to, (meetingDegrees.get(to) ?? 0) + 1);
        }
      }
    });

    const sortedEdges = Array.from(edgeWeights.values()).sort(
      (left, right) => right.weight - left.weight || (meetingDegrees.get(right.from) ?? 0) - (meetingDegrees.get(left.from) ?? 0)
    );
    const visibleEdges = selectBalancedMeshEdges(sortedEdges, meshVisibleEdgeLimit);
    const highlightedEdges = selectedMeshTag ? selectBalancedMeshEdges(sortedEdges, meshVisibleEdgeLimit, selectedMeshTag) : [];
    const highlightedEdgeKeys = new Set(highlightedEdges.map((edge) => getEdgeKey(edge.from, edge.to)));
    const backgroundEdges = visibleEdges.filter((edge) => !highlightedEdgeKeys.has(getEdgeKey(edge.from, edge.to)));
    const maxDegree = Math.max(1, ...Array.from(meetingDegrees.values()));

    const layoutMeetings = [...graphMeetings].sort((left, right) => {
      const degreeDelta = (meetingDegrees.get(right.id) ?? 0) - (meetingDegrees.get(left.id) ?? 0);

      return degreeDelta || String(left.date).localeCompare(String(right.date)) || left.id.localeCompare(right.id);
    });
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));

    layoutMeetings.forEach((meeting, index) => {
      const degree = meetingDegrees.get(meeting.id) ?? 0;
      const degreeRatio = Math.sqrt(degree / maxDegree);
      const baseRadius = Math.sqrt((index + 0.5) / Math.max(1, layoutMeetings.length));
      const radialJitter = (hashToUnit(meeting.id, 31) - 0.5) * 0.08;
      const radial = clampNumber(baseRadius * (1 - degreeRatio * 0.22) + radialJitter, 0.06, 0.98);
      const angle = index * goldenAngle + hashToUnit(meeting.id + String(meeting.date), 17) * 0.42;
      const jitterX = (hashToUnit(String(meeting.title || "") + meeting.id, 47) - 0.5) * 18;
      const jitterY = (hashToUnit(meeting.id + String(meeting.organizer || ""), 59) - 0.5) * 18;

      meetingPositions.set(meeting.id, {
        x: clampNumber(centerX + Math.cos(angle) * 438 * radial + jitterX, 48, 952),
        y: clampNumber(centerY + Math.sin(angle) * 438 * radial + jitterY, 48, 952)
      });
    });

    return { backgroundEdges, graphMeetings, highlightedEdges, maxDegree, meetingDegrees, meetingPositions, topTags, visibleEdges };
  }, [meetings, selectedMeshTag]);

  const meshViewSize = meshCanvasSize / meshViewport.zoom;
  const meshViewBoxX = clampNumber(meshViewport.centerX - meshViewSize / 2, -meshPanMargin, meshCanvasSize - meshViewSize + meshPanMargin);
  const meshViewBoxY = clampNumber(meshViewport.centerY - meshViewSize / 2, -meshPanMargin, meshCanvasSize - meshViewSize + meshPanMargin);
  const meshViewBox = `${meshViewBoxX} ${meshViewBoxY} ${meshViewSize} ${meshViewSize}`;

  const clampMeshViewport = (centerX: number, centerY: number, zoom: number) => {
    const nextSize = meshCanvasSize / zoom;
    const minCenter = nextSize / 2 - meshPanMargin;
    const maxCenter = meshCanvasSize - nextSize / 2 + meshPanMargin;

    return {
      centerX: clampNumber(centerX, minCenter, maxCenter),
      centerY: clampNumber(centerY, minCenter, maxCenter),
      zoom
    };
  };

  // Filtering elsewhere resets pan/zoom/tag-highlight instead of trying to preserve camera state
  // across a dataset that may have completely reshuffled (layout order depends on node degree,
  // which changes whenever the visible meeting set changes) - same behavior as SNS-Reader.
  useEffect(() => {
    setMeshViewport({ centerX: 500, centerY: 500, zoom: 1 });
    setMeshDragStart(null);
    setSelectedMeshTag(null);
    setPreviewMeeting(null);
  }, [meshDataKey]);

  return (
    <>
      <div className="view-header">
        <div>
          <p className="eyebrow">Mesh</p>
          <h1>Mesh 보기</h1>
        </div>
        <div className="view-header-actions">
          <span className="mesh-summary">
            {mesh.graphMeetings.length}개 회의록 / {mesh.visibleEdges.length}개 연결
            {selectedMeshTag ? ` / ${selectedMeshTag} ${mesh.highlightedEdges.length}개 highlight` : ""}
          </span>
        </div>
      </div>

      <div className="mesh-layout">
        <div className="mesh-canvas-panel">
          {mesh.graphMeetings.length === 0 ? (
            <div className="empty-state mesh-empty-state">
              <GitBranch size={28} />
              <strong>연결할 회의록이 없습니다.</strong>
              <span>검색어나 필터 조건을 확인해 주세요.</span>
            </div>
          ) : (
            <>
              <svg
              aria-label="TAG 기반 회의록 연결망"
              className={meshDragStart ? "mesh-svg dragging" : "mesh-svg"}
              onClick={() => setPreviewMeeting(null)}
              onPointerCancel={() => setMeshDragStart(null)}
              onPointerDown={(event) => {
                if (event.button !== 0) {
                  return;
                }

                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                setMeshDragStart({
                  centerX: meshViewport.centerX,
                  centerY: meshViewport.centerY,
                  pointerX: event.clientX,
                  pointerY: event.clientY
                });
              }}
              onPointerMove={(event) => {
                if (!meshDragStart || !meshSvgRef.current) {
                  return;
                }

                const bounds = meshSvgRef.current.getBoundingClientRect();
                const nextSize = meshCanvasSize / meshViewport.zoom;
                const deltaX = ((event.clientX - meshDragStart.pointerX) / bounds.width) * nextSize;
                const deltaY = ((event.clientY - meshDragStart.pointerY) / bounds.height) * nextSize;

                setMeshViewport(clampMeshViewport(meshDragStart.centerX - deltaX, meshDragStart.centerY - deltaY, meshViewport.zoom));
              }}
              onPointerUp={(event) => {
                if (meshDragStart) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }

                setMeshDragStart(null);
              }}
              onWheel={(event) => {
                if (!meshSvgRef.current) {
                  return;
                }

                event.preventDefault();
                const bounds = meshSvgRef.current.getBoundingClientRect();
                const relativeX = clampNumber((event.clientX - bounds.left) / bounds.width, 0, 1);
                const relativeY = clampNumber((event.clientY - bounds.top) / bounds.height, 0, 1);

                setMeshViewport((current) => {
                  const currentSize = meshCanvasSize / current.zoom;
                  const currentX = current.centerX - currentSize / 2;
                  const currentY = current.centerY - currentSize / 2;
                  const cursorX = currentX + relativeX * currentSize;
                  const cursorY = currentY + relativeY * currentSize;
                  const nextZoom = clampNumber(current.zoom * (event.deltaY < 0 ? 1.18 : 1 / 1.18), 1, 12);
                  const nextSize = meshCanvasSize / nextZoom;
                  const nextCenterX = cursorX - relativeX * nextSize + nextSize / 2;
                  const nextCenterY = cursorY - relativeY * nextSize + nextSize / 2;

                  return clampMeshViewport(nextCenterX, nextCenterY, nextZoom);
                });
              }}
              ref={meshSvgRef}
              role="img"
              viewBox={meshViewBox}
            >
              {mesh.backgroundEdges.map((edge) => {
                const from = mesh.meetingPositions.get(edge.from);
                const to = mesh.meetingPositions.get(edge.to);

                if (!from || !to) {
                  return null;
                }

                return (
                  <line
                    className={selectedMeshTag ? "mesh-edge muted" : "mesh-edge"}
                    key={edge.from + "-" + edge.to}
                    style={{ "--edge-weight": Math.min(4, edge.weight) } as CSSProperties}
                    x1={from.x}
                    x2={to.x}
                    y1={from.y}
                    y2={to.y}
                  >
                    <title>{edge.sharedTags.join(", ")}</title>
                  </line>
                );
              })}
              {mesh.highlightedEdges.map((edge) => {
                const from = mesh.meetingPositions.get(edge.from);
                const to = mesh.meetingPositions.get(edge.to);

                if (!from || !to) {
                  return null;
                }

                return (
                  <line
                    className="mesh-edge highlighted"
                    key={`highlight-${edge.from}-${edge.to}`}
                    style={{ "--edge-weight": Math.min(4, edge.weight) } as CSSProperties}
                    x1={from.x}
                    x2={to.x}
                    y1={from.y}
                    y2={to.y}
                  >
                    <title>{edge.sharedTags.join(", ")}</title>
                  </line>
                );
              })}
              {mesh.graphMeetings.map((meeting) => {
                const position = mesh.meetingPositions.get(meeting.id);

                if (!position) {
                  return null;
                }

                const status = computeMeetingStatus(meeting);
                const radius = 1.8 + Math.sqrt((mesh.meetingDegrees.get(meeting.id) ?? 0) / mesh.maxDegree) * 3.4;

                return (
                  <g
                    className={`mesh-post-node status-${status}`}
                    key={meeting.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      setPreviewMeeting(meeting);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <circle
                      cx={position.x}
                      cy={position.y}
                      r={Math.max(radius + 8, 12)}
                      style={{ fill: "none", pointerEvents: "all" }}
                    />
                    <circle cx={position.x} cy={position.y} r={radius} />
                    <text className="mesh-post-label" textAnchor="middle" x={position.x} y={position.y + radius + 12}>
                      {truncateMeshTitle(meeting.title)}
                    </text>
                    <title>
                      {(meeting.title || "제목 없음") + "\n" + (meeting.date || "-") + "\n연결: " + (mesh.meetingDegrees.get(meeting.id) ?? 0)}
                    </title>
                  </g>
                );
              })}
            </svg>

            {previewMeeting && (
              <div className="mesh-node-preview">
                <button className="mesh-node-preview-close" onClick={() => setPreviewMeeting(null)} title="닫기" type="button">
                  <X size={14} />
                </button>
                <button
                  className="mesh-node-preview-card"
                  onClick={() => {
                    onOpen(previewMeeting);
                    setPreviewMeeting(null);
                  }}
                  type="button"
                >
                  <div className="mesh-node-preview-title">
                    <strong>{previewMeeting.title || "제목 없음"}</strong>
                    <span>{previewMeeting.date || "날짜 미정"}</span>
                  </div>
                  <div className="mesh-node-preview-meta">
                    <span>
                      <Calendar size={13} />
                      {previewMeeting.date || "날짜 미정"} {meshFormatTimeRange(previewMeeting.startTime, previewMeeting.endTime)}
                    </span>
                    <span>
                      <Users size={13} />
                      {attendeeSummary(previewMeeting.attendees) || "참석자 미정"}
                    </span>
                  </div>
                  <p className="mesh-node-preview-summary">{meshSummaryPreview(previewMeeting.minutes)}</p>
                  <span className={`status-badge ${computeMeetingStatus(previewMeeting)}`}>
                    {meetingStatusLabels[computeMeetingStatus(previewMeeting)]}
                  </span>
                  <span className="mesh-node-preview-hint">클릭하면 전체 회의록을 볼 수 있습니다</span>
                </button>
              </div>
            )}
            </>
          )}
        </div>

        <aside className="mesh-side-panel">
          <h2>Top TAG</h2>
          {mesh.topTags.length === 0 ? (
            <span className="field-hint">아직 TAG가 없습니다. 회의록을 작성하면 자동으로 생성됩니다.</span>
          ) : (
            <div className="mesh-tag-list">
              {mesh.topTags.map(([tag, count]) => (
                <button
                  className={selectedMeshTag === tag ? "mesh-tag-item active" : "mesh-tag-item"}
                  key={tag}
                  onClick={() => setSelectedMeshTag((current) => (current === tag ? null : tag))}
                  title={`${tag} TAG 연결선만 보기`}
                  type="button"
                >
                  <span>{tag}</span>
                  <strong>{count}</strong>
                </button>
              ))}
            </div>
          )}
        </aside>
      </div>
    </>
  );
}
