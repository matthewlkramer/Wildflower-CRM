import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetCurrentUser,
  useAdminListUsers,
  useAdminCreateUser,
  useAdminUpdateUser,
  useArchiveUser,
  useUnarchiveUser,
  getAdminListUsersQueryKey,
  getListUsersQueryKey,
  getGetCurrentUserQueryKey,
  type User,
  type UserRole,
} from "@workspace/api-client-react";
import { userDisplayName } from "@/components/user-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";

const roles: Record<UserRole, string> = {
  team_member: "Team member",
  admin: "Admin",
  finance: "Finance",
  read_only: "Read only (legacy)",
};
const selectClass =
  "h-10 rounded-md border border-input bg-background px-3 text-sm";

export default function AdminUsers({ embedded = false }: { embedded?: boolean }) {
  const me = useGetCurrentUser();
  const isAdmin = me.data?.role === "admin";
  const directory = useAdminListUsers({
    query: { queryKey: getAdminListUsersQueryKey(), enabled: isAdmin },
  });
  const qc = useQueryClient();
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [editing, setEditing] = useState<User | "new" | null>(null);
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<UserRole>("team_member");
  const [formError, setFormError] = useState("");

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: getAdminListUsersQueryKey() });
    void qc.invalidateQueries({ queryKey: getListUsersQueryKey() });
    void qc.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() });
  };
  const saved = () => {
    refresh();
    setEditing(null);
    toast({ title: "User saved" });
  };
  const failed = (error: unknown) => {
    const message =
      error instanceof Error ? error.message : "Please try again.";
    setFormError(message);
    toast({
      title: "Could not update user",
      description: message,
      variant: "destructive",
    });
  };
  const create = useAdminCreateUser({
    mutation: { onSuccess: saved, onError: failed },
  });
  const update = useAdminUpdateUser({
    mutation: { onSuccess: saved, onError: failed },
  });
  const archive = useArchiveUser({
    mutation: {
      onSuccess: () => {
        refresh();
        toast({
          title: "User deactivated",
          description: "Record ownership and history are preserved.",
        });
      },
      onError: failed,
    },
  });
  const restore = useUnarchiveUser({
    mutation: {
      onSuccess: () => {
        refresh();
        toast({ title: "User access restored" });
      },
      onError: failed,
    },
  });
  const busy =
    create.isPending ||
    update.isPending ||
    archive.isPending ||
    restore.isPending;

  function openEditor(user: User | "new") {
    setEditing(user);
    setEmail(user === "new" ? "" : user.email);
    setFirstName(user === "new" ? "" : (user.firstName ?? ""));
    setLastName(user === "new" ? "" : (user.lastName ?? ""));
    setDisplayName(user === "new" ? "" : (user.displayName ?? ""));
    setRole(user === "new" ? "team_member" : user.role);
    setFormError("");
  }

  if (me.isLoading) return <p>Loading users…</p>;
  if (me.isError)
    return (
      <p role="alert">Could not check your access. Please reload the page.</p>
    );
  if (!isAdmin) return <p role="alert">Only admins can manage users.</p>;
  const visible = (directory.data ?? []).filter((user) => {
    const matchesStatus =
      status === "all" ||
      (status === "inactive" ? Boolean(user.archivedAt) : !user.archivedAt);
    return (
      matchesStatus &&
      `${userDisplayName(user)} ${user.email}`
        .toLowerCase()
        .includes(search.trim().toLowerCase())
    );
  });

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-serif font-bold">Users</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage CRM roles and access. Deactivating a user preserves their
            records and history.
          </p>
        </div>
        <Button onClick={() => openEditor("new")} disabled={busy}>
          Add user
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Users sign in with their Wildflower Google account. Adding someone here
        prepares their CRM profile; it does not send an email or create a Google
        account.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Input
          aria-label="Search users"
          placeholder="Search by name or email"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          className="max-w-sm"
        />
        <select
          aria-label="Filter by access"
          className={selectClass}
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="all">All users</option>
          <option value="active">Active</option>
          <option value="inactive">Deactivated</option>
        </select>
        <span className="text-sm text-muted-foreground">
          {visible.length} users
        </span>
      </div>
      {directory.isLoading ? (
        <p>Loading users…</p>
      ) : directory.isError ? (
        <div role="alert">
          Could not load users.{" "}
          <Button variant="outline" onClick={() => void directory.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Access</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((user) => (
                <TableRow key={user.id}>
                  <TableCell className="font-medium">
                    {userDisplayName(user)}
                    {user.id === me.data?.id && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        You
                      </span>
                    )}
                  </TableCell>
                  <TableCell>{user.email}</TableCell>
                  <TableCell>{roles[user.role]}</TableCell>
                  <TableCell>
                    <Badge variant={user.archivedAt ? "outline" : "secondary"}>
                      {user.archivedAt ? "Deactivated" : "Active"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`Edit ${user.email}`}
                        disabled={busy}
                        onClick={() => openEditor(user)}
                      >
                        Edit
                      </Button>
                      {user.archivedAt ? (
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={`Restore ${user.email}`}
                          disabled={busy}
                          onClick={() => restore.mutate({ id: user.id })}
                        >
                          Restore access
                        </Button>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={`Deactivate ${user.email}`}
                          disabled={busy || user.id === me.data?.id}
                          title={
                            user.id === me.data?.id
                              ? "Another admin must deactivate your account"
                              : undefined
                          }
                          onClick={() => archive.mutate({ id: user.id })}
                        >
                          Deactivate
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {visible.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5}>
                    No users match these filters.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}
      {!embedded && (
        <p className="text-sm">
          User access and record reassignment now live together on the Admin
          page's Users tab.
        </p>
      )}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setEditing(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing === "new" ? "Add user" : "Edit user"}
            </DialogTitle>
            <DialogDescription>
              {editing === "new"
                ? "Use their Wildflower Google sign-in email. Their profile will connect when they sign in."
                : "Update their CRM name and role. Login email is managed through Google sign-in."}
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) return;
              const data = {
                firstName: firstName.trim() || null,
                lastName: lastName.trim() || null,
                displayName: displayName.trim() || null,
                role,
              };
              if (editing === "new")
                create.mutate({
                  data: { ...data, email: email.trim().toLowerCase() },
                });
              else if (editing) update.mutate({ id: editing.id, data });
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="user-email">Email</Label>
              <Input
                id="user-email"
                type="email"
                required
                maxLength={254}
                disabled={editing !== "new" || busy}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="user-first-name">First name</Label>
                <Input
                  id="user-first-name"
                  maxLength={100}
                  value={firstName}
                  disabled={busy}
                  onChange={(event) => setFirstName(event.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="user-last-name">Last name</Label>
                <Input
                  id="user-last-name"
                  maxLength={100}
                  value={lastName}
                  disabled={busy}
                  onChange={(event) => setLastName(event.target.value)}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="user-display-name">Display name (optional)</Label>
              <Input
                id="user-display-name"
                maxLength={200}
                value={displayName}
                disabled={busy}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="user-role">Role</Label>
              <select
                id="user-role"
                className={`${selectClass} w-full`}
                value={role}
                disabled={
                  busy || (editing !== "new" && editing?.id === me.data?.id)
                }
                onChange={(event) => setRole(event.target.value as UserRole)}
              >
                {Object.entries(roles).map(([value, label]) => (
                  <option
                    key={value}
                    value={value}
                    disabled={value === "read_only"}
                  >
                    {value === "read_only"
                      ? "Read only — unavailable for new assignments"
                      : label}
                  </option>
                ))}
              </select>
              {editing !== "new" && editing?.id === me.data?.id && (
                <p className="text-xs text-muted-foreground">
                  Another admin must change your role.
                </p>
              )}
            </div>
            {formError && (
              <p role="alert" className="text-sm text-destructive">
                {formError}
              </p>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setEditing(null)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save user"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
