import type { ReactNode } from "react";

/** The page toolbar: identity at the left, actions at the right. */
export function Toolbar({ icon, title, meta, actions }: { icon?: ReactNode; title: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex min-h-14 flex-wrap items-center gap-3 border-b border-border px-4 py-2 md:px-6">
      {icon}
      <h1 className="min-w-0 truncate text-[1.375rem] font-semibold leading-tight">{title}</h1>
      {meta ? <div className="min-w-0 text-sm text-muted-foreground">{meta}</div> : null}
      <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>
    </header>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[0.8125rem] font-medium text-muted-foreground">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

const NOTICE = {
  danger: "bg-destructive-tint text-destructive",
  info: "bg-info-tint text-info",
  success: "bg-success-tint text-success",
  warning: "bg-warning-tint text-warning",
};

export function Notice({ tone = "info", children, action }: { tone?: keyof typeof NOTICE; children: ReactNode; action?: ReactNode }) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={`flex items-start gap-3 rounded-sm px-3 py-2 text-sm ${NOTICE[tone]}`}>
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}

/** Pagination footer for a table page. */
export function Pager({ page, limit, total, onPage }: { page: number; limit: number; total: number; onPage: (p: number) => void }) {
  if (total <= limit) return null;
  const last = Math.ceil(total / limit);
  return (
    <div className="flex items-center justify-end gap-2 px-4 py-3 text-sm text-muted-foreground">
      <span className="data">
        {(page - 1) * limit + 1} to {Math.min(page * limit, total)} of {total}
      </span>
      <button className="rounded-sm px-2 py-1 hover:bg-muted disabled:opacity-40" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </button>
      <button className="rounded-sm px-2 py-1 hover:bg-muted disabled:opacity-40" disabled={page >= last} onClick={() => onPage(page + 1)}>
        Next
      </button>
    </div>
  );
}
