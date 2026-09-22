import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AudioEngine } from './audio/AudioEngine';
import { DEFAULT_FADE, type FadeSettings } from './audio/fade';
import {
  LOUDNESS_WINDOW_SEC,
  computeDbfsWindows,
  evaluateAllChapters,
  findLoudnessSegments,
  type LoudnessThresholds,
} from './audio/loudness';
import { computePeaks } from './audio/peaks';
import {
  RMS_WINDOW_SEC,
  computeRmsWindows,
  findSilenceSegments,
  splitGapsAtBoundaries,
  suggestSplitBoundaries,
} from './audio/silence';
import { Waveform } from './components/Waveform';
import { ChapterList } from './components/ChapterList';
import { ChainBar } from './components/ChainBar';
import { FadePanel } from './components/FadePanel';
import { LoudnessPanel } from './components/LoudnessPanel';
import { SilencePanel } from './components/SilencePanel';
import { TransportBar } from './components/TransportBar';
import { useChapters } from './hooks/useChapters';
import type { Chapter, Peaks } from './types';
import { chainOutcomeText, type ChainOutcome } from './utils/chapterOps';
import { downloadFile, toJSON, toWebVTT } from './utils/export';
import { formatTime } from './utils/time';

const NUDGE_FINE = 0.05;
const NUDGE_COARSE = 1;

