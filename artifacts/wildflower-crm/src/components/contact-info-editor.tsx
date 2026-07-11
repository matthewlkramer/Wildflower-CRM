import { useState } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import {
  useCreateEmail,
  useUpdateEmail,
  useDeleteEmail,
  useCreatePhoneNumber,
  useUpdatePhoneNumber,
  useDeletePhoneNumber,
  useCreateAddress,
  useUpdateAddress,
  useDeleteAddress,
  getGetPersonQueryKey,
  getGetOrganizationQueryKey,
  type Email,
  type PhoneNumber,
  type Address,
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

/**
 * Contact records (emails / phones / addresses) belong to exactly one owner —
 * a person or a funder (DB-enforced num_nonnulls(...) = 1). The editors take an
 * owner so the same UI works on both the individual- and funder-detail pages:
 * the owner decides which FK to send on create and which detail query to refetch.
 */
export type ContactOwner =
  | { kind: "person"; id: string }
  | { kind: "organization"; id: string };

function ownerCreateField(owner: ContactOwner): { personId: string } | { organizationId: string } {
  return owner.kind === "person"
    ? { personId: owner.id }
    : { organizationId: owner.id };
}

function ownerQueryKey(owner: ContactOwner): QueryKey {
  return owner.kind === "person"
    ? getGetPersonQueryKey(owner.id)
    : getGetOrganizationQueryKey(owner.id);
}

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

type AddressFormState = {
  street: string;
  cityName: string;
  stateCode: string;
  postalCode: string;
  country: string;
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

const EMPTY_ADDRESS: AddressFormState = {
  street: "",
  cityName: "",
  stateCode: "",
  postalCode: "",
  country: "",
};

export function EmailsEditor({
  owner,
  emails,
}: {
  owner: ContactOwner;
  emails: readonly Email[] | undefined;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editTarget, setEditTarget] = useState<Email | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Email | null>(null);
  const [form, setForm] = useState<EmailFormState>(EMPTY_EMAIL);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ownerQueryKey(owner) });

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
          ...ownerCreateField(owner),
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
      <div className="flex items-center justify-end mb-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={openAdd}
          data-testid="btn-add-email"
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add email
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
              {deleteTarget?.email} will be removed.
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
  owner,
  phoneNumbers,
}: {
  owner: ContactOwner;
  phoneNumbers: readonly PhoneNumber[] | undefined;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editTarget, setEditTarget] = useState<PhoneNumber | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PhoneNumber | null>(null);
  const [form, setForm] = useState<PhoneFormState>(EMPTY_PHONE);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ownerQueryKey(owner) });

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
          ...ownerCreateField(owner),
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
      <div className="flex items-center justify-end mb-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={openAdd}
          data-testid="btn-add-phone"
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add phone
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
              {deleteTarget?.phoneNumber} will be removed.
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

function formatAddress(a: Address): string {
  return (
    [a.street, a.cityName, a.stateCode, a.postalCode, a.country]
      .filter(Boolean)
      .join(", ") || "—"
  );
}

