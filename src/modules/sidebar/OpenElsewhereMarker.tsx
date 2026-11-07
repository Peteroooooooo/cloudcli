import { Code2, Terminal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TFunction } from 'i18next';

import { Tooltip } from '@/shared/ui';
import { useSessionOpenElsewhere } from '@/shared/context/SessionProtectionContext';
import type { SessionOpenElsewhere } from '@/shared/types';

const ICONS: Record<SessionOpenElsewhere['openIn'], LucideIcon> = {
  vscode: Code2,
  cli: Terminal,
  other: Code2,
};

type OpenElsewhereMarkerProps = {
  sessionId: string;
  t: TFunction;
};

/**
 * A small glyph on the corner of a sidebar row's agent icon saying the session
 * is open in another Claude process: `</>` for a VS Code panel, `>_` for a
 * terminal. Renders nothing otherwise. The parent icon box must be `relative`.
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
    <span className="absolute -bottom-0.5 -right-0.5">
      <Tooltip content={tooltip} position="top">
        <span
          data-testid="open-elsewhere-marker"
          data-open-in={openElsewhere.openIn}
          role="img"
          aria-label={tooltip}
          className="flex h-2.5 w-2.5 items-center justify-center rounded-full bg-background text-sky-600 dark:text-sky-400"
        >
          <Icon className="h-2 w-2" strokeWidth={3} />
        </span>
      </Tooltip>
    </span>
  );
}