export default function App() {
  const engineRef = useRef<AudioEngine | null>(null);
  if (!engineRef.current) engineRef.current = new AudioEngine();
  const engine = engineRef.current;

  const [fileName, setFileName] = useState<string | null>(null);
  const [peaks, setPeaks] = useState<Peaks | null>(null);
  const [duration, setDuration] = useState(0);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [pxPerSec, setPxPerSec] = useState(50);
  const [follow, setFollow] = useState(true);
  const [decoding, setDecoding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // silence-split suggestions
  const [rmsWindows, setRmsWindows] = useState<Float32Array | null>(null);
  const [silenceThresholdDb, setSilenceThresholdDb] = useState(-40);
  const [minSilenceSec, setMinSilenceSec] = useState(0.5);
  const [showSuggestions, setShowSuggestions] = useState(true);

  // chapter loudness QC (200ms dBFS windows computed once at import)
  const [dbfsWindows, setDbfsWindows] = useState<Float32Array | null>(null);
  const [loudnessThresholds, setLoudnessThresholds] = useState<LoudnessThresholds>({
    quietDb: -30,
    loudDb: -6,
  });
  const [showLoudness, setShowLoudness] = useState(true);

  // per-chapter fade preview settings — UI-only state, keyed by chapter id;
  // never part of chapter data or exports
  const [fades, setFades] = useState<Record<string, FadeSettings>>({});
  /** what the current playback is: a chapter preview started at `from` */
  const previewRef = useRef<{ chapterId: string; from: number } | null>(null);

  const chaptersApi = useChapters(duration);
  const { chapters, selected, selectedId, reset: resetChapters } = chaptersApi;

  // chain-move live preview + transient feasibility notice
  const [liveChain, setLiveChain] = useState<ChainOutcome | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2600);
  }, []);
  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  /** consume a chain gesture outcome: clamped/rejected gestures are explained */
  const handleChainOutcome = useCallback(
    (o: ChainOutcome | null) => {
      if (o && (!o.allowed || o.clamped)) showNotice(chainOutcomeText(o, chaptersApi.chapters));
    },
    [showNotice, chaptersApi],
  );

  // drop fade settings of removed chapters (and of the previous file)
  useEffect(() => {
    setFades((prev) => {
      const ids = new Set(chapters.map((c) => c.id));
      const entries = Object.entries(prev).filter(([id]) => ids.has(id));
      return entries.length === Object.keys(prev).length ? prev : Object.fromEntries(entries);
    });
  }, [chapters]);

  // recompute candidates whenever params or chapters change
  const suggestions = useMemo(() => {
    if (!rmsWindows || duration <= 0) return [];
    const thresholdLinear = Math.pow(10, silenceThresholdDb / 20);
    const segments = findSilenceSegments(
      rmsWindows,
      RMS_WINDOW_SEC,
      thresholdLinear,
      minSilenceSec,
      duration,
    );
    return suggestSplitBoundaries(segments, chapters, duration);
  }, [rmsWindows, silenceThresholdDb, minSilenceSec, chapters, duration]);

  const applyAllSuggestions = useCallback(() => {
    const ranges = splitGapsAtBoundaries(chapters, suggestions, duration);
    chaptersApi.addMany(ranges);
  }, [chapters, suggestions, duration, chaptersApi]);

  // Loudness QC: thresholds/chapters only re-run the classification over the
  // cached 200ms dBFS windows — the decoded PCM is never scanned again.
  const chapterLoudness = useMemo(() => {
    if (!dbfsWindows) return null;
    return evaluateAllChapters(
      chapters,
      dbfsWindows,
      LOUDNESS_WINDOW_SEC,
      duration,
      loudnessThresholds,
    );
  }, [dbfsWindows, chapters, duration, loudnessThresholds]);

  const loudnessSegments = useMemo(() => {
    if (!dbfsWindows || !showLoudness) return [];
    return findLoudnessSegments(dbfsWindows, LOUDNESS_WINDOW_SEC, duration, loudnessThresholds);
  }, [dbfsWindows, showLoudness, duration, loudnessThresholds]);

  const changeQuietThreshold = useCallback((v: number) => {
    setLoudnessThresholds((t) => ({ ...t, quietDb: Math.min(v, t.loudDb - 1) }));
  }, []);
  const changeLoudThreshold = useCallback((v: number) => {
    setLoudnessThresholds((t) => ({ ...t, loudDb: Math.max(v, t.quietDb + 1) }));
  }, []);

  // playback clock
  useEffect(() => {
    engine.onEnded = () => {
      previewRef.current = null;
      setPlaying(false);
    };
    let raf = 0;
    const tick = () => {
      if (engine.playing) {
        setPlayhead(engine.getTime());
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engine]);

  useEffect(() => () => engine.dispose(), [engine]);

  const loadFile = useCallback(
    async (file: File) => {
      setError(null);
      setDecoding(true);
      try {
        const buffer = await engine.decode(file);
        resetChapters();
        previewRef.current = null;
        setPeaks(computePeaks(buffer));
        // reuse the decoded buffer for silence analysis (no re-decode)
        setRmsWindows(computeRmsWindows(buffer));
        // reuse the same decoded PCM once more for 200ms loudness windows
        setDbfsWindows(computeDbfsWindows(buffer));
        setDuration(buffer.duration);
        setFileName(file.name);
        setPlayhead(0);
        setPlaying(false);
      } catch {
        setError('无法解码该音频文件，请换用常见格式（MP3 / WAV / M4A / OGG）。');
      } finally {
        setDecoding(false);
      }
    },
    [engine, resetChapters],
  );

  const onFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void loadFile(f);
    e.target.value = '';
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) void loadFile(f);
  };

  const seek = useCallback(
    (t: number) => {
      const wasPlaying = engine.playing;
      engine.stop();
      previewRef.current = null;
      setPlayhead(t);
      if (wasPlaying) {
        engine.play(t);
        setPlaying(true);
      } else {
        setPlaying(false);
      }
    },
    [engine],
  );

  const togglePlay = useCallback(() => {
    if (!engine.hasBuffer) return;
    previewRef.current = null;
    if (engine.playing) {
      const t = engine.pause();
      setPlayhead(t);
      setPlaying(false);
    } else {
      engine.play(playhead >= duration - 0.05 ? 0 : playhead);
      setPlaying(true);
    }
  }, [engine, playhead, duration]);

  /**
   * Preview a chapter interval. When fades are enabled for the chapter, the
   * gain envelope is fitted to the ACTUAL playback range [from, chapter.end].
   * play() always stops the previous source first, so repeated previews
   * rebuild the curve instead of layering sound.
   */
  const previewChapter = useCallback(
    (c: Chapter, from?: number) => {
      if (!engine.hasBuffer) return;
      const start = from ?? c.start;
      const fade = fades[c.id];
      previewRef.current = { chapterId: c.id, from: start };
      if (fade?.enabled) {
        engine.play(start, c.end, { fadeIn: fade.fadeIn, fadeOut: fade.fadeOut });
      } else {
        engine.play(start, c.end);
      }
      setPlayhead(start);
      setPlaying(true);
    },
    [engine, fades],
  );

  const previewSelection = useCallback(() => {
    if (selected) previewChapter(selected);
  }, [selected, previewChapter]);

  /** Change fade settings; a playing preview of that chapter is rebuilt. */
  const updateFade = useCallback(
    (id: string, patch: Partial<FadeSettings>) => {
      const next = { ...DEFAULT_FADE, ...fades[id], ...patch };
      setFades((prev) => ({ ...prev, [id]: { ...DEFAULT_FADE, ...prev[id], ...patch } }));
      // Param change while this chapter is being previewed: stop the old
      // source and rebuild the curve immediately (never layered on top).
      const p = previewRef.current;
      if (p && p.chapterId === id && engine.playing) {
        const c = chapters.find((x) => x.id === id);
        if (c) {
          if (next.enabled) {
            engine.play(p.from, c.end, { fadeIn: next.fadeIn, fadeOut: next.fadeOut });
          } else {
            engine.play(p.from, c.end);
          }
        }
      }
    },
    [engine, fades, chapters],
  );

  /** Preview starting at a point (clicking an abnormal band). */
  const previewFrom = useCallback(
    (t: number) => {
      if (!engine.hasBuffer) return;
      previewRef.current = null;
      engine.play(t);
      setPlayhead(t);
      setPlaying(true);
    },
    [engine],
  );

  /** From the list status pill: preview the chapter from its first issue. */
  const previewChapterIssue = useCallback(
    (c: Chapter) => {
      if (!engine.hasBuffer) return;
      const q = chapterLoudness?.get(c.id);
      previewChapter(c, q?.firstIssueAt ?? c.start);
    },
    [engine, chapterLoudness, previewChapter],
  );

  const addAtPlayhead = useCallback(() => {
    chaptersApi.createAtPlayhead(playhead);
  }, [chaptersApi, playhead]);

  // ---- keyboard shortcuts ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable
      ) {
        return;
      }
      if (!peaks) return;
      const step = e.shiftKey ? NUDGE_COARSE : NUDGE_FINE;
      const sel = chaptersApi.selected;
      let handled = true;

      // undo/redo work outside of text fields; inside them the browser's
      // native text undo is left alone
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        if (e.shiftKey) chaptersApi.redo();
        else chaptersApi.undo();
      } else if (e.key === ' ') {
        togglePlay();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (!sel) return;
        if (chaptersApi.isLocked(sel.id)) {
          showNotice('当前选中章节已锁定，无法移动 / 调整；先取消锁定再操作');
          return;
        }
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        let o: ReturnType<typeof chaptersApi.move> = null;
        if (e.altKey) {
          o = chaptersApi.resize(sel.id, 'start', sel.start + dir * step, 0);
        } else if (e.ctrlKey || e.metaKey) {
          o = chaptersApi.resize(sel.id, 'end', sel.end + dir * step, 0);
        } else {
          o = chaptersApi.move(sel.id, sel.start + dir * step, 0);
        }
        if (o && o.clamped) showNotice(chainOutcomeText(o, chaptersApi.chapters));
      } else if (e.key === 'n' || e.key === 'N') {
        addAtPlayhead();
      } else if (e.key === 'p' || e.key === 'P') {
        previewSelection();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        if (!chaptersApi.remove(sel.id)) {
          showNotice('该章节已锁定，无法删除；先取消锁定再删除');
        }
      } else if (e.key === 'Escape') {
        chaptersApi.select(null);
      } else {
        handled = false;
      }
      if (handled) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [peaks, chaptersApi, togglePlay, previewSelection, addAtPlayhead, showNotice]);

  const baseName = (fileName ?? 'podcast').replace(/\.[^.]+$/, '');

  return (
    <div className="app" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <header className="app-header">
        <h1>播客章节标注工作台</h1>
        <label className="file-button">
          导入音频
          <input type="file" accept="audio/*" onChange={onFileInput} hidden />
        </label>
        {fileName && <span className="file-name">{fileName}</span>}
        <span className="spacer" />
        <button
          disabled={chapters.length === 0}
          onClick={() => downloadFile(`${baseName}.vtt`, toWebVTT(chapters), 'text/vtt')}
        >
          导出 WebVTT
        </button>
        <button
          disabled={chapters.length === 0}
          onClick={() =>
            downloadFile(
              `${baseName}.chapters.json`,
              toJSON(chapters, { loudness: chapterLoudness, thresholds: loudnessThresholds }),
              'application/json',
            )
          }
        >
          导出 JSON
        </button>
      </header>

      {error && <div className="error-banner">{error}</div>}

      {!peaks ? (
        <div className="drop-zone">
          {decoding ? '正在解码音频…' : '点击「导入音频」或将音频文件拖入页面'}
        </div>
      ) : (
        <>
          <TransportBar
            loaded
            playing={playing}
            playhead={playhead}
            duration={duration}
            pxPerSec={pxPerSec}
            follow={follow}
            hasSelection={selected !== null}
            onTogglePlay={togglePlay}
            onPreviewSelection={previewSelection}
            onAddAtPlayhead={addAtPlayhead}
            onUndo={chaptersApi.undo}
            onRedo={chaptersApi.redo}
            canUndo={chaptersApi.canUndo}
            canRedo={chaptersApi.canRedo}
            onZoom={setPxPerSec}
            onToggleFollow={() => setFollow((f) => !f)}
          />
          <ChainBar
            chainMode={chaptersApi.chainMode}
            onToggleMode={chaptersApi.toggleChainMode}
            lockedCount={chaptersApi.lockedIds.size}
            totalCount={chapters.length}
            live={liveChain}
            chapters={chapters}
            notice={notice}
          />
          <Waveform
            peaks={peaks}
            chapters={chapters}
            selectedId={selectedId}
            playhead={playhead}
            pxPerSec={pxPerSec}
            follow={follow && playing}
            suggestions={showSuggestions ? suggestions : []}
            loudnessSegments={loudnessSegments}
            lockedIds={chaptersApi.lockedIds}
            chainMode={chaptersApi.chainMode}
            liveChain={liveChain}
            onZoom={setPxPerSec}
            onSeek={seek}
            onPreviewSegment={previewFrom}
            onSelect={chaptersApi.select}
            onCreateFromDrag={chaptersApi.createFromDrag}
            onMove={(id, start, snap) => {
              const o = chaptersApi.move(id, start, snap);
              handleChainOutcome(o);
              return o;
            }}
            onResize={(id, edge, t, snap) => {
              const o = chaptersApi.resize(id, edge, t, snap);
              handleChainOutcome(o);
              return o;
            }}
            onChainLive={setLiveChain}
            onNotice={showNotice}
          />
          <div className="main-body">
            <ChapterList
              chapters={chapters}
              selectedId={selectedId}
              loudness={chapterLoudness}
              lockedIds={chaptersApi.lockedIds}
              onSelect={(id) => {
                chaptersApi.select(id);
                const c = chapters.find((x) => x.id === id);
                if (c) seek(c.start);
              }}
              onPreview={previewChapter}
              onPreviewIssue={previewChapterIssue}
              onRename={chaptersApi.rename}
              onToggleLock={chaptersApi.toggleLock}
              onRemove={(id) => {
                if (previewRef.current?.chapterId === id) previewRef.current = null;
                if (!chaptersApi.remove(id)) {
                  showNotice('该章节已锁定，无法删除；先在列表中解锁');
                }
              }}
            />
            <aside className="detail-panel">
              <SilencePanel
                thresholdDb={silenceThresholdDb}
                minSilenceSec={minSilenceSec}
                show={showSuggestions}
                candidateCount={suggestions.length}
                onThresholdDbChange={setSilenceThresholdDb}
                onMinSilenceSecChange={setMinSilenceSec}
                onToggleShow={() => setShowSuggestions((s) => !s)}
                onApplyAll={applyAllSuggestions}
              />
              <LoudnessPanel
                thresholds={loudnessThresholds}
                show={showLoudness}
                available={dbfsWindows !== null}
                statuses={chapters.map((c) => chapterLoudness?.get(c.id)?.status ?? 'unknown')}
                onQuietDbChange={changeQuietThreshold}
                onLoudDbChange={changeLoudThreshold}
                onToggleShow={() => setShowLoudness((s) => !s)}
              />
              {selected ? (
                <>
                  <h2>选中章节</h2>
                  <label>
                    标题
                    <input
                      value={selected.title}
                      onChange={(e) => chaptersApi.rename(selected.id, e.target.value)}
                    />
                  </label>
                  <button
                    className={chaptersApi.lockedIds.has(selected.id) ? 'lock-toggle is-locked' : 'lock-toggle'}
                    onClick={() => chaptersApi.toggleLock(selected.id)}
                    title="连锁移动时固定该章节；锁定状态仅保留在当前会话，不导出"
                  >
                    {chaptersApi.lockedIds.has(selected.id)
                      ? '🔒 已锁定（点击解锁）'
                      : '🔓 未锁定（连锁移动时可被带动）'}
                  </button>
                  <div className="detail-times">
                    <span>开始 {formatTime(selected.start)}</span>
                    <span>结束 {formatTime(selected.end)}</span>
                    <span>时长 {(selected.end - selected.start).toFixed(2)}s</span>
                  </div>
                  <FadePanel
                    fade={fades[selected.id] ?? DEFAULT_FADE}
                    chapterDuration={selected.end - selected.start}
                    onChange={(patch) => updateFade(selected.id, patch)}
                  />
                  {(() => {
                    const q = chapterLoudness?.get(selected.id);
                    if (!q) return null;
                    const mean = q.meanDbfs === null ? '-∞' : `${q.meanDbfs.toFixed(1)} dBFS`;
                    return (
                      <div className={`qc-detail qc-${q.status}`}>
                        <span>
                          质检状态：
                          {q.status === 'ok'
                            ? '正常'
                            : q.status === 'quiet'
                              ? '过轻'
                              : q.status === 'loud'
                                ? '过响'
                                : '区间过短'}
                          {q.allSilent ? '（全静音）' : ''}
                        </span>
                        <span>
                          平均 {mean} · 动态范围 {q.rangeDb.toFixed(1)} dB
                          {q.minDbfs !== null && q.maxDbfs !== null
                            ? `（${q.minDbfs.toFixed(1)} ~ ${q.maxDbfs.toFixed(1)} dBFS）`
                            : ''}
                        </span>
                        {(q.quietCoverage > 0 || q.loudCoverage > 0) && (
                          <button
                            onClick={() => previewChapterIssue(selected)}
                            title="从首个异常窗口开始播放"
                          >
                            ⚠ 从异常处预览
                          </button>
                        )}
                      </div>
                    );
                  })()}
                  <button className="primary" onClick={previewSelection}>
                    ▶ 预览该章节
                  </button>
                </>
              ) : (
                <p className="empty-hint">点击波形中的章节或列表项以编辑。</p>
              )}
              <div className="shortcut-help">
                <h3>快捷键</h3>
                <ul>
                  <li><kbd>空格</kbd> 播放 / 暂停</li>
                  <li><kbd>N</kbd> 播放头处新建章节</li>
                  <li><kbd>P</kbd> 预览选中章节</li>
                  <li>
                    <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Z</kbd> 撤销，
                    <kbd>Ctrl</kbd>/<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> 重做
                  </li>
                  <li><kbd>←</kbd><kbd>→</kbd> 移动选中章节（±0.05s，<kbd>Shift</kbd> ±1s）</li>
                  <li><kbd>Alt</kbd>+<kbd>←</kbd><kbd>→</kbd> 调整起点</li>
                  <li><kbd>Ctrl</kbd>+<kbd>←</kbd><kbd>→</kbd> 调整终点</li>
                  <li><kbd>Delete</kbd> 删除选中章节</li>
                  <li>
                    波形上方勾选「连锁移动」后，拖动 / 缩放会带动后方未锁定章节；
                    点击章节列表的 🔓 可锁定该章节（仅本会话有效，不导出）
                  </li>
                  <li>滚轮：缩放波形；拖拽空白：创建章节</li>
                </ul>
              </div>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
