import { useRef } from 'react';
import type { KeyboardEvent } from 'react';
import type { TFunction } from 'i18next';

import { LLMProviderLogo } from '@/shared/ui';
import { cn } from '@/shared/utils';
import type { LLMProvider, SessionProviderFilter } from '@/shared/types';
import { PROVIDER_LABELS } from '@/modules/sidebar/utils/sidebarProjectFormatting';

type SidebarProviderFilterProps = {
  value: SessionProviderFilter;
  /** The agents offered after "All", in display order: those with sessions. */
  providers: LLMProvider[];
  onChange: (filter: SessionProviderFilter) => void;
  t: TFunction;
};

/** Keys that move the selection, and by how much; Home and End jump to the ends. */
const STEP_BY_KEY: Record<string, number> = {
  ArrowLeft: -1,
  ArrowUp: -1,
  ArrowRight: 1,
  ArrowDown: 1,
};

/**
 * Used by SidebarHeader, in both the desktop and the mobile header, to narrow
 * every sidebar list to one agent's sessions.
 *
 * A segmented control with a thumb that slides to the selected segment. The
 * segments share the width equally and their labels truncate, so it fits the
 * sidebar at its 220px minimum. It is a radio group: the arrow keys move the
 * selection, and only the selected segment is in the tab order. Nothing is
 * drawn when there is no choice to make, that is when fewer than two agents
 * are offered and "All" is selected.
 */
export default function SidebarProviderFilter({ value, providers, onChange, t }: SidebarProviderFilterProps) {
  const segmentRefs = useRef<Array<HTMLButtonElement | null>>([]);

  if (providers.length < 2 && value === 'all') {
    return null;
  }

  const options: SessionProviderFilter[] = ['all', ...providers];
  const selectedIndex = Math.max(0, options.indexOf(value));

  const select = (index: number) => {
    const option = options[index];
    segmentRefs.current[index]?.focus();
    if (option !== value) {
      onChange(option);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let nextIndex: number | null = null;
    if (event.key in STEP_BY_KEY) {
      nextIndex = (selectedIndex + STEP_BY_KEY[event.key] + options.length) % options.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = options.length - 1;
    }
    if (nextIndex === null) {
      return;
    }
    event.preventDefault();
    select(nextIndex);
  };

  return (
    <div className="rounded-lg bg-muted/50 p-0.5">
      <div
        role="radiogroup"
        aria-label={t('providerFilter.label', 'Filter sessions by agent')}
        className="relative flex"
        onKeyDown={handleKeyDown}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 rounded-md bg-background shadow-sm transition-transform duration-200 ease-out motion-reduce:transition-none"
          style={{
            width: `${100 / options.length}%`,
            transform: `translateX(${selectedIndex * 100}%)`,
          }}
        />
        {options.map((option, index) => {
          const isSelected = index === selectedIndex;
          const label = option === 'all' ? t('providerFilter.all', 'All') : PROVIDER_LABELS[option];

          return (
            <button
              key={option}
              ref={(element) => {
                segmentRefs.current[index] = element;
              }}
              type="button"
              role="radio"
              aria-checked={isSelected}
              tabIndex={isSelected ? 0 : -1}
              title={label}
              onClick={() => select(index)}
              className={cn(
                'relative flex min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1.5 text-xs font-normal transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                isSelected ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {/* The logo repeats the label, so it is kept out of the segment's accessible name. */}
              {option !== 'all' && (
                <span aria-hidden className="flex flex-shrink-0">
                  <LLMProviderLogo provider={option} className="h-3 w-3" />
                </span>
              )}
              <span className="truncate">{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
