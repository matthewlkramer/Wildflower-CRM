import { createContext, useContext } from "react";

/**
 * Whether the desktop sidebar is collapsed to its icon-only rail. Lets content
 * (e.g. capped detail layouts) widen to use the freed-up space instead of just
 * recentering. Lives in its own module so the provider component and the hook
 * can be imported independently without React Fast Refresh export warnings.
 */
export const SidebarCollapsedContext = createContext<boolean>(false);

export function useSidebarCollapsed(): boolean {
  return useContext(SidebarCollapsedContext);
}
