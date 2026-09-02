import { useEffect, useState } from "react";
import { Link } from "wouter";
import {
  listEmails,
  useCreatePerson,
  useCreateEmail,
  useCreatePeopleEntityRole,
  getListPeopleQueryKey,
  getListEmailMessagesQueryKey,
  getListPeopleEntityRolesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";

/**
 * Best-effort name guess from an email local part: "jane.doe@x.org" →
 * ["Jane", "Doe"]. Purely a prefill convenience — the user can correct it.
 */
export function guessNameFromEmail(email: string): [string, string] {
  const local = email.split("@")[0] ?? "";
  const parts = local
    .split(/[._\-+]+/)
    .filter((p) => p && !/^\d+$/.test(p))
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase());
  return [parts[0] ?? "", parts.slice(1).join(" ")];
}

/**
 * "Add sender as a person" — creates a person record from an email address
 * seen in the activity feed, links the address to the new person (so their
 * past and future emails match), and optionally adds a current-staff role
 * at the organization whose page you're on.
 */
export function AddSenderPersonDialog({
  email,
  organizationId,
  organizationName,
  open,
  onOpenChange,
}: {
  email: string;
  organizationId?: string;
  organizationName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [title, setTitle] = useState("");
  const [linkToOrg, setLinkToOrg] = useState(true);
  const [pending, setPending] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Re-prefill whenever the dialog opens for a (possibly different) sender.
  useEffect(() => {
    if (open) {
      const [fn, ln] = guessNameFromEmail(email);
      setFirstName(fn);
      setLastName(ln);
      setTitle("");
      setLinkToOrg(true);
    }
  }, [open, email]);

  const createPerson = useCreatePerson();
  const createEmail = useCreateEmail();
  const createRole = useCreatePeopleEntityRole();

  const fn = firstName.trim();
  const ln = lastName.trim();
  const fullName = [fn, ln].filter(Boolean).join(" ");
  const canSubmit = fullName.length > 0 && !pending;

  const submit = async () => {
    if (!canSubmit) return;
    setPending(true);
    let createdPerson: { id: string } | null = null;
    let emailLinked = false;
    try {
      // Preflight: an address is globally unique. If it's already on file,
      // never create a duplicate person — point at the existing record.
      const existing = await listEmails({ email, limit: 1 });
      const found = existing.data?.[0];
      if (found) {
        toast({
          title: "This address is already on file",
          description: found.personId ? (
            <span>
              {email} already belongs to{" "}
              <Link
                href={`/individuals/${found.personId}`}
                className="underline underline-offset-2"
              >
                an existing person
              </Link>
              .
            </span>
          ) : (
            `${email} is already attached to another record.`
          ),
          variant: "destructive",
        });
        return;
      }
      createdPerson = await createPerson.mutateAsync({
        data: {
          firstName: fn || undefined,
          lastName: ln || undefined,
          fullName,
        },
      });
      const person = createdPerson;
      // Link the address so this sender's emails match the new person. If a
      // later step fails, the person still exists — surface a partial error
      // rather than silently losing the link.
      await createEmail.mutateAsync({
        data: { email, personId: person.id, type: "work" },
      });
      emailLinked = true;
      if (organizationId && linkToOrg) {
        await createRole.mutateAsync({
          data: {
            personId: person.id,
            entityType: "organization",
            organizationId,
            connection: "employee",
            current: "current",
            ...(title.trim() ? { externalTitleOrRole: title.trim() } : {}),
          },
        });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListPeopleQueryKey() }),
        queryClient.invalidateQueries({
          queryKey: getListEmailMessagesQueryKey(),
          exact: false,
        }),
        queryClient.invalidateQueries({
          queryKey: getListPeopleEntityRolesQueryKey(),
          exact: false,
        }),
      ]);
      toast({
        title: "Person created",
        description: (
          <span>
            <Link
              href={`/individuals/${person.id}`}
              className="underline underline-offset-2"
            >
              {fullName}
            </Link>{" "}
            was created, {email} was linked
            {organizationId && linkToOrg && organizationName
              ? `, and they were added as current staff at ${organizationName}`
              : ""}
            .
          </span>
        ),
      });
      onOpenChange(false);
    } catch (err: unknown) {
      const detail = err instanceof Error ? err.message : String(err);
      // Stage-aware cache invalidation: refresh every resource a completed
      // stage changed, so the open feed reflects the partial progress. Be
      // explicit so the user can finish the linking from the person page
      // instead of retrying (which would hit the duplicate preflight).
      if (createdPerson) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: getListPeopleQueryKey() }),
          // A successful email link re-attributed message history server-side.
          ...(emailLinked
            ? [
                queryClient.invalidateQueries({
                  queryKey: getListEmailMessagesQueryKey(),
                  exact: false,
                }),
              ]
            : []),
        ]);
      }
      toast({
        title: "Couldn't finish creating the person",
        description: createdPerson ? (
          <span>
            <Link
              href={`/individuals/${createdPerson.id}`}
              className="underline underline-offset-2"
            >
              {fullName}
            </Link>{" "}
            was created, but a later step failed: {detail}. Finish linking from
            their page.
          </span>
        ) : (
          detail
        ),
        variant: "destructive",
      });
      if (createdPerson) onOpenChange(false);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!pending) onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add sender as a new person</DialogTitle>
          <DialogDescription>
            Creates a person record for <strong>{email}</strong> and links this
            address so their emails match going forward.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="space-y-3"
        >
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="sender-first-name">First name</Label>
              <Input
                id="sender-first-name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                data-testid="input-sender-first-name"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="sender-last-name">Last name</Label>
              <Input
                id="sender-last-name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                data-testid="input-sender-last-name"
              />
            </div>
          </div>
          {organizationId ? (
            <>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="sender-link-org"
                  checked={linkToOrg}
                  onCheckedChange={(v) => setLinkToOrg(v === true)}
                  data-testid="checkbox-sender-link-org"
                />
                <Label htmlFor="sender-link-org" className="font-normal">
                  Add as current staff at{" "}
                  {organizationName ?? "this organization"}
                </Label>
              </div>
              {linkToOrg ? (
                <div className="space-y-1">
                  <Label htmlFor="sender-title">Title or role (optional)</Label>
                  <Input
                    id="sender-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. Program Officer"
                    data-testid="input-sender-title"
                  />
                </div>
              ) : null}
            </>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit}
              data-testid="button-create-sender-person"
            >
              {pending ? "Creating…" : "Create person"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
