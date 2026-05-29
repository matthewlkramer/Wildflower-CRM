import type { ReactNode } from "react";

/**
 * Read-only presentation for values that are computed/derived server-side
 * (e.g. fiscal year from a close date, interaction counts, email domain).
 * Renders the label with a small italic "derived from…" hint and muted value
 * so users can tell it apart from editable inline fields.
 */
export function DerivedRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="flex flex-col">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <span className="text-[10px] italic text-muted-foreground/70">{hint}</span>
      </span>
      <span className="text-right text-muted-foreground">{children}</span>
    </div>
  );
}
