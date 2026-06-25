import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Editable page indicator: a small box holding the current page that the user
 * can type over to jump, followed by "/ <totalPages>". Commits on Enter or
 * blur (reverting empty or out-of-range input); Escape cancels.
 */
export function PageJumper({
  page,
  totalPages,
  onJump,
  className,
}: {
  page: number;
  totalPages: number;
  onJump: (page: number) => void;
  className?: string;
}) {
  const [value, setValue] = useState(String(page));
  const inputRef = useRef<HTMLInputElement>(null);
  // Set just before a programmatic blur (Enter/Escape) so the blur handler
  // doesn't re-commit a value we've already handled — or, for Escape, jump to
  // the still-pending typed value instead of cancelling.
  const skipBlurRef = useRef(false);

  // Keep the field in sync when the page changes elsewhere (Prev/Next, filters).
  useEffect(() => {
    setValue(String(page));
  }, [page]);

  const commit = () => {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1 || n > totalPages) {
      setValue(String(page)); // revert empty / out-of-range input
      return;
    }
    if (n !== page) onJump(n);
    else setValue(String(page));
  };

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 text-sm text-muted-foreground",
        className,
      )}
    >
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        aria-label={`Page number, ${totalPages} pages total`}
        value={value}
        onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ""))}
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
            skipBlurRef.current = true; // commit already ran; don't double-fire
            inputRef.current?.blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setValue(String(page));
            skipBlurRef.current = true; // cancel — suppress the blur commit
            inputRef.current?.blur();
          }
        }}
        onBlur={() => {
          if (skipBlurRef.current) {
            skipBlurRef.current = false;
            return;
          }
          commit();
        }}
        className="h-9 w-14 rounded-md border border-input bg-background px-2 text-center text-sm font-medium text-foreground shadow-sm outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring"
      />
      <span aria-hidden="true">/</span>
      <span>{totalPages}</span>
    </div>
  );
}
