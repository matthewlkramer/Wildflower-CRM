import { useState, useRef, useEffect } from "react";
import { useRoute, useLocation, Link } from "wouter";
import { format } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import { 
  useGetWildflowerUpdateItem, 
  useUpdateWildflowerUpdateItem,
  useArchiveWildflowerUpdateItem,
  useUnarchiveWildflowerUpdateItem,
  getGetWildflowerUpdateItemQueryKey,
  getListWildflowerUpdateItemsQueryKey,
  getListRelevantWildflowerUpdateItemsQueryKey,
  WildflowerUpdateItem,
  CreateWildflowerUpdateSourceBody,
  CreateWildflowerUpdateRelatedLinkBody,
  WildflowerUpdateStatus,
  WildflowerUpdatePreparationStatus,
  WildflowerUpdateSourceType,
  WildflowerUpdateEventDate
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { WildflowerUpdatePrecisionDateInput } from "@/components/wildflower-update-precision-date";
import { InlineEditInterestsThematic, InlineEditInterestsAges, InlineEditInterestsGovModels, InlineEditMultiRegionPicker } from "@/components/multi-select-picker";
import { formatEnum } from "@/lib/format";
import { ArrowLeft, Plus, Trash2, ExternalLink, Archive, ArchiveRestore } from "lucide-react";
import { formatUpdateDate } from "./wildflower-updates";
import { SkeletonRows } from "@/components/ui/skeleton";

export default function WildflowerUpdateDetail() {
  const [, params] = useRoute("/wildflower-updates/:id");
  const id = params?.id;
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: item, isLoading, isError, error } = useGetWildflowerUpdateItem(id ?? "", {
    query: { queryKey: getGetWildflowerUpdateItemQueryKey(id ?? ""), enabled: !!id }
  });

  const updateMut = useUpdateWildflowerUpdateItem();
  const archiveMut = useArchiveWildflowerUpdateItem();
  const unarchiveMut = useUnarchiveWildflowerUpdateItem();

  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<WildflowerUpdateItem>>({});
  
  // Update state when item loads and we're not editing
  useEffect(() => {
    if (item && !isEditing) {
      setDraft(item);
    }
  }, [item, isEditing]);

  if (isLoading) return <div className="p-8"><SkeletonRows rows={10} cols={1} /></div>;
  if (isError || !item) return <div className="p-8 text-destructive">Failed to load update: {String(error)}</div>;

  const handleSave = () => {
    if (!id) return;
    updateMut.mutate({
      id,
      data: {
        title: draft.title,
        details: draft.details,
        status: draft.status,
        preparationStatus: draft.preparationStatus,
        eventDate: draft.eventDate,
        sources: draft.sources as CreateWildflowerUpdateSourceBody[],
        relatedLinks: draft.relatedLinks as CreateWildflowerUpdateRelatedLinkBody[],
        thematicTags: draft.thematicTags,
        ageTags: draft.ageTags,
        governanceTags: draft.governanceTags,
        fundingRegionIds: draft.fundingRegionIds
      }
    }, {
      onSuccess: () => {
        toast({ title: "Update saved" });
        setIsEditing(false);
        queryClient.invalidateQueries({ queryKey: getGetWildflowerUpdateItemQueryKey(id) });
        queryClient.invalidateQueries({ queryKey: getListWildflowerUpdateItemsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListRelevantWildflowerUpdateItemsQueryKey() });
      },
      onError: (err) => toast({ title: "Failed to save", description: String(err), variant: "destructive" })
    });
  };

  const handleArchive = () => {
    archiveMut.mutate({ id: item.id }, {
      onSuccess: () => {
        toast({ title: "Update archived" });
        queryClient.invalidateQueries({ queryKey: getGetWildflowerUpdateItemQueryKey(item.id) });
        queryClient.invalidateQueries({ queryKey: getListWildflowerUpdateItemsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListRelevantWildflowerUpdateItemsQueryKey() });
      },
      onError: (err) => toast({ title: "Archive failed", description: String(err), variant: "destructive" })
    });
  };

  const handleUnarchive = () => {
    unarchiveMut.mutate({ id: item.id }, {
      onSuccess: () => {
        toast({ title: "Update restored" });
        queryClient.invalidateQueries({ queryKey: getGetWildflowerUpdateItemQueryKey(item.id) });
        queryClient.invalidateQueries({ queryKey: getListWildflowerUpdateItemsQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListRelevantWildflowerUpdateItemsQueryKey() });
      },
      onError: (err) => toast({ title: "Restore failed", description: String(err), variant: "destructive" })
    });
  };

  const addSource = () => {
    setDraft(d => ({
      ...d, 
      sources: [...(d.sources || []), {
        title: "",
        url: "",
        sourceType: "draft",
        publicationDatePrecision: "unknown"
      } as any]
    }));
  };

  const updateSource = (idx: number, patch: Partial<CreateWildflowerUpdateSourceBody>) => {
    setDraft(d => {
      const newSources = [...(d.sources || [])];
      newSources[idx] = { ...newSources[idx], ...patch } as any;
      return { ...d, sources: newSources };
    });
  };

  const removeSource = (idx: number) => {
    setDraft(d => ({ ...d, sources: (d.sources || []).filter((_, i) => i !== idx) as any }));
  };

  const addLink = () => {
    setDraft(d => ({
      ...d,
      relatedLinks: [...(d.relatedLinks || []), { title: "", url: "" } as any]
    }));
  };

  const updateLink = (idx: number, patch: Partial<CreateWildflowerUpdateRelatedLinkBody>) => {
    setDraft(d => {
      const newLinks = [...(d.relatedLinks || [])];
      newLinks[idx] = { ...newLinks[idx], ...patch } as any;
      return { ...d, relatedLinks: newLinks };
    });
  };

  const removeLink = (idx: number) => {
    setDraft(d => ({ ...d, relatedLinks: (d.relatedLinks || []).filter((_, i) => i !== idx) as any }));
  };

  const handleTagSave = (field: keyof WildflowerUpdateItem) => async (val: string[] | null) => {
    await updateMut.mutateAsync({ id: item.id, data: { [field]: val || [] } });
    queryClient.invalidateQueries({ queryKey: getGetWildflowerUpdateItemQueryKey(item.id) });
    queryClient.invalidateQueries({ queryKey: getListWildflowerUpdateItemsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListRelevantWildflowerUpdateItemsQueryKey() });
  };

  return (
    <div className="flex flex-col gap-6 max-w-4xl mx-auto pb-12">
      <div className="flex items-center gap-4 border-b pb-4 mt-4">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/wildflower-updates"><ArrowLeft className="h-4 w-4" /></Link>
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold truncate tracking-tight">{item.title}</h1>
          <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
            {formatUpdateDate(item.eventDate)}
            <span>&bull;</span>
            <span className="capitalize">{formatEnum(item.status)}</span>
            {item.archivedAt && <Badge variant="secondary">Archived</Badge>}
            {item.preparationStatus === 'hold_for_confirmation' && <Badge variant="outline" className="text-amber-600 border-amber-600">Held from donors</Badge>}
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            Added {format(new Date(item.createdAt), "MMM d, yyyy")} &bull; Last updated {format(new Date(item.updatedAt), "MMM d, yyyy")}
          </div>
        </div>
        <div className="flex gap-2">
          {item.archivedAt ? (
            <Button variant="outline" onClick={handleUnarchive} disabled={unarchiveMut.isPending}>
              <ArchiveRestore className="h-4 w-4 mr-2" /> Restore
            </Button>
          ) : (
            <Button variant="outline" onClick={handleArchive} disabled={archiveMut.isPending}>
              <Archive className="h-4 w-4 mr-2" /> Archive
            </Button>
          )}
          {isEditing ? (
            <>
              <Button variant="ghost" onClick={() => { setIsEditing(false); setDraft(item); }}>Cancel</Button>
              <Button onClick={handleSave} disabled={updateMut.isPending}>Save</Button>
            </>
          ) : (
            <Button onClick={() => setIsEditing(true)}>Edit Details</Button>
          )}
        </div>
      </div>

      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Core Information</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4">
            {isEditing ? (
              <>
                <div className="grid gap-2">
                  <Label>Title</Label>
                  <Input value={draft.title ?? ""} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} />
                </div>
                <div className="grid gap-2">
                  <Label>Details (One paragraph)</Label>
                  <Textarea value={draft.details ?? ""} onChange={e => setDraft(d => ({ ...d, details: e.target.value }))} className="h-24" />
                </div>
                <div className="grid md:grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label>Event Date</Label>
                    <WildflowerUpdatePrecisionDateInput 
                      value={draft.eventDate as WildflowerUpdateEventDate} 
                      onChange={v => setDraft(d => ({ ...d, eventDate: v as WildflowerUpdateEventDate }))}
                    />
                  </div>
                  <div className="flex flex-col gap-4">
                    <div className="grid gap-2">
                      <Label>Status</Label>
                      <Select value={draft.status} onValueChange={(v) => setDraft(d => ({ ...d, status: v as WildflowerUpdateStatus }))}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="completed">Completed</SelectItem>
                          <SelectItem value="reported_progress">Reported Progress</SelectItem>
                          <SelectItem value="work_in_progress">Work in Progress</SelectItem>
                          <SelectItem value="proposed_work">Proposed Work</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-2">
                      <Label>Preparation Status</Label>
                      <Select value={draft.preparationStatus} onValueChange={(v) => setDraft(d => ({ ...d, preparationStatus: v as WildflowerUpdatePreparationStatus }))}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="eligible">Eligible</SelectItem>
                          <SelectItem value="hold_for_confirmation">Hold for confirmation</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">Held items are excluded from automatic donor preparation.</p>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div className="prose prose-sm max-w-none text-foreground">
                <p className="whitespace-pre-wrap">{item.details}</p>
              </div>
            )}
          </CardContent>
        </Card>

        {!isEditing && (
          <Card>
            <CardHeader>
              <CardTitle>Tags & Regions</CardTitle>
              <CardDescription>Inline editable</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <div className="grid sm:grid-cols-2 gap-x-8 gap-y-6">
                <div>
                  <h4 className="text-sm font-medium text-muted-foreground mb-2">Thematic Interests</h4>
                  <InlineEditInterestsThematic value={item.thematicTags ?? []} onSave={handleTagSave("thematicTags")} testIdBase="tags-thematic" />
                </div>
                <div>
                  <h4 className="text-sm font-medium text-muted-foreground mb-2">Age Groups</h4>
                  <InlineEditInterestsAges value={item.ageTags ?? []} onSave={handleTagSave("ageTags")} testIdBase="tags-ages" />
                </div>
                <div>
                  <h4 className="text-sm font-medium text-muted-foreground mb-2">Governance Models</h4>
                  <InlineEditInterestsGovModels value={item.governanceTags ?? []} onSave={handleTagSave("governanceTags")} testIdBase="tags-gov" />
                </div>
                <div>
                  <h4 className="text-sm font-medium text-muted-foreground mb-2">Funding Regions</h4>
                  <InlineEditMultiRegionPicker value={item.fundingRegionIds ?? []} onSave={handleTagSave("fundingRegionIds")} context="interest" testIdBase="tags-regions" />
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Sources</CardTitle>
            {isEditing && (
              <Button size="sm" variant="outline" onClick={addSource}><Plus className="h-4 w-4 mr-2" /> Add Source</Button>
            )}
          </CardHeader>
          <CardContent>
            {isEditing ? (
              <div className="grid gap-4">
                {draft.sources?.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">No sources added.</p>}
                {draft.sources?.map((src: any, idx: number) => (
                  <div key={idx} className="border rounded-md p-4 bg-muted/20 relative">
                    <Button variant="ghost" size="icon" className="absolute top-2 right-2 text-destructive" onClick={() => removeSource(idx)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                    <div className="grid sm:grid-cols-2 gap-4">
                      <div className="grid gap-2">
                        <Label>Title</Label>
                        <Input value={src.title} onChange={e => updateSource(idx, { title: e.target.value })} />
                      </div>
                      <div className="grid gap-2">
                        <Label>Type</Label>
                        <Select value={src.sourceType} onValueChange={(v) => updateSource(idx, { sourceType: v as WildflowerUpdateSourceType })}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="sent_newsletter">Sent Newsletter</SelectItem>
                            <SelectItem value="published_article">Published Article</SelectItem>
                            <SelectItem value="donor_proposal">Donor Proposal</SelectItem>
                            <SelectItem value="draft">Draft</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="grid gap-2 sm:col-span-2">
                        <Label>URL</Label>
                        <Input value={src.url} onChange={e => updateSource(idx, { url: e.target.value })} />
                      </div>
                      <div className="grid gap-2 sm:col-span-2">
                        <Label>Publication Date</Label>
                        <WildflowerUpdatePrecisionDateInput 
                          value={{ 
                            precision: src.publicationDatePrecision, 
                            startDate: src.publicationDate, 
                            endDate: src.publicationEndDate, 
                            year: src.publicationYear, 
                            month: src.publicationMonth, 
                            season: src.publicationSeason,
                            startYear: src.publicationStartYear,
                            startMonth: src.publicationStartMonth,
                            endYear: src.publicationEndYear,
                            endMonth: src.publicationEndMonth
                          } as WildflowerUpdateEventDate} 
                          onChange={(v) => updateSource(idx, {
                            publicationDatePrecision: v.precision,
                            publicationDate: v.startDate,
                            publicationEndDate: v.endDate,
                            publicationYear: v.year,
                            publicationMonth: v.month,
                            publicationSeason: v.season,
                            publicationStartYear: (v as any).startYear,
                            publicationStartMonth: (v as any).startMonth,
                            publicationEndYear: (v as any).endYear,
                            publicationEndMonth: (v as any).endMonth
                          } as any)}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid gap-3">
                {item.sources?.length === 0 && <p className="text-sm text-muted-foreground">No sources added.</p>}
                {item.sources?.map((src: any) => (
                  <div key={src.id} className="flex flex-col gap-1 border-b last:border-0 pb-3 last:pb-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{src.title}</span>
                      <Badge variant="outline" className="text-[10px]">{formatEnum(src.sourceType)}</Badge>
                    </div>
                    {src.url && (
                      <a href={src.url} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline flex items-center gap-1 w-fit">
                        {src.url} <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {formatUpdateDate({
                        precision: src.publicationDatePrecision,
                        startDate: src.publicationDate,
                        endDate: src.publicationEndDate,
                        year: src.publicationYear,
                        month: src.publicationMonth,
                        season: src.publicationSeason,
                        startYear: src.publicationStartYear,
                        startMonth: src.publicationStartMonth,
                        endYear: src.publicationEndYear,
                        endMonth: src.publicationEndMonth
                      } as WildflowerUpdateEventDate)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Related Links</CardTitle>
            {isEditing && (
              <Button size="sm" variant="outline" onClick={addLink}><Plus className="h-4 w-4 mr-2" /> Add Link</Button>
            )}
          </CardHeader>
          <CardContent>
            {isEditing ? (
              <div className="grid gap-3">
                {draft.relatedLinks?.length === 0 && <p className="text-sm text-muted-foreground text-center py-2">No links added.</p>}
                {draft.relatedLinks?.map((link: any, idx: number) => (
                  <div key={idx} className="flex items-end gap-2">
                    <div className="grid gap-1 flex-1">
                      <Label>Title</Label>
                      <Input value={link.title} onChange={e => updateLink(idx, { title: e.target.value })} />
                    </div>
                    <div className="grid gap-1 flex-[2]">
                      <Label>URL</Label>
                      <Input value={link.url} onChange={e => updateLink(idx, { url: e.target.value })} />
                    </div>
                    <Button variant="ghost" size="icon" className="text-destructive mb-0.5" onClick={() => removeLink(idx)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <ul className="list-disc list-inside space-y-1 ml-4">
                {item.relatedLinks?.length === 0 && <p className="text-sm text-muted-foreground -ml-4">No related links.</p>}
                {item.relatedLinks?.map((link: any) => (
                  <li key={link.id} className="text-sm">
                    <a href={link.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                      {link.title || link.url}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

      </div>
    </div>
  );
}
