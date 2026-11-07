import { memo, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle2, ChevronDown, Loader2 } from 'lucide-react';

import type {
  ChatMessage,
  ClaudePermissionSuggestion,
  DiffLine,
  DiffStats,
  LLMProvider,
  PermissionGrantResult,
  Project,
  WorkRunFile,
  WorkRunItem,
} from '@/shared/types';
import { formatToolDisplayName } from '@/modules/chat/tools/configs/toolConfigs';
import { DiffStatsBadge } from '@/modules/chat/tools/DiffStatsBadge';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import ToolGroupContainer from '@/modules/chat/transcript/ToolGroupContainer';
import { summarizeDiff } from '@/modules/chat/utils/messageTransforms';
import { isToolGroupItem } from '@/modules/chat/utils/toolGrouping';

/** File chips shown under the header before the rest collapse into "+n files". */
const VISIBLE_FILE_CHIPS = 4;

type WorkRunCardProps = {
  run: WorkRunItem;
  prevMessage: ChatMessage | null;
  /** True while this is the turn the agent is still working on. */
  isLive: boolean;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  getMessageKey: (message: ChatMessage) => string;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission?: (suggestion: ClaudePermissionSuggestion) => PermissionGrantResult | null | undefined;
  showRawParameters?: boolean;
  showThinking?: boolean;
  selectedProject?: Project | null;
  provider: LLMProvider | string;
};

type FileChip = WorkRunFile & { name: string; stats: DiffStats };

const baseName = (filePath: string): string => filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;

function useFileChips(
  files: WorkRunFile[],
  createDiff: (oldStr: string, newStr: string) => DiffLine[],
): FileChip[] {
  return useMemo(() => files.map((file) => {
    let added = 0;
    let removed = 0;
    for (const edit of file.edits) {
      const stats = summarizeDiff(createDiff(edit.oldContent, edit.newContent));
      added += stats.added;
      removed += stats.removed;
    }
    return { ...file, name: baseName(file.path), stats: { added, removed } };
  }), [files, createDiff]);
}

/**
 * Rendered by chat's ChatMessagesPane on phone-sized screens in place of one
 * turn's tool calls, reasoning and progress notes: a one-line summary (steps,
 * failures, time taken, or the step running now), the files the turn changed,
 * and the full rows when tapped open.
 */
