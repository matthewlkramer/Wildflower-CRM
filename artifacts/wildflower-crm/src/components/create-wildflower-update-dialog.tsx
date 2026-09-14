import { useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { 
  useCreateWildflowerUpdateItem, 
  getListWildflowerUpdateItemsQueryKey,
  getListRelevantWildflowerUpdateItemsQueryKey,
  WildflowerUpdateEventDate,
  WildflowerUpdateStatus,
  WildflowerUpdatePreparationStatus,
  CreateWildflowerUpdateItemBody,
  WildflowerUpdateSourceType
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AddIconButton } from "@/components/add-icon-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WildflowerUpdatePrecisionDateInput } from "./wildflower-update-precision-date";
import { formatEnum } from "@/lib/format";

export function CreateWildflowerUpdateDialog({ children }: { children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const create = useCreateWildflowerUpdateItem();

  const [title, setTitle] = useState("");
  const [details, setDetails] = useState("");
  const [status, setStatus] = useState<WildflowerUpdateStatus>("completed");
  const [prepStatus, setPrepStatus] = useState<WildflowerUpdatePreparationStatus>("eligible");
  const [eventDate, setEventDate] = useState<WildflowerUpdateEventDate>({ precision: "unknown" });

  const [sourceTitle, setSourceTitle] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceType, setSourceType] = useState<WildflowerUpdateSourceType>("published_article");
  const [sourceDate, setSourceDate] = useState<WildflowerUpdateEventDate>({ precision: "unknown" });

  const reset = () => {
    setTitle("");
    setDetails("");
    setStatus("completed");
    setPrepStatus("eligible");
    setEventDate({ precision: "unknown" });
    setSourceTitle("");
    setSourceUrl("");
    setSourceType("published_article");
    setSourceDate({ precision: "unknown" });
  };

  const onOpenChange = (val: boolean) => {
    setOpen(val);
    if (!val) reset();
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !details.trim()) {
      toast({ title: "Validation error", description: "Title and details are required.", variant: "destructive" });
      return;
    }
    if (!sourceTitle.trim() || !sourceUrl.trim()) {
      toast({ title: "Validation error", description: "Source title and URL are required.", variant: "destructive" });
      return;
    }
    
    const body: CreateWildflowerUpdateItemBody = {
      title,
      details,
      status,
      preparationStatus: prepStatus,
      eventDate,
      sources: [{
        title: sourceTitle,
        url: sourceUrl,
        sourceType,
        publicationDatePrecision: sourceDate.precision,
        publicationDate: sourceDate.startDate || null,
        publicationEndDate: sourceDate.endDate || null,
        publicationYear: sourceDate.year || null,
        publicationMonth: sourceDate.month || null,
        publicationSeason: sourceDate.season || null,
        publicationStartYear: (sourceDate as any).startYear || null,
        publicationStartMonth: (sourceDate as any).startMonth || null,
        publicationEndYear: (sourceDate as any).endYear || null,
        publicationEndMonth: (sourceDate as any).endMonth || null
      } as any],
      relatedLinks: [],
      thematicTags: [],
      ageTags: [],
      governanceTags: [],
      fundingRegionIds: []
    };

    create.mutate(
      { data: body },
      {
        onSuccess: (res) => {
          queryClient.invalidateQueries({ queryKey: getListWildflowerUpdateItemsQueryKey() });
          queryClient.invalidateQueries({ queryKey: getListRelevantWildflowerUpdateItemsQueryKey() });
          toast({ title: "Update created successfully" });
          setOpen(false);
          reset();
          navigate(`/wildflower-updates/${res.id}`);
        },
        onError: (err) => {
          toast({
            title: "Failed to create update",
            description: err instanceof Error ? err.message : String(err),
            variant: "destructive",
          });
        }
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        {children || <AddIconButton label="New Update" />}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
        <form onSubmit={handleSave}>
          <DialogHeader>
            <DialogTitle>New Wildflower Update</DialogTitle>
            <DialogDescription>
              Record progress, news, or work in progress.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="wu-title">Title</Label>
              <Input
                id="wu-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={create.isPending}
                required
              />
            </div>
            
            <div className="grid gap-2">
              <Label htmlFor="wu-details">Details (One paragraph)</Label>
              <Textarea
                id="wu-details"
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                disabled={create.isPending}
                required
                className="h-24"
              />
            </div>

            <div className="grid gap-2">
              <Label>Event Date</Label>
              <WildflowerUpdatePrecisionDateInput 
                value={eventDate}
                onChange={setEventDate}
                disabled={create.isPending}
              />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Status</Label>
                <Select disabled={create.isPending} value={status} onValueChange={(v) => setStatus(v as WildflowerUpdateStatus)}>
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
                <Label>Preparation</Label>
                <Select disabled={create.isPending} value={prepStatus} onValueChange={(v) => setPrepStatus(v as WildflowerUpdatePreparationStatus)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="eligible">Eligible</SelectItem>
                    <SelectItem value="hold_for_confirmation">Hold for confirmation</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="border-t pt-4 mt-2">
              <h4 className="text-sm font-medium mb-4">Primary Source (Required)</h4>
              <div className="grid gap-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label htmlFor="wu-source-title">Source Title</Label>
                    <Input
                      id="wu-source-title"
                      value={sourceTitle}
                      onChange={(e) => setSourceTitle(e.target.value)}
                      disabled={create.isPending}
                      required
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label>Source Type</Label>
                    <Select disabled={create.isPending} value={sourceType} onValueChange={(v) => setSourceType(v as WildflowerUpdateSourceType)}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="sent_newsletter">Sent Newsletter</SelectItem>
                        <SelectItem value="published_article">Published Article</SelectItem>
                        <SelectItem value="donor_proposal">Donor Proposal</SelectItem>
                        <SelectItem value="draft">Draft</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="wu-source-url">Source URL</Label>
                  <Input
                    id="wu-source-url"
                    value={sourceUrl}
                    onChange={(e) => setSourceUrl(e.target.value)}
                    disabled={create.isPending}
                    required
                  />
                </div>

                <div className="grid gap-2">
                  <Label>Publication Date</Label>
                  <WildflowerUpdatePrecisionDateInput 
                    value={sourceDate}
                    onChange={setSourceDate}
                    disabled={create.isPending}
                  />
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
