import { UnifiedActivityFeed } from "@/components/unified-activity-feed";

export default function ActivityFeed() {
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div>
        <h1 className="font-serif text-2xl font-semibold">Feed</h1>
        <p className="text-sm text-muted-foreground">
          Scan the latest CRM activity, including synced email summaries,
          meetings, notes, and other relationship updates.
        </p>
      </div>
      <UnifiedActivityFeed global />
    </div>
  );
}
