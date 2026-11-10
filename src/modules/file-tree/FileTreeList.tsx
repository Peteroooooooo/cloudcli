import type { DragEvent, ReactNode, RefObject } from 'react';

import type { FileTreeDirectoryStatus, FileTreeNode as FileTreeNodeType, FileTreeViewMode } from '@/shared/types';
import FileTreeDirectoryStatusRows from '@/modules/file-tree/FileTreeDirectoryStatusRows';
import FileTreeNode from '@/modules/file-tree/FileTreeNode';

// Cache key the tree data hook uses for the project root.
const ROOT_DIRECTORY_KEY = '';

type FileTreeListProps = {
  items: FileTreeNodeType[];
  viewMode: FileTreeViewMode;
  expandedDirs: Set<string>;
  onItemClick: (item: FileTreeNodeType) => void;
  renderFileIcon: (filename: string) => ReactNode;
  formatFileSize: (bytes?: number) => string;
  formatRelativeTime: (date?: string) => string;
  onRename?: (item: FileTreeNodeType) => void;
  onDelete?: (item: FileTreeNodeType) => void;
  onNewFile?: (path: string) => void;
  onNewFolder?: (path: string) => void;
  onCopyPath?: (item: FileTreeNodeType) => void;
  onDownload?: (item: FileTreeNodeType) => void;
  onUpload?: (path: string) => void;
  onRefresh?: () => void;
  // Drag-and-drop upload targeting
  dropTarget?: string | null;
  onItemDragOver?: (event: DragEvent<HTMLDivElement>, targetPath: string) => void;
  // Rename state for inline editing
  renamingItem?: FileTreeNodeType | null;
  renameValue?: string;
  setRenameValue?: (value: string) => void;
  handleConfirmRename?: () => void;
  handleCancelRename?: () => void;
  renameInputRef?: RefObject<HTMLInputElement>;
  operationLoading?: boolean;
  // On-demand loading: absent for search results, which arrive complete.
  getDirectoryStatus?: (directoryPath: string) => FileTreeDirectoryStatus;
  onLoadMore?: (directoryPath: string) => void;
};

/** Rendered by FileTreeBody to lay out the tree rows for the active view mode. */
export default function FileTreeList({
  items,
  viewMode,
  expandedDirs,
  onItemClick,
  renderFileIcon,
  formatFileSize,
  formatRelativeTime,
  onRename,
  onDelete,
  onNewFile,
  onNewFolder,
  onCopyPath,
  onDownload,
  onUpload,
  onRefresh,
  dropTarget,
  onItemDragOver,
  renamingItem,
  renameValue,
  setRenameValue,
  handleConfirmRename,
  handleCancelRename,
  renameInputRef,
  operationLoading,
  getDirectoryStatus,
  onLoadMore,
}: FileTreeListProps) {
  return (
    <div>
      {items.map((item) => (
        <FileTreeNode
          key={item.path}
          item={item}
          level={0}
          viewMode={viewMode}
          expandedDirs={expandedDirs}
          onItemClick={onItemClick}
          renderFileIcon={renderFileIcon}
          formatFileSize={formatFileSize}
          formatRelativeTime={formatRelativeTime}
          onRename={onRename}
          onDelete={onDelete}
          onNewFile={onNewFile}
          onNewFolder={onNewFolder}
          onCopyPath={onCopyPath}
          onDownload={onDownload}
          onUpload={onUpload}
          onRefresh={onRefresh}
          dropTarget={dropTarget}
          onItemDragOver={onItemDragOver}
          renamingItem={renamingItem}
          renameValue={renameValue}
          setRenameValue={setRenameValue}
          handleConfirmRename={handleConfirmRename}
          handleCancelRename={handleCancelRename}
          renameInputRef={renameInputRef}
          operationLoading={operationLoading}
          getDirectoryStatus={getDirectoryStatus}
          onLoadMore={onLoadMore}
        />
      ))}
      {getDirectoryStatus && (
        <FileTreeDirectoryStatusRows
          directoryPath={ROOT_DIRECTORY_KEY}
          status={getDirectoryStatus(ROOT_DIRECTORY_KEY)}
          level={0}
          onLoadMore={onLoadMore}
        />
      )}
    </div>
  );
}
