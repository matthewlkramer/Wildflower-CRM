import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateEmail,
  useUpdateEmail,
  useDeleteEmail,
  useCreatePhoneNumber,
  useUpdatePhoneNumber,
  useDeletePhoneNumber,
  getGetPersonQueryKey,
  type Email,
  type PhoneNumber,
  type ContactValidity,
  type EmailType,
  type PhoneType,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { formatEnum } from "@/lib/format";
import { Pencil, Plus, Trash2 } from "lucide-react";

const VALIDITY_OPTIONS: { value: ContactValidity; label: string }[] = [
  { value: "valid", label: "Valid" },
  { value: "unknown", label: "Unknown" },
  { value: "invalid", label: "Invalid" },
];

const EMAIL_TYPE_OPTIONS: { value: EmailType; label: string }[] = [
  { value: "work", label: "Work" },
  { value: "personal", label: "Personal" },
  { value: "other", label: "Other" },
];

const PHONE_TYPE_OPTIONS: { value: PhoneType; label: string }[] = [
  { value: "mobile", label: "Mobile" },
  { value: "work", label: "Work" },
  { value: "home", label: "Home" },
  { value: "other", label: "Other" },
];

type EmailFormState = {
  email: string;
  type: EmailType | "";
  validity: ContactValidity;
  isPreferred: boolean;
};

type PhoneFormState = {
  phoneNumber: string;
  type: PhoneType | "";
  validity: ContactValidity;
  isPreferred: boolean;
};

const EMPTY_EMAIL: EmailFormState = {
  email: "",
  type: "",
  validity: "valid",
  isPreferred: false,
};

const EMPTY_PHONE: PhoneFormState = {
  phoneNumber: "",
  type: "",
  validity: "valid",
  isPreferred: false,
};

