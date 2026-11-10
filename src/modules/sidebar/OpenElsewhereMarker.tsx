import { Terminal } from 'lucide-react';

import { useIsSessionOpenInCloudCli, useSessionOpenElsewhere } from '@/shared/context/SessionProtectionContext';

type OpenElsewhereMarkerProps = {
  sessionId: string;
};

/**
 * A small `>_` on the corner of a sidebar row's agent icon saying the session
 * is open: in another Claude process, such as a VS Code panel or a terminal,
 * or in CloudCLI itself. One glyph for every kind of open; `data-open-in`
 * names which, the other process winning when both hold it. Renders nothing
 * otherwise. The parent icon box must be `relative`.
 *
 * It reads the open lists itself, so the memoized row around it does not
 * re-render when they change.
 */
export default function OpenElsewhereMarker({ sessionId }: OpenElsewhereMarkerProps) {
  const openElsewhere = useSessionOpenElsewhere(sessionId);
  const isOpenInCloudCli = useIsSessionOpenInCloudCli(sessionId);
  if (!openElsewhere && !isOpenInCloudCli) {
    return null;
  }

  return (
    <span
      data-testid="open-elsewhere-marker"
      data-open-in={openElsewhere?.openIn ?? 'cloudcli'}
      aria-hidden="true"
      className="absolute -bottom-0.5 -right-0.5 flex h-2.5 w-2.5 items-center justify-center rounded-full bg-background text-sky-600 dark:text-sky-400"
    >
      <Terminal className="h-2 w-2" strokeWidth={3} />
    </span>
  );
}
