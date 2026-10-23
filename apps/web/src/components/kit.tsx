'use client';
import { CircleHelp, X } from 'lucide-react';
import { type ComponentType, type ReactNode, useEffect, useState } from 'react';

type Icon = ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;

const seenKey = (id: string) => `smc-help-${id}`;

/** Remembers, per browser, that the explanation for a screen has been shown once. */
function useFirstTime(id: string): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try {
      if (!localStorage.getItem(seenKey(id))) {
        setOpen(true);
        localStorage.setItem(seenKey(id), '1');
      }
    } catch {
      /* private mode: the explanation is just closed until asked for */
    }
  }, [id]);
  return [open, setOpen];
}

/**
 * The heading of a screen or tab: an icon, a title, and a "?" that opens a plain-language explanation of what the
 * screen is for. The explanation opens by itself the first time, then only when asked for.
 */
export function PageHead({
  id,
  icon: Icon,
  title,
  subtitle,
  help,
  actions,
}: {
  id: string;
  icon: Icon;
  title: string;
  subtitle?: string;
  help: ReactNode;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useFirstTime(id);
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2.5">
        <span className="brand-soft grid size-8 shrink-0 place-items-center rounded-ctl text-accent-text">
          <Icon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold leading-tight">{title}</h2>
          {subtitle && <p className="truncate text-xs text-muted">{subtitle}</p>}
        </div>
        {actions}
        <button
          type="button"
          aria-label={`What is ${title}?`}
          title={`What is ${title}?`}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="grid size-8 shrink-0 place-items-center rounded-full border border-line text-muted hover:bg-s3 hover:text-fg aria-expanded:accent-soft aria-expanded:text-accent-text"
        >
          <CircleHelp className="size-4" aria-hidden />
        </button>
      </div>
      {open && (
        <div
          role="note"
          className="rise brand-soft relative mt-2.5 rounded-card border border-line p-3 pr-9 text-[13px] leading-relaxed"
        >
          {help}
          <button
            type="button"
            aria-label="Close the explanation"
            onClick={() => setOpen(false)}
            className="absolute right-2 top-2 rounded-ctl p-1 text-muted hover:bg-s3"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`skeleton ${className}`} />;
}

/** A column of grey placeholder bars shown while a tab's data loads, so it never looks empty or broken. */
export function SkeletonList({ rows = 4 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className="space-y-2.5">
      {Array.from({ length: rows }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
        <Skeleton key={i} className={i % 3 === 0 ? 'h-16' : 'h-10'} />
      ))}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  children,
  action,
}: {
  icon: Icon;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="grid place-items-center rounded-card border border-dashed border-line px-6 py-10 text-center">
      <div>
        <span className="brand-soft mx-auto grid size-12 place-items-center rounded-full text-accent-text">
          <Icon className="size-5" aria-hidden />
        </span>
        <p className="mt-3 font-semibold">{title}</p>
        {children && <p className="mx-auto mt-1 max-w-sm text-muted">{children}</p>}
        {action && <div className="mt-4">{action}</div>}
      </div>
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: 'bull' | 'bear';
}) {
  return (
    <div className="surface-card p-4">
      <p className="text-xs font-medium text-muted">{label}</p>
      <p
        className={`num mt-1 text-2xl font-semibold tracking-tight ${tone === 'bull' ? 'text-bull-text' : tone === 'bear' ? 'text-bear-text' : ''}`}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function Pill({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: 'bull' | 'bear' | 'warn' | 'accent';
}) {
  const t =
    tone === 'bull'
      ? 'bg-bull/12 text-bull-text'
      : tone === 'bear'
        ? 'bg-bear/12 text-bear-text'
        : tone === 'warn'
          ? 'bg-warn/15 text-warn-text'
          : tone === 'accent'
            ? 'accent-soft text-accent-text'
            : 'bg-s3 text-muted';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${t}`}
    >
      {children}
    </span>
  );
}

/** A screen's title bar for the full-width pages (Journal, Trades, Settings, Notifications). */
export function PageTitle({
  id,
  icon,
  title,
  subtitle,
  help,
  actions,
}: {
  id: string;
  icon: Icon;
  title: string;
  subtitle?: string;
  help: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-5">
      <PageHead
        id={id}
        icon={icon}
        title={title}
        {...(subtitle ? { subtitle } : {})}
        help={help}
        {...(actions ? { actions } : {})}
      />
    </header>
  );
}

/** A row of pill buttons that filter a list; one is always selected. */
export function FilterChips<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div role="toolbar" aria-label={label} className="mb-3 flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          aria-pressed={value === o}
          onClick={() => onChange(o)}
          className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${value === o ? 'brand-soft border-accent/40 text-accent-text' : 'border-line text-muted hover:bg-s3'}`}
        >
          {o}
        </button>
      ))}
    </div>
  );
}
