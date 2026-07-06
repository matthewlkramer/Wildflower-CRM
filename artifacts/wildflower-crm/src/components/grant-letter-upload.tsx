import { useRef, useState } from "react";
import { Upload, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

interface FileUploadFieldProps {
  url: string | null;
  filename: string | null;
  onUploaded: (next: { url: string; filename: string }) => void;
  onCleared: () => void;
  disabled?: boolean;
  // Button label when there is no file yet (e.g. "Upload grant letter").
  uploadLabel?: string;
  toastTitle?: string;
  // Prefix for data-testid hooks so multiple uploaders on one page stay unique.
  testIdBase?: string;
}

export function FileUploadField({
  url,
  filename,
  onUploaded,
  onCleared,
  disabled,
  uploadLabel = "Upload file",
  toastTitle = "File uploaded",
  testIdBase = "grant-letter",
}: FileUploadFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const { toast } = useToast();

  const handleFile = async (file: File) => {
    setIsUploading(true);
    try {
      const reqRes = await fetch("/api/storage/uploads/request-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: file.name,
          size: file.size,
          contentType: file.type || "application/octet-stream",
        }),
      });
      if (!reqRes.ok) throw new Error(`Upload URL request failed: ${reqRes.status}`);
      const { uploadURL, objectPath } = (await reqRes.json()) as {
        uploadURL: string;
        objectPath: string;
      };

      const putRes = await fetch(uploadURL, {
        method: "PUT",
        headers: { "Content-Type": file.type || "application/octet-stream" },
        body: file,
      });
      if (!putRes.ok) throw new Error(`Upload failed: ${putRes.status}`);

      onUploaded({
        url: `/api/storage${objectPath}`,
        filename: file.name,
      });
      toast({ title: toastTitle, description: file.name });
    } catch (err) {
      toast({
        title: "Upload failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  if (url) {
    return (
      <div className="flex items-center gap-2">
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-primary hover:underline truncate max-w-[240px]"
          data-testid={`${testIdBase}-link`}
        >
          {filename ?? "View file"}
        </a>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          disabled={disabled || isUploading}
          onClick={() => onCleared()}
          aria-label="Remove file"
          data-testid={`${testIdBase}-clear`}
        >
          <X className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || isUploading}
          onClick={() => inputRef.current?.click()}
          data-testid={`${testIdBase}-replace`}
        >
          {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Replace"}
        </Button>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          accept="application/pdf,image/*,.doc,.docx"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={disabled || isUploading}
        onClick={() => inputRef.current?.click()}
        data-testid={`${testIdBase}-upload`}
      >
        {isUploading ? (
          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        ) : (
          <Upload className="h-4 w-4 mr-2" />
        )}
        {isUploading ? "Uploading…" : uploadLabel}
      </Button>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept="application/pdf,image/*,.doc,.docx"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
        }}
      />
    </div>
  );
}
