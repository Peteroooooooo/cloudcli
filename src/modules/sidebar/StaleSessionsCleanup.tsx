import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom';
import { Folder, Loader2, Trash2, X } from 'lucide-react';
import type { TFunction } from 'i18next';

import { api } from '@/shared/api';
import { Button, LLMProviderLogo } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { SessionDeletionFailure, StaleSessionListItem } from '@/shared/types';
import { PROVIDER_LABELS, formatCompactAge } from '@/modules/sidebar/utils/sidebarProjectFormatting';

/** The idle periods offered; the first is the default. */
const IDLE_DAY_CHOICES = [7, 14, 30, 90] as const;

type StaleSessionsApiPayload = {
  data?: { sessions?: StaleSessionListItem[] };
};

type ProjectGroup = {
  key: string;
  displayName: string;
  path: string | null;
  sessions: StaleSessionListItem[];
};

function groupByProject(sessions: StaleSessionListItem[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const session of sessions) {
    const key = session.projectId ?? session.projectPath ?? `session:${session.sessionId}`;
    const group = groups.get(key);
    if (group) {
      group.sessions.push(session);
    } else {
      groups.set(key, {
        key,
        displayName: session.projectDisplayName,
        path: session.projectPath,
        sessions: [session],
      });
    }
  }
  return [...groups.values()];
}

type StaleSessionsCleanupProps = {
  onClose: () => void;
  /** Permanently deletes the sessions and resolves with the ones that could not be deleted. */
  onDeleteSessions: (sessionIds: string[], onProgress: (settled: number) => void) => Promise<SessionDeletionFailure[]>;
  currentTime: Date;
  t: TFunction;
};

type DeleteProgress = { settled: number; total: number };

/**
 * Rendered by Sidebar from the archive view's "clean up old sessions" button:
 * lists sessions nobody has touched for a while, grouped by project, and
 * permanently deletes the ticked ones from CloudCLI and from the agent that
 * owns them.
 */
