import { useMemo, type ReactNode } from "react";
import {
  useListUsers,
  getListUsersQueryKey,
  type User,
} from "@workspace/api-client-react";
import {
  InlineEditSelect,
  type InlineSelectOption,
} from "@/components/inline-edit";

export function userDisplayName(u: User): string {
  const dn = u.displayName?.trim();
  if (dn) return dn;
  const full = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  if (full) return full;
  return u.email;
}

/**
 * Whether a user row has a usable identity to show as an assignable owner.
 * Mirrors the server-side guard in routes/users.ts: a leftover
 * `<clerkId>@unknown.com` placeholder with no name is junk and must never
 * appear as a selectable owner. Real email OR any name makes it usable.
 */
export function hasUsableIdentity(u: User): boolean {
  const hasName = Boolean(
    u.displayName?.trim() || u.firstName?.trim() || u.lastName?.trim(),
  );
  const placeholderEmail = /@unknown\.com$/i.test(u.email ?? "");
  return hasName || !placeholderEmail;
}

export function useUserNameMap(): Map<string, string> {
  const { data } = useListUsers({
    query: { queryKey: getListUsersQueryKey(), staleTime: 60_000 },
  });
  return useMemo(() => {
    const m = new Map<string, string>();
    for (const u of data ?? []) m.set(u.id, userDisplayName(u));
    return m;
  }, [data]);
}

/**
 * Inline-edit Owner picker. Sources options from the active (non-archived)
 * users list. Resolves the current owner's display name via the same list
 * so the read-only label shows e.g. "Jane Doe" instead of a raw user id.
 *
 * The pages still pass a `display` fallback (the resolved name from the
 * page-level useUserNameMap) so we don't double-fetch and so display is
 * consistent before the dropdown is opened.
 */
export function InlineEditUserPicker({
  value,
  display,
  onSave,
  label = "Owner",
  testIdBase,
}: {
  value: string | null;
  display: ReactNode;
  onSave: (next: string | null) => unknown | Promise<unknown>;
  label?: string;
  testIdBase?: string;
}) {
  const { data } = useListUsers({
    query: { queryKey: getListUsersQueryKey(), staleTime: 60_000 },
  });

  const options: ReadonlyArray<InlineSelectOption<string>> = useMemo(() => {
    const opts: InlineSelectOption<string>[] = (data ?? [])
      .filter(hasUsableIdentity)
      .map((u) => ({
        value: u.id,
        label: userDisplayName(u),
      }));
    opts.sort((a, b) => a.label.localeCompare(b.label));
    // If the current value isn't in the active users list (e.g. an
    // archived owner), surface it as an option (pinned at the top) so the
    // dropdown still reflects current state instead of silently dropping
    // to "None". We unshift AFTER sorting so it stays pinned.
    if (value && !opts.some((o) => o.value === value)) {
      opts.unshift({ value, label: `${value} (archived)` });
    }
    return opts;
  }, [data, value]);

  return (
    <InlineEditSelect
      label={label}
      testIdBase={testIdBase}
      value={value}
      display={display}
      options={options}
      onSave={onSave}
    />
  );
}
