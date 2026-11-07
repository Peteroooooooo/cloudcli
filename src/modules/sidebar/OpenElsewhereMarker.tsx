import { AppWindow, Code2, SquareTerminal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Tooltip } from '@/shared/ui';
import { useSessionOpenElsewhere } from '@/shared/context/SessionProtectionContext';
import type { SessionOpenElsewhere } from '@/shared/types';

const ICONS: Record<SessionOpenElsewhere['openIn'], LucideIcon> = {
  vscode: Code2,
  cli: SquareTerminal,
  other: AppWindow,
};

type OpenElsewhereMarkerProps = {
  sessionId: string;
  t: TFunction;
};

/**
 * A small badge on the corner of a sidebar row's agent icon saying the session
 * is open in another Claude process, such as a VS Code panel or a terminal.
 * Renders nothing otherwise. The parent icon box must be `relative`.
 *
 * It reads the open-elsewhere map itself, so the memoized row around it does
 * not re-render when that map changes.
 */
export default function OpenElsewhereMarker({ sessionId, t }: OpenElsewhereMarkerProps) {
  const openElsewhere = useSessionOpenElsewhere(sessionId);
  if (!openElsewhere) {
    return null;
  }

  const Icon = ICONS[openElsewhere.openIn];
  const tooltip = t(`openElsewhere.tooltip.${openElsewhere.openIn}`);
  return (
    <span className="absolute -bottom-1 -right-1">
      <Tooltip content={tooltip} position="top">
        <span
          data-testid="open-elsewhere-marker"
          data-open-in={openElsewhere.openIn}
          role="img"
          aria-label={tooltip}
          className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-sky-600 text-white ring-2 ring-background dark:bg-sky-500"
        >
          <Icon className="h-2.5 w-2.5" strokeWidth={2.5} />
        </span>
      </Tooltip>
    </span>
  );
}
