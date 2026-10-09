import { Directive, ElementRef, effect, inject, input } from '@angular/core';

export interface Figure {
  before: string;
  after: string;
  value: number;
  decimals: number;
  grouped: boolean;
}

/** Splits formatted text such as "₱13,000.00" into its number and surrounding text. */
export function parseFigure(text: string): Figure | null {
  const match = /-?\d[\d,]*(?:\.(\d+))?/.exec(text);
  if (!match) return null;
  return {
    before: text.slice(0, match.index),
    after: text.slice(match.index + match[0].length),
    value: Number(match[0].replaceAll(',', '')),
    decimals: match[1]?.length ?? 0,
    grouped: match[0].includes(','),
  };
}

/** Formats an in-between value the same way as the final text. */
export function formatFigure(figure: Figure, value: number): string {
  const digits = value.toLocaleString('en-US', {
    minimumFractionDigits: figure.decimals,
    maximumFractionDigits: figure.decimals,
    useGrouping: figure.grouped,
  });
  return figure.before + digits + figure.after;
}

/**
 * Writes already-formatted text into the host, counting the number up from its
 * previous value. Display only: the final text is always exactly the input, and
 * people who prefer reduced motion (or environments without matchMedia) get it at once.
 */
@Directive({ selector: '[appCountUp]' })
export class CountUpDirective {
  readonly appCountUp = input.required<string>();
  private shown = 0;

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    effect((onCleanup) => {
      const text = this.appCountUp();
      const target = parseFigure(text);
      const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? true;
      if (!target || reduce || target.value === this.shown) {
        host.textContent = text;
        this.shown = target?.value ?? 0;
        return;
      }
      const from = this.shown;
      const start = performance.now();
      const duration = 900;
      let frame = 0;
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / duration);
        if (t >= 1) {
          host.textContent = text;
          this.shown = target.value;
          return;
        }
        this.shown = from + (target.value - from) * (1 - (1 - t) ** 4);
        host.textContent = formatFigure(target, this.shown);
        frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
      onCleanup(() => cancelAnimationFrame(frame));
    });
  }
}
