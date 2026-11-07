import { Terminal } from 'lucide-react';

import { useSessionOpenElsewhere } from '@/shared/context/SessionProtectionContext';

type OpenElsewhereMarkerProps = {
  sessionId: string;
};

/**
 * A small `>_` on the corner of a sidebar row's agent icon saying the session
 * is open in another Claude process, such as a VS Code panel or a terminal.
 * Renders nothing otherwise. The parent icon box must be `relative`.
 *
 * It reads the open-elsewhere map itself, so the memoized row around it does
 * not re-render when that map changes.
 */
export default function OpenElsewhereMarker({ sessionId }: OpenElsewhereMarkerProps) {
  const openElsewhere = useSessionOpenElsewhere(sessionId);
  if (!openElsewhere) {
    return null;
  }

  return (
    <span
      data-testid="open-elsewhere-marker"
      data-open-in={openElsewhere.openIn}
      aria-hidden="true"
      className="absolute -bottom-0.5 -right-0.5 flex h-2.5 w-2.5 items-center justify-center rounded-full bg-background text-sky-600 dark:text-sky-400"
    >
      <Terminal className="h-2 w-2" strokeWidth={3} />
    </span>
  );
}
