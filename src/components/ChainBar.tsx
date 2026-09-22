import { chainOutcomeText, type ChainOutcome } from '../utils/chapterOps';

interface ChainBarProps {
  chainMode: boolean;
  onToggleMode: () => void;
  lockedCount: number;
  totalCount: number;
  /** live summary while dragging/resizing (chain mode only) */
  live: ChainOutcome | null;
  /** chapter list for title lookup in the summary text */
  chapters: { id: string; title: string }[];
  /** transient feasibility/lock notice after a gesture */
  notice: string | null;
}

export function ChainBar(props: ChainBarProps) {
  const { chainMode, onToggleMode, lockedCount, totalCount, live, chapters, notice } = props;
  return (
    <div className={`chain-bar${chainMode ? ' active' : ''}`}>
      <label className="chain-toggle" title="开启后拖动/缩放会带动后续未锁定章节">
        <input type="checkbox" checked={chainMode} onChange={onToggleMode} />
        <span className="chain-name">连锁移动</span>
      </label>
      <span className="chain-lock-count" title="锁定仅保留在当前会话，不写入导出">
        🔒 已锁定 {lockedCount} / {totalCount} 章
      </span>
      {chainMode ? (
        <span className={`chain-hint${live?.clamped || live && !live.allowed ? ' warn' : ''}`}>
          {live
            ? chainOutcomeText(live, chapters)
            : notice ??
              '拖动或调整未锁定章节时，位移将依次传递给后方未锁定章节，间隔与时长保持不变；遇锁定章节或音频边界自动限制。'}
        </span>
      ) : (
        <span className="chain-hint">
          {notice ?? '点击章节上的 🔒 可锁定任意章节（仅本会话有效）；开启「连锁移动」后方可连锁拖动。'}
        </span>
      )}
    </div>
  );
}
