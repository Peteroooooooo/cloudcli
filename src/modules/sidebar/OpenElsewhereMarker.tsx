import type { TFunction } from 'i18next';

import { Tooltip } from '@/shared/ui';
import { useSessionOpenElsewhere } from '@/shared/context/SessionProtectionContext';

type OpenElsewhereMarkerProps = {
  sessionId: string;
  /** Prefixes the "·" the recents row puts between its metadata items. */
  withSeparator?: boolean;
  t: TFunction;
};

/**
 * A quiet label on a sidebar row saying the session is also open in another
 * Claude process, such as a VS Code panel. Renders nothing otherwise.
 *
 * It reads the open-elsewhere map itself, so the memoized row around it does
 * not re-render when that map changes.
 */
export default function OpenElsewhereMarker({ sessionId, withSeparator = false, t }: OpenElsewhereMarkerProps) {
  const openElsewhere = useSessionOpenElsewhere(sessionId);
  if (!openElsewhere) {
    return null;
  }

  const label = t(`openElsewhere.${openElsewhere.openIn}`);
  const tooltip = t(`openElsewhere.tooltip.${openElsewhere.openIn}`);
  return (
    <>
      {withSeparator && <span className="flex-shrink-0 text-muted-foreground/40">·</span>}
      <Tooltip content={tooltip} position="top">
        <span
          data-testid="open-elsewhere-marker"
          aria-label={tooltip}
          className="flex-shrink-0 whitespace-nowrap text-[10px] leading-3 text-muted-foreground"
        >
          {label}
        </span>
      </Tooltip>
    </>
  );
}
