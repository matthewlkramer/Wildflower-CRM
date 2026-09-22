import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  Camera,
  GripHorizontal,
  Loader2,
  MessageSquare,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  createAppFeedback,
  uploadFeedbackScreenshot,
  type FeedbackCategory,
  type FeedbackContext,
} from "@/lib/feedback-api";
import {
  captureFeedbackScreenshot,
  collectFeedbackContext,
} from "@/lib/feedback-capture";

export function FeedbackDialog() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [category, setCategory] = useState<FeedbackCategory>("bug");
  const [message, setMessage] = useState("");
  const [context, setContext] = useState<FeedbackContext | null>(null);
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [dialogOffset, setDialogOffset] = useState({ x: 0, y: 0 });
  const dialogRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  useEffect(() => {
    if (!screenshot) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(screenshot);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [screenshot]);

  const capture = async () => {
    setScreenshot(null);
    setScreenshotError(null);
    try {
      setScreenshot(await captureFeedbackScreenshot());
    } catch (error) {
      setScreenshotError(
        error instanceof Error ? error.message : "Screenshot capture failed.",
      );
    }
  };

  const beginFeedback = async () => {
    setPreparing(true);
    setContext(collectFeedbackContext());
    await capture();
    setDialogOffset({ x: 0, y: 0 });
    setOpen(true);
    setPreparing(false);
  };

  const moveDialog = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const dialog = dialogRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !dialog) return;

    const margin = 8;
    const width = dialog.offsetWidth;
    const height = dialog.offsetHeight;
    const centeredLeft = (window.innerWidth - width) / 2;
    const centeredTop = (window.innerHeight - height) / 2;
    const nextX = drag.originX + event.clientX - drag.startX;
    const nextY = drag.originY + event.clientY - drag.startY;

    setDialogOffset({
      x: Math.min(
        window.innerWidth - width - centeredLeft - margin,
        Math.max(margin - centeredLeft, nextX),
      ),
      y: Math.min(
        window.innerHeight - height - centeredTop - margin,
        Math.max(margin - centeredTop, nextY),
      ),
    });
  };

  const stopDragging = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
  };

  const reset = () => {
    setCategory("bug");
    setMessage("");
    setContext(null);
    setScreenshot(null);
    setScreenshotError(null);
  };

  const submit = async () => {
    if (!context || !message.trim()) return;
    setSubmitting(true);
    let screenshotUrl: string | null = null;
    let finalScreenshotError = screenshotError;
    let screenshotStatus: "captured" | "failed" | "skipped" = screenshot
      ? "captured"
      : screenshotError
        ? "failed"
        : "skipped";
    if (screenshot) {
      try {
        screenshotUrl = await uploadFeedbackScreenshot(screenshot);
      } catch (error) {
        screenshotStatus = "failed";
        finalScreenshotError =
          error instanceof Error ? error.message : "Screenshot upload failed.";
      }
    }

    try {
      await createAppFeedback({
        category,
        message: message.trim(),
        pageUrl: context.url,
        pagePath: `${context.pathname}${context.search}${context.hash}`,
        pageTitle: context.pageTitle || null,
        context,
        screenshotUrl,
        screenshotFilename: screenshotUrl ? (screenshot?.name ?? null) : null,
        screenshotStatus,
        screenshotError: finalScreenshotError,
      });
      setOpen(false);
      reset();
      toast({
        title: "Feedback submitted",
        description: screenshotUrl
          ? "Your note, page state, and screenshot were saved."
          : "Your note and page state were saved.",
      });
    } catch (error) {
      toast({
        title: "Could not submit feedback",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => void beginFeedback()}
        disabled={preparing}
        data-feedback-ignore
        data-testid="button-feedback"
      >
        {preparing ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <MessageSquare className="mr-2 h-4 w-4" />
        )}
        Feedback
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next && !submitting) reset();
        }}
      >
        <DialogContent
          ref={dialogRef}
          className="max-h-[calc(100dvh-2rem)] max-w-2xl overflow-y-auto"
          overlayClassName="bg-black/20 backdrop-blur-none"
          style={{
            transform: `translate(calc(-50% + ${dialogOffset.x}px), calc(-50% + ${dialogOffset.y}px))`,
          }}
          data-feedback-ignore
        >
          <DialogHeader
            className="-mx-6 -mt-6 cursor-grab select-none rounded-t-lg border-b bg-muted/35 px-6 py-4 pr-12 active:cursor-grabbing"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              dragRef.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                originX: dialogOffset.x,
                originY: dialogOffset.y,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={moveDialog}
            onPointerUp={stopDragging}
            onPointerCancel={stopDragging}
            style={{ touchAction: "none" }}
            data-testid="feedback-dialog-drag-handle"
          >
            <div className="flex items-center gap-2">
              <GripHorizontal
                className="h-4 w-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <DialogTitle>Send feedback</DialogTitle>
              <span className="ml-auto text-xs font-medium text-muted-foreground">
                Drag to move
              </span>
            </div>
            <DialogDescription>
              Describe the issue or question. A private screenshot and the
              current page state are included when available, stored in the
              CRM’s private object storage, and added to the administrator
              review queue.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Type</Label>
              <Select
                value={category}
                onValueChange={(value) =>
                  setCategory(value as FeedbackCategory)
                }
              >
                <SelectTrigger data-testid="select-feedback-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bug">Something is not working</SelectItem>
                  <SelectItem value="question">Question</SelectItem>
                  <SelectItem value="suggestion">Suggestion</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="feedback-message">Issue or question</Label>
              <Textarea
                id="feedback-message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder="What were you trying to do, and what happened?"
                rows={6}
                maxLength={10_000}
                autoFocus
                data-testid="textarea-feedback-message"
              />
            </div>

            <div className="rounded-lg border bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Current-page screenshot</p>
                  <p className="text-xs text-muted-foreground">
                    Captured before this dialog opened.
                  </p>
                </div>
                {screenshot ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setScreenshot(null);
                      setScreenshotError(null);
                    }}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Remove
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void capture()}
                  >
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Try capture
                  </Button>
                )}
              </div>
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt="Feedback screenshot preview"
                  className="mt-3 max-h-64 w-full rounded border object-contain"
                />
              ) : screenshotError ? (
                <p className="mt-3 text-xs text-amber-700">
                  <Camera className="mr-1 inline h-3.5 w-3.5" />
                  Screenshot unavailable: {screenshotError}
                </p>
              ) : (
                <p className="mt-3 text-xs text-muted-foreground">
                  No screenshot will be included.
                </p>
              )}
            </div>

            {context ? (
              <p className="text-xs text-muted-foreground">
                Page: <span className="font-mono">{context.pathname}</span> ·
                viewport {context.viewport.width}×{context.viewport.height}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void submit()}
              disabled={submitting || !message.trim() || !context}
              data-testid="button-submit-feedback"
            >
              {submitting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Submit feedback
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
