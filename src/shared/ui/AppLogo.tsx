import { cn } from '@/shared/utils';

type AppLogoProps = {
  className?: string;
};

/**
 * CloudCLI's mark: a near-black rounded tile with a white message-square
 * glyph, the same drawing as the favicon and the installed-app icons that
 * scripts/generate-icons.mjs writes. The tile keeps its colour in both themes;
 * in dark mode a faint ring keeps its edge visible on the near-black page.
 *
 * Used by the sidebar header, the About settings tab, and the sign-in and
 * loading screens.
 */
export function AppLogo({ className }: AppLogoProps) {
  return (
    <svg
      viewBox="0 0 64 64"
      role="img"
      aria-label="CloudCLI"
      className={cn('flex-shrink-0 rounded-[22.5%] dark:ring-1 dark:ring-white/15', className)}
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="64" height="64" rx="14.4" fill="#18181b" />
      <path
        transform="translate(32 32) scale(1.333) translate(-12 -12)"
        d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
        fill="none"
        stroke="#ffffff"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
