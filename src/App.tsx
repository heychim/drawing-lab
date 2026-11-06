import { useEffect, useMemo, useRef, useState } from "react";
import { DrawingCanvas } from "./components/DrawingCanvas.js";
import { PixelIcon, type PixelIconName } from "./components/PixelIcon.js";
import { createAgentContext } from "./domain/agentContext.js";
import { RenderCheckpointCache } from "./domain/checkpoints.js";
import { createInitialEngineState } from "./domain/engine.js";
import {
  DRAWING_FRAGMENT_PREFIX,
  buildFragmentResultUrl,
  createFragmentResult,
  decodeDrawingFragment,
} from "./domain/fragmentHandoff.js";
import {
  HOSTED_HANDOFF_CANONICAL_BYTES,
  TEMPORARY_FRAGMENT_ELIGIBILITY_THRESHOLD_CHARS,
} from "./domain/hostedPolicy.js";
import { HttpRelayClient } from "./domain/relayClient.js";
import {
  createEncryptedRelayResult,
  hasRelayResultLocation,
  restoreEncryptedRelayResult,
} from "./domain/relayHandoff.js";
import { playDocument, type PlaybackFrame } from "./domain/playback.js";
import {
  createReadyPlaybackFrame,
  createStartingPlaybackFrame,
  hasReplayableLatestRange,
} from "./domain/playbackControls.js";
import { createDrawingPng, PNG_EXPORT_MIME_TYPE } from "./domain/pngExport.js";
import {
  LocalDrawingRepository,
  removeDrawingDocument,
  upsertDrawingDocument,
  type DrawingLibrary,
} from "./domain/storage.js";
import type { DrawingDocument, DrawingTool } from "./domain/types.js";
import { applyPayload } from "./domain/validation.js";
import simpleShapes from "./examples/simple-shapes.drawing.json";
import doodleLettering from "./examples/doodle-lettering.drawing.json";
import artBrushes from "./examples/art-brushes.drawing.json";
import codexDevInput from "../drawings/codex/current.drawing.json";
import "./redesign.css";

const repository = new LocalDrawingRepository();
const checkpointCache = new RenderCheckpointCache();
const relayClient = new HttpRelayClient();

const EXAMPLES = [
  { name: "小房子", payload: simpleShapes },
  { name: "花朵 + HI!", payload: doodleLettering },
  { name: "艺术笔刷", payload: artBrushes },
] as const;

const ONBOARDING_KEY = "drawing-lab:usage-guide-acknowledged";

const DEFAULT_AGENT_PAYLOAD = JSON.stringify({
  schemaVersion: "0.1",
  documentAction: "new_drawing",
  title: "Agent drawing",
  operations: [
    { type: "select_tool", tool: "pencil" },
    { type: "set_color", color: "#6B4F4F" },
    { type: "set_brush_size", brushSize: 8 },
    {
      type: "stroke",
      semanticId: "agent-mark-1",
      tool: "pencil",
      color: "#6B4F4F",
      brushSize: 8,
      points: [
        { x: 360, y: 390 },
        { x: 430, y: 320 },
        { x: 500, y: 390 },
        { x: 570, y: 320 },
        { x: 640, y: 390 },
      ],
      tValues: [0, 0.25, 0.5, 0.75, 1],
    },
  ],
}, null, 2);

const TOOL_META: Record<DrawingTool, { icon: PixelIconName; label: string }> = {
  pencil: { icon: "pencil", label: "铅笔" },
  brush: { icon: "brush", label: "画笔" },
  soft_pencil: { icon: "pencil", label: "软铅笔" },
  ink_brush: { icon: "brush", label: "毛笔" },
  graphite: { icon: "graphite", label: "石墨" },
  watercolor: { icon: "watercolor", label: "水彩" },
  wash_fill: { icon: "watercolor", label: "罩染" },
  gouache_fill: { icon: "brush", label: "水粉" },
  marker: { icon: "marker", label: "马克笔" },
  eraser: { icon: "eraser", label: "橡皮" },
};

