import type { TFunction } from 'i18next';

import { Tooltip } from '@/shared/ui';
import { useSessionOpenElsewhere } from '@/shared/context/SessionProtectionContext';

type OpenElsewhereMarkerProps = {
  sessionId: string;
  t: TFunction;
};

/**
 * A small dot on the corner of a sidebar row's agent icon saying the session
 * is open in another Claude process, such as a VS Code panel or a terminal;
 * the tooltip names which. Renders nothing otherwise. The parent icon box
 * must be `relative`.
 *
 * It reads the open-elsewhere map itself, so the memoized row around it does
 * not re-render when that map changes.
 */
export default function OpenElsewhereMarker({ sessionId, t }: OpenElsewhereMarkerProps) {
  const openElsewhere = useSessionOpenElsewhere(sessionId);
  if (!openElsewhere) {
    return null;
  }

  const tooltip = t(`openElsewhere.tooltip.${openElsewhere.openIn}`);
  return (
    <span className="absolute -bottom-px -right-px">
      <Tooltip content={tooltip} position="top">
        <span
          data-testid="open-elsewhere-marker"
          data-open-in={openElsewhere.openIn}
          role="img"
          aria-label={tooltip}
          className="block h-1.5 w-1.5 rounded-full bg-sky-500 ring-[1.5px] ring-background dark:bg-sky-400"
        />
      </Tooltip>
    </span>
  );
}
