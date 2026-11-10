import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { FileTreeDirectoryStatus } from '@/shared/types';
import { cn } from '@/shared/utils';

type FileTreeDirectoryStatusRowsProps = {
  directoryPath: string;
  status: FileTreeDirectoryStatus;
  // Depth of the folder's children, which these rows line up with.
  level: number;
  onLoadMore?: (directoryPath: string) => void;
};

/**
 * Rendered by FileTreeNode under an expanded folder, and by FileTreeList under
 * the project root, for the parts of a folder that are not plain rows: its
 * first load, a load error, and the "show more" row of a folder with more
 * children than one page.
 */
export default function FileTreeDirectoryStatusRows({
  directoryPath,
  status,
  level,
  onLoadMore,
}: FileTreeDirectoryStatusRowsProps) {
  const { t } = useTranslation();
  // Lines the text up with the names of file rows at the same depth.
  const paddingLeft = `${level * 16 + 4 + 18}px`;
  const rowClassName = 'flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-[13px] leading-tight';

  if (status.error) {
    return (
      <div className={cn(rowClassName, 'text-red-600 dark:text-red-400')} style={{ paddingLeft }}>
        <span className="truncate">{status.error}</span>
      </div>
    );
  }

  if (!status.loaded) {
    return status.loading ? (
      <div className={cn(rowClassName, 'text-muted-foreground')} style={{ paddingLeft }}>
        <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" />
        <span className="truncate">{t('fileTree.loading', 'Loading files...')}</span>
      </div>
    ) : null;
  }

  if (status.remaining > 0 && onLoadMore) {
    return (
      <button
        type="button"
        className={cn(rowClassName, 'cursor-pointer rounded-sm text-muted-foreground transition-colors duration-100 hover:bg-accent/60 hover:text-foreground')}
        style={{ paddingLeft }}
        disabled={status.loading}
        onClick={() => onLoadMore(directoryPath)}
      >
        {status.loading && <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" />}
        <span className="truncate">
          {t('fileTree.showMore', 'Show more ({{formattedCount}} not shown)', {
            count: status.remaining,
            formattedCount: status.remaining.toLocaleString(),
          })}
        </span>
      </button>
    );
  }

  return null;
}