const COLORS = [
  "#6B4F4F", "#9A6F68", "#C98595", "#D989A3", "#F08FA8", "#F5A398", "#F4B59B", "#F3B84B",
  "#F2BD4F", "#F6D06F", "#F8DA8B", "#F4DDB2", "#F2AFC2", "#E49BC4", "#D9B4E8", "#B8A1D5",
  "#B7D98C", "#6FAE78", "#76A889", "#87C7B5", "#90D1CA", "#83BBD2", "#8FAFDA", "#A6B6E3",
  "#D98A78", "#C5A0A8", "#A88EA2", "#9A8BC2", "#8585A0", "#71798D", "#53576A", "#3F4050",
];

type PreparedResult =
  | { ok: true; url: string; transport: "fragment" | "encrypted_relay" }
  | { ok: false; errors: string[]; reason: "hosted_unavailable" | "quota" | "relay" | "invalid" };

function shouldShowUsageGuide() {
  try {
    return window.localStorage.getItem(ONBOARDING_KEY) !== "1";
  } catch {
    return true;
  }
}

async function prepareResultUrl(document: DrawingDocument, baseUrl: string): Promise<PreparedResult> {
  const fragment = await createFragmentResult(document);
  if (fragment.status === "ready") {
    return {
      ok: true,
      url: buildFragmentResultUrl(fragment.fragment, baseUrl),
      transport: "fragment",
    };
  }
  if (fragment.status === "relay_required") {
    const relay = await createEncryptedRelayResult(document, relayClient, baseUrl);
    if (relay.status === "ready") {
      return { ok: true, url: relay.url, transport: "encrypted_relay" };
    }
    const quota = relay.errors.some((error) =>
      error.startsWith("quota_reached:") || error.startsWith("rate_limited:"));
    return { ok: false, errors: relay.errors, reason: quota ? "quota" : "relay" };
  }
  if (fragment.status === "hosted_unavailable") {
    return { ok: false, errors: [], reason: "hosted_unavailable" };
  }
  return { ok: false, errors: fragment.errors, reason: "invalid" };
}

function createDocumentFromPayload(payload: unknown) {
  return applyPayload(payload, undefined, {
    id: crypto.randomUUID(),
    now: new Date().toISOString(),
  });
}

function createInitialLibrary(): DrawingLibrary {
  const stored = repository.load();
  if (stored) return stored;
  const initial = createDocumentFromPayload(simpleShapes);
  if (!initial.ok) throw new Error(initial.errors.join("\n"));
  return { currentId: initial.value.id, documents: [initial.value] };
}

function finalFrame(document: DrawingDocument): PlaybackFrame {
  return createReadyPlaybackFrame(document, checkpointCache.restore(document).state);
}

function localDocumentStatus(document: DrawingDocument) {
  return document.status === "completed" ? "已完成" : "可继续编辑";
}