export function EmailsEditor({
  personId,
  emails,
}: {
  personId: string;
  emails: readonly Email[] | undefined;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editTarget, setEditTarget] = useState<Email | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Email | null>(null);
  const [form, setForm] = useState<EmailFormState>(EMPTY_EMAIL);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getGetPersonQueryKey(personId) });

  const create = useCreateEmail({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Email added" });
        setAdding(false);
        setForm(EMPTY_EMAIL);
      },
      onError: (e) =>
        toast({
          title: "Could not add email",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });
  const update = useUpdateEmail({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Email updated" });
        setEditTarget(null);
      },
      onError: (e) =>
        toast({
          title: "Could not update email",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });
  const del = useDeleteEmail({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Email removed" });
        setDeleteTarget(null);
      },
      onError: (e) =>
        toast({
          title: "Could not remove email",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });

  const openAdd = () => {
    setForm(EMPTY_EMAIL);
    setAdding(true);
  };
  const openEdit = (e: Email) => {
    setForm({
      email: e.email,
      type: (e.type ?? "") as EmailType | "",
      validity: e.validity,
      isPreferred: e.isPreferred,
    });
    setEditTarget(e);
  };
  const submit = () => {
    const trimmed = form.email.trim();
    if (!trimmed) return;
    if (editTarget) {
      update.mutate({
        id: editTarget.id,
        data: {
          email: trimmed,
          type: form.type === "" ? null : form.type,
          validity: form.validity,
          isPreferred: form.isPreferred,
        },
      });
    } else {
      create.mutate({
        data: {
          email: trimmed,
          ...(form.type ? { type: form.type } : {}),
          personId,
          validity: form.validity,
          isPreferred: form.isPreferred,
        },
      });
    }
  };

  const list = emails ?? [];
  const dialogOpen = adding || editTarget !== null;
  const closeDialog = () => {
    setAdding(false);
    setEditTarget(null);
    setForm(EMPTY_EMAIL);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="text-xs font-medium text-muted-foreground">Emails</div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={openAdd}
          data-testid="btn-add-email"
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add
        </Button>
      </div>
      {list.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {list.map((e) => (
            <li
              key={e.id}
              className="flex items-center justify-between gap-2 group"
              data-testid={`email-row-${e.id}`}
            >
              <span className="truncate">{e.email}</span>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-muted-foreground text-xs">
                  {e.isPreferred ? "preferred • " : ""}
                  {formatEnum(e.validity)}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100"
                  onClick={() => openEdit(e)}
                  data-testid={`btn-edit-email-${e.id}`}
                  aria-label="Edit email"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive"
                  onClick={() => setDeleteTarget(e)}
                  data-testid={`btn-delete-email-${e.id}`}
                  aria-label="Delete email"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No emails.</p>
      )}

      <Dialog
        open={dialogOpen}
        onOpenChange={(o) => {
          if (!o) closeDialog();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editTarget ? "Edit email" : "Add email"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 min-w-0">
            <div className="space-y-1.5">
              <Label htmlFor="email-input">Email</Label>
              <Input
                id="email-input"
                type="email"
                value={form.email}
                onChange={(ev) => setForm({ ...form, email: ev.target.value })}
                placeholder="name@example.org"
                data-testid="input-email"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Type</Label>
                <Select
                  value={form.type || "__none__"}
                  onValueChange={(v) =>
                    setForm({
                      ...form,
                      type: v === "__none__" ? "" : (v as EmailType),
                    })
                  }
                >
                  <SelectTrigger data-testid="select-email-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">—</SelectItem>
                    {EMAIL_TYPE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Validity</Label>
                <Select
                  value={form.validity}
                  onValueChange={(v) =>
                    setForm({ ...form, validity: v as ContactValidity })
                  }
                >
                  <SelectTrigger data-testid="select-email-validity">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VALIDITY_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={form.isPreferred}
                onCheckedChange={(v) =>
                  setForm({ ...form, isPreferred: v === true })
                }
                data-testid="checkbox-email-preferred"
              />
              Preferred email
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={
                !form.email.trim() || create.isPending || update.isPending
              }
              data-testid="btn-save-email"
            >
              {editTarget ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o && !del.isPending) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this email?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.email} will be removed from this person.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={del.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (deleteTarget) del.mutate({ id: deleteTarget.id });
              }}
              disabled={del.isPending}
              data-testid="btn-confirm-delete-email"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {del.isPending ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function PhoneNumbersEditor({
  personId,
  phoneNumbers,
}: {
  personId: string;
  phoneNumbers: readonly PhoneNumber[] | undefined;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editTarget, setEditTarget] = useState<PhoneNumber | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PhoneNumber | null>(null);
  const [form, setForm] = useState<PhoneFormState>(EMPTY_PHONE);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: getGetPersonQueryKey(personId) });

  const create = useCreatePhoneNumber({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Phone number added" });
        setAdding(false);
        setForm(EMPTY_PHONE);
      },
      onError: (e) =>
        toast({
          title: "Could not add phone number",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });
  const update = useUpdatePhoneNumber({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Phone number updated" });
        setEditTarget(null);
      },
      onError: (e) =>
        toast({
          title: "Could not update phone number",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });
  const del = useDeletePhoneNumber({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Phone number removed" });
        setDeleteTarget(null);
      },
      onError: (e) =>
        toast({
          title: "Could not remove phone number",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });

  const openAdd = () => {
    setForm(EMPTY_PHONE);
    setAdding(true);
  };
  const openEdit = (p: PhoneNumber) => {
    setForm({
      phoneNumber: p.phoneNumber,
      type: (p.type ?? "") as PhoneType | "",
      validity: p.validity,
      isPreferred: p.isPreferred,
    });
    setEditTarget(p);
  };
  const submit = () => {
    const trimmed = form.phoneNumber.trim();
    if (!trimmed) return;
    if (editTarget) {
      update.mutate({
        id: editTarget.id,
        data: {
          phoneNumber: trimmed,
          type: form.type === "" ? null : form.type,
          validity: form.validity,
          isPreferred: form.isPreferred,
        },
      });
    } else {
      create.mutate({
        data: {
          phoneNumber: trimmed,
          ...(form.type ? { type: form.type } : {}),
          personId,
          validity: form.validity,
          isPreferred: form.isPreferred,
        },
      });
    }
  };

  const list = phoneNumbers ?? [];
  const dialogOpen = adding || editTarget !== null;
  const closeDialog = () => {
    setAdding(false);
    setEditTarget(null);
    setForm(EMPTY_PHONE);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <div className="text-xs font-medium text-muted-foreground">
          Phone numbers
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={openAdd}
          data-testid="btn-add-phone"
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add
        </Button>
      </div>
      {list.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {list.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between gap-2 group"
              data-testid={`phone-row-${p.id}`}
            >
              <span className="truncate">
                {p.phoneNumber}
                {p.type ? (
                  <span className="text-muted-foreground text-xs ml-1">
                    ({formatEnum(p.type)})
                  </span>
                ) : null}
              </span>
              <div className="flex items-center gap-2 flex-shrink-0">
                <span className="text-muted-foreground text-xs">
                  {p.isPreferred ? "preferred • " : ""}
                  {formatEnum(p.validity)}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100"
                  onClick={() => openEdit(p)}
                  data-testid={`btn-edit-phone-${p.id}`}
                  aria-label="Edit phone number"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive"
                  onClick={() => setDeleteTarget(p)}
                  data-testid={`btn-delete-phone-${p.id}`}
                  aria-label="Delete phone number"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No phone numbers.</p>
      )}

      <Dialog
        open={dialogOpen}
        onOpenChange={(o) => {
          if (!o) closeDialog();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editTarget ? "Edit phone number" : "Add phone number"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 min-w-0">
            <div className="space-y-1.5">
              <Label htmlFor="phone-input">Phone number</Label>
              <Input
                id="phone-input"
                type="tel"
                value={form.phoneNumber}
                onChange={(ev) =>
                  setForm({ ...form, phoneNumber: ev.target.value })
                }
                placeholder="(555) 123-4567"
                data-testid="input-phone"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Type</Label>
                <Select
                  value={form.type || "__none__"}
                  onValueChange={(v) =>
                    setForm({
                      ...form,
                      type: v === "__none__" ? "" : (v as PhoneType),
                    })
                  }
                >
                  <SelectTrigger data-testid="select-phone-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">—</SelectItem>
                    {PHONE_TYPE_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Validity</Label>
                <Select
                  value={form.validity}
                  onValueChange={(v) =>
                    setForm({ ...form, validity: v as ContactValidity })
                  }
                >
                  <SelectTrigger data-testid="select-phone-validity">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {VALIDITY_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={form.isPreferred}
                onCheckedChange={(v) =>
                  setForm({ ...form, isPreferred: v === true })
                }
                data-testid="checkbox-phone-preferred"
              />
              Preferred phone
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={
                !form.phoneNumber.trim() ||
                create.isPending ||
                update.isPending
              }
              data-testid="btn-save-phone"
            >
              {editTarget ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => {
          if (!o && !del.isPending) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this phone number?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.phoneNumber} will be removed from this person.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={del.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                if (deleteTarget) del.mutate({ id: deleteTarget.id });
              }}
              disabled={del.isPending}
              data-testid="btn-confirm-delete-phone"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {del.isPending ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
