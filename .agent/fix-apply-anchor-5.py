from pathlib import Path

path = Path(".agent/apply-workbench-usability.py")
text = path.read_text(encoding="utf-8")
old = """page = replace_once(
    page,
    '''  const { data: recentData, isLoading: recentLoading } = useListWorkbenchRecentChanges();''',
    '''  const { data: recentData, isLoading: recentLoading } = useListWorkbenchRecentChanges({
    query: { refetchInterval: 5000, refetchOnWindowFocus: true },
  });''',
    "recent changes polling",
)"""
new = """page = replace_once(
    page,
    '''  const { data: recentData, isLoading: recentLoading } = useListWorkbenchRecentChanges();''',
    '''  const { data: recentData, isLoading: recentLoading } = useListWorkbenchRecentChanges();
  useEffect(() => {
    const refreshRecent = () => {
      void queryClient.invalidateQueries({
        queryKey: getListWorkbenchRecentChangesQueryKey(),
      });
    };
    const timer = window.setInterval(refreshRecent, 5000);
    window.addEventListener("focus", refreshRecent);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshRecent);
    };
  }, [queryClient]);''',
    "recent changes polling",
)"""
if old not in text:
    raise SystemExit("recent polling patch source not found")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