export function AddressesEditor({
  owner,
  addresses,
}: {
  owner: ContactOwner;
  addresses: readonly Address[] | undefined;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editTarget, setEditTarget] = useState<Address | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Address | null>(null);
  const [form, setForm] = useState<AddressFormState>(EMPTY_ADDRESS);

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ownerQueryKey(owner) });

  const create = useCreateAddress({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Address added" });
        setAdding(false);
        setForm(EMPTY_ADDRESS);
      },
      onError: (e) =>
        toast({
          title: "Could not add address",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });
  const update = useUpdateAddress({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Address updated" });
        setEditTarget(null);
      },
      onError: (e) =>
        toast({
          title: "Could not update address",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });
  const del = useDeleteAddress({
    mutation: {
      onSuccess: () => {
        invalidate();
        toast({ title: "Address removed" });
        setDeleteTarget(null);
      },
      onError: (e) =>
        toast({
          title: "Could not remove address",
          description: e instanceof Error ? e.message : "Unknown error",
          variant: "destructive",
        }),
    },
  });

  const openAdd = () => {
    setForm(EMPTY_ADDRESS);
    setAdding(true);
  };
  const openEdit = (a: Address) => {
    setForm({
      street: a.street ?? "",
      cityName: a.cityName ?? "",
      stateCode: a.stateCode ?? "",
      postalCode: a.postalCode ?? "",
      country: a.country ?? "",
    });
    setEditTarget(a);
  };
  const isEmptyForm =
    !form.street.trim() &&
    !form.cityName.trim() &&
    !form.stateCode.trim() &&
    !form.postalCode.trim() &&
    !form.country.trim();
  const submit = () => {
    if (isEmptyForm) return;
    const fields = {
      street: form.street.trim() || null,
      cityName: form.cityName.trim() || null,
      stateCode: form.stateCode.trim() || null,
      postalCode: form.postalCode.trim() || null,
      country: form.country.trim() || null,
    };
    if (editTarget) {
      update.mutate({ id: editTarget.id, data: fields });
    } else {
      create.mutate({
        data: {
          ...(form.street.trim() ? { street: form.street.trim() } : {}),
          ...(form.cityName.trim() ? { cityName: form.cityName.trim() } : {}),
          ...(form.stateCode.trim() ? { stateCode: form.stateCode.trim() } : {}),
          ...(form.postalCode.trim()
            ? { postalCode: form.postalCode.trim() }
            : {}),
          ...(form.country.trim() ? { country: form.country.trim() } : {}),
          ...ownerCreateField(owner),
        },
      });
    }
  };

  const list = addresses ?? [];
  const dialogOpen = adding || editTarget !== null;
  const closeDialog = () => {
    setAdding(false);
    setEditTarget(null);
    setForm(EMPTY_ADDRESS);
  };

  return (
    <div>
      <div className="flex items-center justify-end mb-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={openAdd}
          data-testid="btn-add-address"
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add address
        </Button>
      </div>
      {list.length > 0 ? (
        <ul className="space-y-2 text-sm">
          {list.map((a) => (
            <li
              key={a.id}
              className="flex items-center justify-between gap-2 group"
              data-testid={`address-row-${a.id}`}
            >
              <span className="min-w-0">{formatAddress(a)}</span>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100"
                  onClick={() => openEdit(a)}
                  data-testid={`btn-edit-address-${a.id}`}
                  aria-label="Edit address"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100 text-destructive hover:text-destructive"
                  onClick={() => setDeleteTarget(a)}
                  data-testid={`btn-delete-address-${a.id}`}
                  aria-label="Delete address"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No addresses.</p>
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
              {editTarget ? "Edit address" : "Add address"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 min-w-0">
            <div className="space-y-1.5">
              <Label htmlFor="address-street">Street</Label>
              <Input
                id="address-street"
                value={form.street}
                onChange={(ev) => setForm({ ...form, street: ev.target.value })}
                placeholder="123 Main St"
                data-testid="input-address-street"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="address-city">City</Label>
                <Input
                  id="address-city"
                  value={form.cityName}
                  onChange={(ev) =>
                    setForm({ ...form, cityName: ev.target.value })
                  }
                  placeholder="Springfield"
                  data-testid="input-address-city"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="address-state">State</Label>
                <Input
                  id="address-state"
                  value={form.stateCode}
                  onChange={(ev) =>
                    setForm({ ...form, stateCode: ev.target.value })
                  }
                  placeholder="IL"
                  data-testid="input-address-state"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="address-postal">Postal code</Label>
                <Input
                  id="address-postal"
                  value={form.postalCode}
                  onChange={(ev) =>
                    setForm({ ...form, postalCode: ev.target.value })
                  }
                  placeholder="62704"
                  data-testid="input-address-postal"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="address-country">Country</Label>
                <Input
                  id="address-country"
                  value={form.country}
                  onChange={(ev) =>
                    setForm({ ...form, country: ev.target.value })
                  }
                  placeholder="USA"
                  data-testid="input-address-country"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>
              Cancel
            </Button>
            <Button
              onClick={submit}
              disabled={isEmptyForm || create.isPending || update.isPending}
              data-testid="btn-save-address"
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
            <AlertDialogTitle>Remove this address?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget ? formatAddress(deleteTarget) : ""} will be removed.
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
              data-testid="btn-confirm-delete-address"
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
