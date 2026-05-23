import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-serif font-bold text-foreground">{title}</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Pending rewrite</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          This page is being rebuilt against the new schema. See the funders
          list and detail pages for the template the rewrite will follow.
        </CardContent>
      </Card>
    </div>
  );
}