export default function StaleSessionsCleanup({ onClose, onDeleteSessions, currentTime, t }: StaleSessionsCleanupProps) {
  const [idleDays, setIdleDays] = useState<number>(IDLE_DAY_CHOICES[0]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [sessions, setSessions] = useState<StaleSessionListItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isConfirming, setIsConfirming] = useState(false);
  const [progress, setProgress] = useState<DeleteProgress | null>(null);
  const [failures, setFailures] = useState<Map<string, string>>(new Map());
  const [lastResult, setLastResult] = useState<{ deleted: number; failed: number } | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const isDeleting = progress !== null;

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await api.staleSessions(idleDays);
        if (!response.ok) {
          throw new Error(`status ${response.status}`);
        }
        const payload = (await response.json()) as StaleSessionsApiPayload;
        const next = Array.isArray(payload.data?.sessions) ? payload.data.sessions : [];
        if (cancelled) {
          return;
        }
        setSessions(next);
        // Everything listed starts ticked: clearing out old sessions is why the
        // list was opened, and nothing is deleted before the confirmation.
        setSelectedIds(new Set(next.map((session) => session.sessionId)));
        setLoadState('ready');
      } catch (error) {
        console.error('[Sidebar] Failed to load old sessions:', error);
        if (!cancelled) {
          setLoadState('error');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [idleDays, reloadToken]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isDeleting) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isDeleting, onClose]);

  const groups = useMemo(() => groupByProject(sessions), [sessions]);
  const selectedCount = sessions.filter((session) => selectedIds.has(session.sessionId)).length;
  const allSelected = sessions.length > 0 && selectedCount === sessions.length;

  const toggleIds = useCallback((ids: string[], select: boolean) => {
    setIsConfirming(false);
    setSelectedIds((previous) => {
      const next = new Set(previous);
      ids.forEach((id) => (select ? next.add(id) : next.delete(id)));
      return next;
    });
  }, []);

  const runDelete = async () => {
    const ids = sessions.filter((session) => selectedIds.has(session.sessionId)).map((session) => session.sessionId);
    if (ids.length === 0) {
      return;
    }
    setIsConfirming(false);
    setProgress({ settled: 0, total: ids.length });

    const failed = await onDeleteSessions(ids, (settled) => setProgress({ settled, total: ids.length }));
    const failedById = new Map(failed.map((failure) => [failure.sessionId, failure.message]));
    const deletedIds = new Set(ids.filter((id) => !failedById.has(id)));

    setSessions((previous) => previous.filter((session) => !deletedIds.has(session.sessionId)));
    // What failed stays listed and ticked with its reason, ready to retry.
    setSelectedIds(new Set(failedById.keys()));
    setFailures(failedById);
    setLastResult({ deleted: deletedIds.size, failed: failedById.size });
    setProgress(null);
  };

  const dayLabel = (days: number) => t('staleCleanup.days', { count: days, defaultValue: '{{count}} days' });

  return ReactDOM.createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget && !isDeleting) {
          onClose();
        }
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="stale-cleanup-title"
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
      >
        <div className="flex items-start gap-3 border-b border-border p-4">
          <div className="min-w-0 flex-1">
            <h3 id="stale-cleanup-title" className="text-base font-semibold text-foreground">
              {t('staleCleanup.title', 'Clean up old sessions')}
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {t('staleCleanup.description', {
                days: idleDays,
                defaultValue: 'Sessions idle for {{days}} days or more, archived ones included. Starred projects and running sessions are not listed.',
              })}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-red-600 dark:text-red-400">
              {t('staleCleanup.permanentNotice', 'Deleting also removes the session from Claude Code or Codex (transcript, side files, Codex\'s own records). It cannot be undone.')}
            </p>
          </div>
          <button
            type="button"
            className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
            onClick={onClose}
            disabled={isDeleting}
            aria-label={t('staleCleanup.close', 'Close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-4 py-2">
          <span className="mr-1 text-xs text-muted-foreground">{t('staleCleanup.idleFor', 'Idle for at least')}</span>
          {IDLE_DAY_CHOICES.map((days) => (
            <button
              key={days}
              type="button"
              disabled={isDeleting}
              aria-pressed={idleDays === days}
              onClick={() => {
                if (days === idleDays) {
                  return;
                }
                setFailures(new Map());
                setLastResult(null);
                setIsConfirming(false);
                setLoadState('loading');
                setIdleDays(days);
              }}
              className={cn(
                'rounded-md border px-2 py-0.5 text-xs transition-colors disabled:opacity-50',
                idleDays === days
                  ? 'border-primary/40 bg-primary/10 text-foreground'
                  : 'border-border/70 text-muted-foreground hover:text-foreground',
              )}
            >
              {dayLabel(days)}
            </button>
          ))}
        </div>

        <div className="min-h-32 flex-1 overflow-y-auto px-2 py-2">
          {loadState === 'loading' ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('staleCleanup.loading', 'Finding old sessions…')}
            </div>
          ) : loadState === 'error' ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              <p>{t('staleCleanup.loadFailed', 'The list could not be loaded.')}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => {
                  setLoadState('loading');
                  setReloadToken((token) => token + 1);
                }}
              >
                {t('staleCleanup.retry', 'Retry')}
              </Button>
            </div>
          ) : sessions.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {lastResult && lastResult.failed === 0
                ? t('staleCleanup.allDeleted', { count: lastResult.deleted, defaultValue: 'Deleted {{count}} sessions.' })
                : t('staleCleanup.empty', { days: idleDays, defaultValue: 'No sessions have been idle for {{days}} days or more.' })}
            </p>
          ) : (
            <div className="space-y-2">
              {groups.map((group) => {
                const groupIds = group.sessions.map((session) => session.sessionId);
                const groupSelected = groupIds.filter((id) => selectedIds.has(id)).length;
                return (
                  <section key={group.key} className="overflow-hidden rounded-lg border border-border/70">
                    <label className="flex cursor-pointer items-center gap-2 bg-muted/30 px-2.5 py-2">
                      <input
                        type="checkbox"
                        className="h-3.5 w-3.5 accent-red-600"
                        checked={groupSelected === groupIds.length}
                        ref={(element) => {
                          if (element) {
                            element.indeterminate = groupSelected > 0 && groupSelected < groupIds.length;
                          }
                        }}
                        disabled={isDeleting}
                        onChange={(event) => toggleIds(groupIds, event.target.checked)}
                      />
                      <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={group.path ?? undefined}>
                        {group.displayName}
                      </span>
                      <span className="flex-shrink-0 text-[10px] tabular-nums text-muted-foreground">
                        {groupSelected}/{groupIds.length}
                      </span>
                    </label>
                    {group.sessions.map((session) => {
                      const failure = failures.get(session.sessionId);
                      return (
                        <label
                          key={session.sessionId}
                          className="flex cursor-pointer items-start gap-2 border-t border-border/40 px-2.5 py-1.5 hover:bg-accent/30"
                        >
                          <input
                            type="checkbox"
                            className="mt-1 h-3.5 w-3.5 accent-red-600"
                            checked={selectedIds.has(session.sessionId)}
                            disabled={isDeleting}
                            onChange={(event) => toggleIds([session.sessionId], event.target.checked)}
                          />
                          <LLMProviderLogo provider={session.provider} className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs text-foreground">{session.sessionTitle}</span>
                            <span className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                              <span>{PROVIDER_LABELS[session.provider] ?? session.provider}</span>
                              <span aria-hidden>·</span>
                              <span className="tabular-nums">{formatCompactAge(session.lastActivity, currentTime)}</span>
                              {session.isArchived && (
                                <span className="rounded bg-muted px-1 py-px">{t('staleCleanup.archived', 'Archived')}</span>
                              )}
                            </span>
                            {failure && (
                              <span className="mt-0.5 block break-words text-[10px] text-red-600 dark:text-red-400">
                                {failure}
                              </span>
                            )}
                          </span>
                        </label>
                      );
                    })}
                  </section>
                );
              })}
            </div>
          )}
        </div>

        <div className="space-y-2 border-t border-border bg-muted/30 p-3">
          {lastResult && lastResult.failed > 0 && (
            <p className="text-xs text-red-600 dark:text-red-400">
              {t('staleCleanup.partialResult', {
                deleted: lastResult.deleted,
                failed: lastResult.failed,
                defaultValue: 'Deleted {{deleted}}. {{failed}} could not be deleted; they are still listed with the reason.',
              })}
            </p>
          )}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="tabular-nums">
                {t('staleCleanup.selectedCount', {
                  selected: selectedCount,
                  total: sessions.length,
                  defaultValue: '{{selected}} of {{total}} selected',
                })}
              </span>
              {sessions.length > 0 && (
                <button
                  type="button"
                  className="text-primary hover:underline disabled:opacity-50"
                  disabled={isDeleting}
                  onClick={() => toggleIds(sessions.map((session) => session.sessionId), !allSelected)}
                >
                  {allSelected ? t('staleCleanup.selectNone', 'Select none') : t('staleCleanup.selectAll', 'Select all')}
                </button>
              )}
            </div>
            {progress ? (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('staleCleanup.deleting', {
                  settled: progress.settled,
                  total: progress.total,
                  defaultValue: 'Deleting {{settled}} of {{total}}…',
                })}
              </span>
            ) : isConfirming ? (
              <div className="flex items-center gap-1.5">
                <Button variant="ghost" size="sm" onClick={() => setIsConfirming(false)}>
                  {t('actions.cancel')}
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  className="bg-red-600 text-white hover:bg-red-700"
                  onClick={() => void runDelete()}
                >
                  {t('staleCleanup.confirm', { count: selectedCount, defaultValue: 'Yes, delete {{count}}' })}
                </Button>
              </div>
            ) : (
              <Button
                variant="destructive"
                size="sm"
                className="bg-red-600 text-white hover:bg-red-700"
                disabled={selectedCount === 0 || loadState !== 'ready'}
                onClick={() => setIsConfirming(true)}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                {t('staleCleanup.delete', { count: selectedCount, defaultValue: 'Delete {{count}} permanently' })}
              </Button>
            )}
          </div>
          {isConfirming && (
            <p className="text-right text-[11px] text-red-600 dark:text-red-400">
              {t('staleCleanup.confirmNotice', 'This cannot be undone.')}
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