function pngFileName(title: string) {
  const safeTitle = title.replace(/[\\/:*?"<>|]/gu, "-").trim().slice(0, 60);
  return `${safeTitle || "Drawing-Lab-画作"}.png`;
}

export default function App() {
  const [library, setLibrary] = useState(createInitialLibrary);
  const currentDocument = useMemo(
    () => library.documents.find((document) => document.id === library.currentId) ?? null,
    [library],
  );
  const [frame, setFrame] = useState<PlaybackFrame>(() =>
    currentDocument
      ? finalFrame(currentDocument)
      : {
          engine: createInitialEngineState(),
          status: "ready",
          operationIndex: -1,
          transient: null,
          actionPulse: null,
        },
  );
  const [notice, setNotice] = useState("已从本机恢复");
  const [errors, setErrors] = useState<string[]>([]);
  const [agentModeOpen, setAgentModeOpen] = useState(false);
  const [agentPayloadText, setAgentPayloadText] = useState(DEFAULT_AGENT_PAYLOAD);
  const [agentErrors, setAgentErrors] = useState<string[]>([]);
  const [agentStatus, setAgentStatus] = useState("等待外部智能体绘画数据");
  const [resultUrl, setResultUrl] = useState("");
  const [usageGuideOpen, setUsageGuideOpen] = useState(shouldShowUsageGuide);
  const [shareBusy, setShareBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const playbackController = useRef<AbortController | null>(null);
  const fragmentRestoreAttempted = useRef(false);
  const toastTimer = useRef<number | null>(null);

  const showToast = (message: string) => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    setToast(message);
    toastTimer.current = window.setTimeout(() => {
      setToast(null);
      toastTimer.current = null;
    }, 2400);
  };

  useEffect(() => () => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
  }, []);

  useEffect(() => {
    try {
      repository.save(library);
      library.documents.forEach((document) => checkpointCache.refresh(document));
      setNotice("已保存到本机");
    } catch {
      setNotice("保存到本机失败");
    }
  }, [library]);

  useEffect(() => {
    playbackController.current?.abort();
    if (currentDocument) setFrame(finalFrame(currentDocument));
    return () => playbackController.current?.abort();
  }, [currentDocument?.id, currentDocument?.currentRevision]);

  const startPlayback = (mode: "latest" | "full", document = currentDocument) => {
    if (!document || document.operations.length === 0) return;
    if (mode === "latest" && !hasReplayableLatestRange(document)) {
      showToast("暂无最新变化可重播");
      return;
    }
    playbackController.current?.abort();
    const controller = new AbortController();
    playbackController.current = controller;
    setErrors([]);
    setFrame(createStartingPlaybackFrame(document, mode));
    void playDocument(document, mode, setFrame, controller.signal).finally(() => {
      if (playbackController.current === controller) playbackController.current = null;
    });
  };

  const skipPlayback = () => {
    const controller = playbackController.current;
    if (!currentDocument || !controller) return;
    controller.abort();
    playbackController.current = null;
    setFrame(finalFrame(currentDocument));
    showToast("已跳过动画");
  };

  const addDocument = (document: DrawingDocument, replay = true) => {
    setLibrary((current) => upsertDrawingDocument(current, document));
    setErrors([]);
    setNotice("已验证并保存到本机");
    if (replay) window.setTimeout(() => startPlayback("full", document), 0);
  };

  useEffect(() => {
    if (fragmentRestoreAttempted.current) return;
    const isFragmentResult = window.location.hash.startsWith(DRAWING_FRAGMENT_PREFIX);
    const isRelayResult = hasRelayResultLocation(window.location.href);
    if (!isFragmentResult && !isRelayResult) return;
    fragmentRestoreAttempted.current = true;
    if (isRelayResult) setNotice("正在读取加密临时结果…");
    const restored = isFragmentResult
      ? decodeDrawingFragment(window.location.hash)
      : restoreEncryptedRelayResult(window.location.href, relayClient);
    void restored.then((result) => {
      if (!result.ok) {
        setErrors(result.errors);
        const expired = result.errors.some((error) => error.startsWith("expired:"));
        setNotice(expired ? "临时结果已过期，未恢复作品" : "结果未通过验证，作品未改变");
        return;
      }
      addDocument(result.value);
      setNotice(isFragmentResult ? "已从链接恢复并保存到本机" : "已恢复临时结果并保存到本机");
    });
  }, []);

  const parseAndApplyAgentPayload = () => {
    let payload: unknown;
    try {
      payload = JSON.parse(agentPayloadText);
    } catch (error) {
      return {
        ok: false as const,
        errors: [error instanceof Error ? error.message : "绘画数据不是合法 JSON"],
      };
    }
    return applyPayload(payload, currentDocument ?? undefined, {
      id: crypto.randomUUID(),
      now: new Date().toISOString(),
    });
  };

  const validateAgentPayload = () => {
    const result = parseAndApplyAgentPayload();
    if (!result.ok) {
      setAgentErrors(result.errors);
      setAgentStatus("验证失败，当前画作未改变");
      return;
    }
    setAgentErrors([]);
    setAgentStatus(`验证通过 · ${result.value.operations.length} 条 canonical operations`);
  };

  const applyAndPlayAgentPayload = () => {
    const result = parseAndApplyAgentPayload();
    if (!result.ok) {
      setAgentErrors(result.errors);
      setAgentStatus("应用失败，当前画作未改变");
      return;
    }
    const parsed = JSON.parse(agentPayloadText) as { documentAction?: unknown };
    if (parsed.documentAction === "continue_current") {
      setLibrary((current) => upsertDrawingDocument(current, result.value));
      setErrors([]);
      setAgentErrors([]);
      setAgentStatus("已通过 canonical 边界应用，正在重播最新变化");
      setNotice("智能体续画已验证并保存到本机");
      window.setTimeout(() => startPlayback("latest", result.value), 0);
      return;
    }
    setAgentErrors([]);
    setAgentStatus("已通过 canonical 边界应用，正在重播整幅画作");
    addDocument(result.value);
  };

  const createResultUrl = () => {
    const document = currentDocument;
    if (!document) return;
    setResultUrl("");
    setAgentStatus("正在创建结果链接…");
    void prepareResultUrl(document, window.location.href).then((result) => {
      if (result.ok) {
        setResultUrl(result.url);
        setAgentErrors([]);
        setAgentStatus(result.transport === "encrypted_relay"
          ? "加密临时结果已就绪 · 默认有效 7 天"
          : "自包含结果链接已就绪");
        return;
      }
      if (result.reason === "hosted_unavailable") {
        setAgentErrors([]);
        setAgentStatus("Hosted 交付不可用 · canonical document 超过 1 MiB");
        return;
      }
      setAgentErrors(result.errors);
      setAgentStatus(result.reason === "quota"
        ? "临时结果额度已满，未创建链接"
        : result.reason === "relay"
          ? "临时结果服务不可用，未创建链接"
          : "结果创建失败");
    });
  };

  const deliverShareUrl = async (url: string, title: string) => {
    const displayTitle = `《${title}》`;
    if (typeof navigator.share === "function") {
      try {
        showToast("已打开系统分享");
        await navigator.share({ title: displayTitle, text: displayTitle, url });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          showToast("已取消分享");
          return;
        }
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      showToast(`已复制${displayTitle}的分享链接`);
    } catch {
      showToast("分享失败，请检查浏览器分享或剪贴板权限");
    }
  };

  const shareCurrent = () => {
    if (!currentDocument || currentDocument.operations.length === 0 || shareBusy) return;
    setShareBusy(true);
    setNotice("正在准备分享链接…");
    void prepareResultUrl(currentDocument, window.location.href)
      .then(async (result) => {
        if (!result.ok) {
          setNotice(result.reason === "hosted_unavailable"
            ? "当前画作超过 Hosted 分享上限"
            : result.reason === "quota"
              ? "临时结果额度已满，未创建分享"
              : "分享链接创建失败");
          return;
        }
        await deliverShareUrl(result.url, currentDocument.title);
      })
      .catch(() => setNotice("分享链接创建失败"))
      .finally(() => setShareBusy(false));
  };

  const sharePreparedResult = () => {
    if (!resultUrl || shareBusy || !currentDocument) return;
    setShareBusy(true);
    void deliverShareUrl(resultUrl, currentDocument.title).finally(() => setShareBusy(false));
  };

  const acknowledgeUsageGuide = () => {
    try {
      window.localStorage.setItem(ONBOARDING_KEY, "1");
    } catch {
      // The guide still closes for this session when local storage is unavailable.
    }
    setUsageGuideOpen(false);
  };

  const loadExample = (payload: unknown) => {
    const result = createDocumentFromPayload(payload);
    if (!result.ok) {
      setErrors(result.errors);
      setNotice("验证失败，未应用任何内容");
      return;
    }
    addDocument(result.value);
  };

  const loadCodexDevInput = () => {
    const result = applyPayload(codexDevInput, currentDocument ?? undefined, {
      id: crypto.randomUUID(),
      now: new Date().toISOString(),
    });
    if (!result.ok) {
      setErrors(result.errors);
      setNotice("Codex 输入被拒绝，未应用任何内容");
      return;
    }
    if (codexDevInput.documentAction === "continue_current") {
      setLibrary((current) => upsertDrawingDocument(current, result.value));
      setErrors([]);
      setNotice("Codex 续画已验证并保存到本机");
      window.setTimeout(() => startPlayback("latest", result.value), 0);
      return;
    }
    addDocument(result.value);
  };

  const createBlankDocument = () => {
    const result = createDocumentFromPayload({
      schemaVersion: "0.1",
      documentAction: "new_drawing",
      title: "未命名画作",
      operations: [],
    });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    addDocument(result.value, false);
  };

  const selectDocument = (id: string) => {
    setLibrary((current) => ({ ...current, currentId: id }));
    setErrors([]);
    setNotice("已从本地画作打开");
  };

  const deleteLocalDocument = (id: string) => {
    const confirmed = window.confirm(
      "删除这幅本地画作？\n\n只会删除当前浏览器保存的副本，分享链接和其他设备不受影响。",
    );
    if (!confirmed) return;

    let blankDocument: DrawingDocument | null = null;
    if (library.documents.length === 1) {
      const blank = createDocumentFromPayload({
        schemaVersion: "0.1",
        documentAction: "new_drawing",
        title: "未命名画作",
        operations: [],
      });
      if (!blank.ok) {
        showToast("删除失败，无法建立空白画作");
        return;
      }
      blankDocument = blank.value;
    }

    setLibrary((current) => {
      const next = removeDrawingDocument(current, id);
      if (next.documents.length === current.documents.length) return current;
      if (next.documents.length === 0 && blankDocument) {
        return { currentId: blankDocument.id, documents: [blankDocument] };
      }
      return next;
    });
    showToast("已删除本机画作");
  };

  const saveNow = () => {
    try {
      repository.save(library);
      setNotice("已保存到本机");
      showToast("已保存到本机");
    } catch {
      setNotice("保存到本机失败");
      showToast("保存失败，请检查浏览器本地存储权限");
    }
  };

  const exportCurrentImage = () => {
    if (!currentDocument || exportBusy) return;
    setExportBusy(true);
    void createDrawingPng(currentDocument)
      .then(async (blob) => {
        const file = new File([blob], pngFileName(currentDocument.title), {
          type: PNG_EXPORT_MIME_TYPE,
        });
        let canShareFile = false;
        try {
          canShareFile = typeof navigator.share === "function" &&
            typeof navigator.canShare === "function" &&
            navigator.canShare({ files: [file] });
        } catch {
          canShareFile = false;
        }
        if (canShareFile) {
          try {
            showToast("已打开图片保存/分享");
            await navigator.share({ title: `《${currentDocument.title}》`, files: [file] });
            return;
          } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") {
              showToast("已取消图片导出");
              return;
            }
          }
        }

        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = objectUrl;
        link.download = file.name;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
        showToast("PNG 已生成");
      })
      .catch(() => showToast("PNG 导出失败"))
      .finally(() => setExportBusy(false));
  };

  const agentContextText = useMemo(
    () => agentModeOpen && currentDocument ? JSON.stringify(createAgentContext(currentDocument), null, 2) : "",
    [agentModeOpen, currentDocument],
  );

  if (!currentDocument) return null;

  const displayedOperation = frame.operationIndex + 1;
  const tool = frame.engine.tool;
  const canUndo = frame.engine.drawables.some((entry) => entry.active);
  const canRedo = frame.engine.redoStack.length > 0;
  const isPlaying = frame.status === "playing";
  const hasLatestChanges = hasReplayableLatestRange(currentDocument);
  const hasDrawingContent = currentDocument.operations.length > 0;
  const sizePreviews = [3, 8, 13, 20, 28];
  const selectedSizePreview = sizePreviews.reduce((closest, size) =>
    Math.abs(size - frame.engine.brushSize) < Math.abs(closest - frame.engine.brushSize)
      ? size
      : closest,
  );

  return (
    <main className="desktop-shell">
      <header className="title-bar">
        <div className="brand-mark" aria-hidden="true"><PixelIcon name="app" /></div>
        <div className="window-title">
          <strong>Drawing Lab</strong>
          <span className="title-separator" aria-hidden="true"><i /><i /><i /></span>
          <span className="drawing-name">{currentDocument.title}</span>
        </div>
        <div className="title-sparkles" aria-hidden="true"><i /><i /><i /></div>
        <button
          type="button"
          className="usage-guide-toggle"
          onClick={() => setUsageGuideOpen(true)}
          aria-label="使用说明"
          title="使用说明"
        >
          <span aria-hidden="true"><PixelIcon name="help" /></span>
          <small>使用说明</small>
        </button>
        <button
          type="button"
          className={`agent-mode-toggle ${agentModeOpen ? "is-active" : ""}`}
          onClick={() => setAgentModeOpen((open) => !open)}
          aria-expanded={agentModeOpen}
        >
          智能体模式
        </button>
        <div className="title-gems" aria-hidden="true"><i /><i /><i /></div>
      </header>

      <section className="top-tools" aria-label="回放工具状态">
        <span className="tool-state-caption">回放工具状态</span>
        <div className="tool-state-group">
          {([tool === "soft_pencil" ? tool : "pencil", tool === "ink_brush" ? tool : "brush",
            "graphite", tool === "wash_fill" || tool === "gouache_fill" ? tool : "watercolor", "marker", "eraser"] as DrawingTool[]).map((toolName) => (
            <div
              key={toolName}
              className={`tool-tile ${tool === toolName ? "is-active" : ""}`}
              aria-current={tool === toolName ? "true" : undefined}
              aria-label={`${TOOL_META[toolName].label} · ${tool === toolName ? "当前回放工具" : "未使用"}`}
              title="随真实 operations 回放同步，不是自由绘画按钮"
            >
              <span className="tool-icon-wrap" aria-hidden="true">
                <PixelIcon name={TOOL_META[toolName].icon} />
              </span>
              <small>{TOOL_META[toolName].label}</small>
            </div>
          ))}
        </div>
        <div className="brush-readout">
          <span className="readout-label">当前颜色 / 粗细</span>
          <i className="current-color-dot" style={{ background: frame.engine.color }} aria-hidden="true" />
          <strong>{frame.engine.brushSize}</strong>
          <span className="stroke-preview-track">
            <span className="stroke-preview" style={{ height: `${Math.min(18, frame.engine.brushSize)}px` }} />
          </span>
        </div>
        <div className="history-state" aria-label="撤销和重做的回放执行状态">
          <div
            className={`${canUndo ? "is-available" : ""} ${frame.actionPulse === "undo" ? "is-pulsing" : ""}`}
            title={canUndo ? "当前画作包含可撤销笔画；状态随回放同步" : "暂无可撤销操作"}
          >
            <span className="history-icon-wrap"><PixelIcon name="undo" /></span><small>撤销</small>
          </div>
          <div
            className={`${canRedo ? "is-available" : ""} ${frame.actionPulse === "redo" ? "is-pulsing" : ""}`}
            title={canRedo ? "当前画作包含待重做笔画；状态随回放同步" : "暂无可重做操作"}
          >
            <span className="history-icon-wrap"><PixelIcon name="redo" /></span><small>重做</small>
          </div>
        </div>
        <div className="playback-controls">
          <div className={`playback-badge ${frame.status}`}><i />{isPlaying ? "回放中" : "就绪"}</div>
          {isPlaying && (
            <button type="button" className="skip-playback" onClick={skipPlayback}>
              跳过动画
            </button>
          )}
        </div>
      </section>

      <section className="workspace">
        <nav className="side-tools" aria-label="作品操作">
          <button type="button" onClick={createBlankDocument} title="新建空白画作">
            <span aria-hidden="true"><PixelIcon name="new" /></span><small>新建</small>
          </button>
          <button
            type="button"
            onClick={() => startPlayback("latest")}
            disabled={isPlaying || !hasLatestChanges}
            title={isPlaying ? "正在回放" : hasLatestChanges ? "重新执行最新一批 operations" : "暂无最新变化可重播"}
          >
            <span aria-hidden="true"><PixelIcon name="latest" /></span><small>重播最新变化</small>
          </button>
          <button
            type="button"
            onClick={() => startPlayback("full")}
            disabled={isPlaying || !hasDrawingContent}
            title={isPlaying ? "正在回放" : hasDrawingContent ? "按顺序重新执行全部 operations" : "当前没有可重播内容"}
          >
            <span aria-hidden="true"><PixelIcon name="full" /></span><small>重播整幅</small>
          </button>
          <button type="button" onClick={saveNow} title="保存到当前浏览器 / 当前设备">
            <span aria-hidden="true"><PixelIcon name="save" /></span><small>保存到本地</small>
          </button>
          <button
            type="button"
            onClick={exportCurrentImage}
            disabled={exportBusy}
            title={exportBusy ? "正在生成 PNG" : "导出当前画作的 4:3 PNG 图片"}
          >
            <span aria-hidden="true"><PixelIcon name="export" /></span><small>{exportBusy ? "生成中" : "导出图片"}</small>
          </button>
          <button
            type="button"
            onClick={shareCurrent}
            disabled={shareBusy || !hasDrawingContent}
            title={shareBusy ? "正在准备分享链接" : hasDrawingContent ? "分享当前画作" : "当前没有可分享内容"}
          >
            <span aria-hidden="true"><PixelIcon name="share" /></span><small>{shareBusy ? "准备中" : "分享"}</small>
          </button>
          <div className="rail-decor" aria-hidden="true">
            <span><PixelIcon name="heart" /></span>
            <span><PixelIcon name="sparkle" /></span>
          </div>
        </nav>

        <div className="canvas-zone">
          <div className="canvas-mat">
            <DrawingCanvas
              background={currentDocument.canvas.background}
              engine={frame.engine}
              transient={frame.transient}
            />
          </div>
          {errors.length > 0 && (
            <div className="validation-panel" role="alert">
              <strong>验证失败，没有应用任何 operation。</strong>
              <ul>{errors.map((error) => <li key={error}>{error}</li>)}</ul>
            </div>
          )}
        </div>

        <aside className="right-panel">
          <section className="panel-card">
            <h2><span>颜色</span><i className="panel-charm" aria-hidden="true"><PixelIcon name="sparkle" /></i></h2>
            <div className="swatch-grid" aria-label={`当前颜色 ${frame.engine.color}`}>
              {COLORS.map((color) => (
                <span
                  key={color}
                  className={frame.engine.color === color ? "is-selected" : ""}
                  style={{ background: color }}
                  title={color}
                />
              ))}
            </div>
            <div className="color-value">
              <i style={{ background: frame.engine.color }} />
              <code>{frame.engine.color}</code>
            </div>
          </section>

          <section className="panel-card">
            <h2><span>画笔粗细</span><i className="panel-charm" aria-hidden="true"><PixelIcon name="paw" /></i></h2>
            <div className="size-dots" aria-label={`当前画笔粗细 ${frame.engine.brushSize}`}>
              {sizePreviews.map((size) => (
                <span key={size} className={selectedSizePreview === size ? "is-selected" : ""}>
                  <i style={{ width: `${Math.max(5, size)}px`, height: `${Math.max(5, size)}px` }} />
                </span>
              ))}
            </div>
            <div className="size-value">{frame.engine.brushSize} px</div>
          </section>

          <details className="studio-drawer">
            <summary>
              <span>画作抽屉</span>
              <small>示例与本地画作</small>
            </summary>
            <div className="studio-drawer-body">
          <section className="panel-card examples-card">
            <h2><span>示例画作</span><i className="panel-charm" aria-hidden="true"><PixelIcon name="heart" /></i></h2>
            <button type="button" onClick={loadCodexDevInput}>Codex 示例</button>
            {EXAMPLES.map((example) => (
              <button key={example.name} type="button" onClick={() => loadExample(example.payload)}>
                {example.name}
              </button>
            ))}
          </section>

          <section className="panel-card library-card">
            <h2><span>本地画作</span><i className="panel-charm" aria-hidden="true"><PixelIcon name="save" /></i></h2>
            <div className="local-drawing-list" aria-label="本地画作列表">
              {library.documents.map((document) => (
                <div
                  key={document.id}
                  className={`local-drawing-item ${document.id === library.currentId ? "is-current" : ""}`}
                >
                  <button
                    type="button"
                    className="local-drawing-open"
                    onClick={() => selectDocument(document.id)}
                    aria-current={document.id === library.currentId ? "true" : undefined}
                  >
                    <strong>{document.title}</strong>
                    <small>{localDocumentStatus(document)}</small>
                  </button>
                  <button
                    type="button"
                    className="local-drawing-delete"
                    onClick={() => deleteLocalDocument(document.id)}
                    aria-label={`删除本地画作《${document.title}》`}
                    title="只删除当前浏览器保存的副本"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </section>
            </div>
          </details>
        </aside>

        {agentModeOpen && (
          <section className="agent-mode-panel" data-testid="agent-mode-panel" aria-label="智能体模式">
            <header>
              <div>
                <small>外部绘画入口</small>
                <h2>智能体模式</h2>
              </div>
              <button type="button" onClick={() => setAgentModeOpen(false)} aria-label="关闭智能体模式">×</button>
            </header>
            <div className="agent-mode-grid">
              <section className="agent-payload-pane">
                <label htmlFor="agent-payload">绘画数据 Drawing Payload</label>
                <textarea
                  id="agent-payload"
                  data-testid="agent-payload"
                  value={agentPayloadText}
                  onChange={(event) => setAgentPayloadText(event.target.value)}
                  spellCheck={false}
                />
                <div className="agent-actions">
                  <button type="button" onClick={validateAgentPayload}>验证</button>
                  <button type="button" onClick={applyAndPlayAgentPayload}>应用并播放</button>
                  <button type="button" onClick={createResultUrl}>创建结果链接</button>
                </div>
                <p className="agent-status" data-testid="agent-status" aria-live="polite">{agentStatus}</p>
                {agentErrors.length > 0 && (
                  <ul className="agent-errors" role="alert">
                    {agentErrors.map((error) => <li key={error}>{error}</li>)}
                  </ul>
                )}
                {resultUrl && (
                  <div className="result-ready-card" data-testid="result-url" data-result-ready="true">
                    <span>《{currentDocument.title}》</span>
                    <button type="button" onClick={sharePreparedResult} disabled={shareBusy}>
                      {shareBusy ? "准备中" : "分享结果"}
                    </button>
                  </div>
                )}
              </section>
              <section className="agent-context-pane">
                <h3>智能体上下文 Agent Context</h3>
                <pre data-testid="agent-context">{agentContextText}</pre>
                <p>
                  Core：2 MiB · Hosted：{HOSTED_HANDOFF_CANONICAL_BYTES / 1024 / 1024} MiB<br />
                  Fragment 临时阈值：{TEMPORARY_FRAGMENT_ELIGIBILITY_THRESHOLD_CHARS} chars<br />
                  <em>临时值，等待真实手机聊天链路验证</em>
                </p>
              </section>
            </div>
          </section>
        )}
      </section>

      <footer className="status-bar">
        <span className="status-heart" aria-hidden="true"><PixelIcon name="heart" /></span>
        <span className={`status-light ${frame.status}`} />
        <strong>{isPlaying ? "正在执行真实 operations" : "就绪"}</strong>
        <span>1000 × 750 逻辑画布</span>
        <span>4:3 画布</span>
        <span>操作 {Math.max(0, displayedOperation)} / {currentDocument.operations.length}</span>
        <span className="save-status" aria-live="polite">{notice}</span>
      </footer>

      {toast && <div className="action-toast" role="status" aria-live="polite">{toast}</div>}

      {usageGuideOpen && (
        <div className="usage-guide-backdrop" role="presentation">
          <section
            className="usage-guide-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="usage-guide-title"
            data-testid="usage-guide"
          >
            <header>
              <span aria-hidden="true"><PixelIcon name="help" /></span>
              <div>
                <small>第一次来这里？</small>
                <h2 id="usage-guide-title">使用说明</h2>
              </div>
            </header>
            <div className="usage-guide-body">
              <p><strong>分享链接</strong> “分享”会发送可打开并重播的结果；AI 创建的加密临时结果默认有效 7 天。</p>
              <p><strong>保存与导出</strong> “保存到本地”保留可重播 / 编辑的 Drawing Lab 画作；“导出图片”只生成普通 PNG。</p>
              <p><strong>数据清理</strong> 清除本站点数据或本地存储、删除浏览器配置等操作，可能删除本地画作。</p>
              <p><strong>重播</strong> 会重新执行真实 drawing operations，不是 GIF 或视频。</p>
            </div>
            <button type="button" onClick={acknowledgeUsageGuide}>知道了</button>
          </section>
        </div>
      )}
    </main>
  );
}