function WorkRunCard({
  run,
  prevMessage,
  isLive,
  createDiff,
  getMessageKey,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  showRawParameters,
  showThinking,
  selectedProject,
  provider,
}: WorkRunCardProps) {
  const { t } = useTranslation('chat');
  // The card exists to hide the rows; they render only once the user asks.
  const [isExpanded, setIsExpanded] = useState(false);
  const fileChips = useFileChips(run.files, createDiff);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Collapsing from the bottom of a long run would otherwise leave the reader
  // wherever the transcript reflows to, far below the card they just closed.
  const collapseFromBottom = () => {
    setIsExpanded(false);
    requestAnimationFrame(() => cardRef.current?.scrollIntoView({ block: 'nearest' }));
  };

  const messageKeys = useMemo(() => {
    const occurrences = new Map<string, number>();
    return run.items.map((item) => {
      const key = isToolGroupItem(item) ? `tool-group-${getMessageKey(item.messages[0])}` : getMessageKey(item);
      const seen = occurrences.get(key) ?? 0;
      occurrences.set(key, seen + 1);
      return seen === 0 ? key : `${key}__${seen}`;
    });
  }, [run.items, getMessageKey]);

  const formatDuration = (ms: number): string => {
    const totalSeconds = Math.max(1, Math.round(ms / 1000));
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (h > 0) return t('workRun.hours', { h, m });
    if (m > 0) return t('workRun.minutes', { m, s });
    return t('workRun.seconds', { s });
  };

  const latest = run.latestStep;
  const liveLine = !isLive || !latest
    ? ''
    : latest.kind === 'thinking'
      ? t('workRun.thinking')
      : latest.kind === 'text'
        ? latest.text
        : [formatToolDisplayName(latest.toolName), latest.detail].filter(Boolean).join(' · ');

  const showDuration = !isLive && run.durationMs !== null && run.durationMs >= 1000;
  const hiddenFileCount = Math.max(0, fileChips.length - VISIBLE_FILE_CHIPS);

  return (
    <div ref={cardRef} className="chat-message work-run px-3 sm:px-0" data-message-timestamp={run.timestamp || undefined}>
      <div className="overflow-hidden rounded-xl border border-border/60 bg-muted/30 dark:bg-muted/10">
        <button
          type="button"
          className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left active:bg-muted/50"
          onClick={() => setIsExpanded((current) => !current)}
          aria-expanded={isExpanded}
          aria-label={isExpanded ? t('workRun.collapse') : t('workRun.showSteps')}
        >
          {isLive ? (
            <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-sky-500" aria-hidden />
          ) : run.errorCount > 0 ? (
            <AlertCircle className="h-4 w-4 flex-shrink-0 text-red-500 dark:text-red-400" aria-hidden />
          ) : (
            <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] text-foreground">
              <span className="font-medium">{isLive ? t('workRun.working') : t('workRun.done')}</span>
              <span className="text-muted-foreground"> · {t('workRun.steps', { count: run.stepCount })}</span>
              {run.errorCount > 0 && (
                <span className="text-red-600 dark:text-red-400"> · {t('workRun.failed', { count: run.errorCount })}</span>
              )}
              {showDuration && run.durationMs !== null && (
                <span className="text-muted-foreground"> · {formatDuration(run.durationMs)}</span>
              )}
            </span>
            {liveLine && (
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">{liveLine}</span>
            )}
          </span>
          <ChevronDown
            className={`h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform ${isExpanded ? 'rotate-180' : ''}`}
            aria-hidden
          />
        </button>

        {fileChips.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pb-2.5">
            {fileChips.slice(0, VISIBLE_FILE_CHIPS).map((file) => {
              const lastEdit = file.edits[file.edits.length - 1];
              return (
                <button
                  key={file.path}
                  type="button"
                  title={file.path}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/50 bg-background/80 px-2 py-1 text-xs text-foreground active:bg-muted"
                  onClick={() => onFileOpen?.(file.path, {
                    old_string: lastEdit?.oldContent,
                    new_string: lastEdit?.newContent,
                  })}
                >
                  <span className="truncate font-mono">{file.name}</span>
                  <DiffStatsBadge stats={file.stats} className="flex-shrink-0 text-[11px]" />
                </button>
              );
            })}
            {hiddenFileCount > 0 && (
              <button
                type="button"
                className="rounded-md px-2 py-1 text-xs text-muted-foreground active:bg-muted"
                onClick={() => setIsExpanded(true)}
              >
                {t('workRun.moreFiles', { count: hiddenFileCount })}
              </button>
            )}
          </div>
        )}

        {isExpanded && (
          <div className="border-t border-border/50 bg-background/40">
            <div className="space-y-3 py-3">
              {run.items.map((item, index) => {
                const previous = index > 0 ? run.items[index - 1] : null;
                // The first row reads as a continuation of the card, so it does
                // not repeat the agent's avatar header inside it.
                const itemPrevMessage = previous === null
                  ? (isToolGroupItem(item) ? item.messages[0] : item) ?? prevMessage
                  : isToolGroupItem(previous)
                    ? previous.messages[previous.messages.length - 1] ?? prevMessage
                    : previous;

                return isToolGroupItem(item) ? (
                  <ToolGroupContainer
                    key={messageKeys[index]}
                    group={item}
                    prevMessage={itemPrevMessage}
                    createDiff={createDiff}
                    getMessageKey={getMessageKey}
                    onFileOpen={onFileOpen}
                    onShowSettings={onShowSettings}
                    onGrantToolPermission={onGrantToolPermission}
                    showRawParameters={showRawParameters}
                    showThinking={showThinking}
                    selectedProject={selectedProject}
                    provider={provider}
                  />
                ) : (
                  <MessageComponent
                    key={messageKeys[index]}
                    message={item}
                    prevMessage={itemPrevMessage}
                    createDiff={createDiff}
                    onFileOpen={onFileOpen}
                    onShowSettings={onShowSettings}
                    onGrantToolPermission={onGrantToolPermission}
                    showRawParameters={showRawParameters}
                    showThinking={showThinking}
                    selectedProject={selectedProject}
                    provider={provider}
                  />
                );
              })}
            </div>
            <button
              type="button"
              className="flex w-full items-center justify-center gap-1 border-t border-border/50 py-2.5 text-xs text-muted-foreground active:bg-muted/50"
              onClick={collapseFromBottom}
            >
              <ChevronDown className="h-3.5 w-3.5 rotate-180" aria-hidden />
              {t('workRun.collapse')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Memoized for the same reason as ToolGroupContainer: the pane re-renders on
 * every stream tick, and workRunGrouping keeps `run` identical while its rows
 * are unchanged, so only the card that is actually growing renders again.
 */
export default memo(WorkRunCard);
