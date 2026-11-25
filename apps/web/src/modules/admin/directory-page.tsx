import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Network, Plus, RefreshCw, UsersRound } from "lucide-react";
import type { Group } from "@connector/shared/api/users";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyButton } from "@/components/ui/copy-button";
import { Page, PageHeader } from "@/components/ui/page";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useT } from "@/i18n";
import { common } from "@/i18n/common";
import { ApiError, errorMessage } from "@/lib/api";
import { useFormatter } from "@/lib/format";
import { AdminTokens } from "./admin-tokens";
import { useCreateGroup, useDeleteGroup, useDirectory, useGroups, useSyncDirectory } from "./api";
import { messages } from "./messages";

function StatusCard() {
  const t = useT(messages);
  const format = useFormatter();
  const directory = useDirectory();
  const sync = useSyncDirectory();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Network className="size-4" aria-hidden />
          {t("mode")}
        </CardTitle>
        {directory.data?.mode === "keycloak" ? (
          <CardAction>
            <Button
              size="sm"
              variant="outline"
              disabled={sync.isPending}
              onClick={() =>
                sync.mutate(undefined, {
                  onSuccess: (status) =>
                    status.lastSync?.ok
                      ? toast.success(t("synced"))
                      : toast.error(status.lastSync?.message ?? ""),
                  onError: (error) => toast.error(errorMessage(error)),
                })
              }
            >
              {sync.isPending ? <Spinner /> : <RefreshCw />}
              {t("syncNow")}
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {directory.isLoading ? (
          <LoadingState />
        ) : directory.isError || !directory.data ? (
          <ErrorState error={directory.error} onRetry={() => void directory.refetch()} />
        ) : (
          <>
            <p>{t(`mode_${directory.data.mode}`)}</p>
            {directory.data.mode === "keycloak" ? (
              <p className="text-muted-foreground">
                {t("lastSync")}:{" "}
                {directory.data.lastSync ? (
                  <span className={directory.data.lastSync.ok ? undefined : "text-destructive"}>
                    {format.dateTime(directory.data.lastSync.at)} · {directory.data.lastSync.message}
                  </span>
                ) : (
                  t("neverSynced")
                )}
                {directory.data.syncMinutes
                  ? ` · ${t("syncEvery", { minutes: directory.data.syncMinutes })}`
                  : null}
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ScimCard() {
  const t = useT(messages);
  const directory = useDirectory();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("scimTitle")}</CardTitle>
        <CardDescription>{t("scimDescription")}</CardDescription>
        <CardAction>
          <Button asChild size="sm" variant="outline">
            <Link to="/admin/setup/iam">{t("setUpIam")}</Link>
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <p className="text-sm font-medium">{t("scimUrl")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="bg-muted min-w-0 flex-1 rounded-md px-3 py-2 font-mono text-sm break-all">
              {directory.data?.scimUrl ?? ""}
            </code>
            {directory.data ? <CopyButton text={directory.data.scimUrl} /> : null}
          </div>
          {directory.data ? (
            <p className="text-muted-foreground text-xs">
              {t("scimPeople", { count: directory.data.scimPeople })}
            </p>
          ) : null}
        </div>
        <AdminTokens
          kind="scim"
          newLabel={t("newScimToken")}
          createTitle={t("createScimTitle")}
          createDescription={t("createScimDescription")}
          nameHint={t("scimNameHint")}
          empty={t("noScimTokens")}
        />
      </CardContent>
    </Card>
  );
}

function CreateGroupDialog(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useT(messages);
  const tc = useT(common);
  const create = useCreateGroup();
  const [name, setName] = useState("");
  const fields = create.error instanceof ApiError ? (create.error.fields ?? {}) : {};
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { name: name.trim() },
      {
        onSuccess: () => {
          toast.success(t("groupCreated"));
          setName("");
          props.onOpenChange(false);
        },
      },
    );
  };
  return (
    <Dialog open={props.open} onOpenChange={(open) => !create.isPending && props.onOpenChange(open)}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t("newGroup")}</DialogTitle>
            <DialogDescription>{t("groupsDescription")}</DialogDescription>
          </DialogHeader>
          <Field data-invalid={Boolean(fields.name)}>
            <FieldLabel htmlFor="group-name">{t("groupName")}</FieldLabel>
            <Input
              id="group-name"
              value={name}
              required
              maxLength={200}
              onChange={(event) => setName(event.target.value)}
            />
            <FieldDescription>{t("groupNameHint")}</FieldDescription>
            {fields.name ? <FieldError>{fields.name}</FieldError> : null}
          </Field>
          {create.error && !fields.name ? (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(create.error)}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
              {tc("cancel")}
            </Button>
            <Button type="submit" disabled={create.isPending || !name.trim()}>
              {create.isPending ? <Spinner /> : null}
              {tc("create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GroupsCard() {
  const t = useT(messages);
  const groups = useGroups();
  const remove = useDeleteGroup();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Group | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UsersRound className="size-4" aria-hidden />
          {t("groupsTitle")}
        </CardTitle>
        <CardDescription>{t("groupsDescription")}</CardDescription>
        <CardAction>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus />
            {t("newGroup")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {groups.isLoading ? (
          <LoadingState />
        ) : groups.isError || !groups.data ? (
          <ErrorState error={groups.error} onRetry={() => void groups.refetch()} />
        ) : groups.data.items.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("noGroups")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colGroup")}</TableHead>
                <TableHead>{t("colFrom")}</TableHead>
                <TableHead>{t("colMembers")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("remove")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.data.items.map((group) => (
                <TableRow key={group.id}>
                  <TableCell className="font-medium break-all whitespace-normal">{group.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{t(`from_${group.source}`)}</Badge>
                  </TableCell>
                  <TableCell>{group.members}</TableCell>
                  <TableCell className="text-right">
                    {group.source === "keycloak" ? null : (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        onClick={() => setDeleting(group)}
                      >
                        {t("remove")}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <CreateGroupDialog open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("deleteGroupTitle", { name: deleting?.name ?? "" })}
        description={t("deleteGroupDescription")}
        confirmLabel={t("remove")}
        destructive
        onConfirm={() =>
          deleting &&
          remove.mutateAsync(deleting.id).then(
            () => toast.success(t("groupDeleted")),
            (error: unknown) => {
              toast.error(errorMessage(error));
              throw error;
            },
          )
        }
      />
    </Card>
  );
}

export function AdminDirectoryPage() {
  const t = useT(messages);
  return (
    <Page className="max-w-5xl">
      <PageHeader title={t("directoryTitle")} description={t("directoryDescription")} />
      <StatusCard />
      <ScimCard />
      <GroupsCard />
    </Page>
  );
}
