import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Bot, ChevronDown, CircleCheck, CircleHelp, CircleX, Plus, Unplug, Webhook } from "lucide-react";
import { SOURCE_KINDS, SOURCE_KIND_INFO } from "@connector/shared/sources";
import type { Source } from "@connector/shared/api/sources";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { CopyButton } from "@/components/ui/copy-button";
import { Page, PageHeader } from "@/components/ui/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SecretInput } from "@/components/ui/secret-input";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useT } from "@/i18n";
import { common } from "@/i18n/common";
import { errorMessage } from "@/lib/api";
import { useFormatter } from "@/lib/format";
import { kindLabel } from "@/modules/home/home-page";
import { useAdminSources, useCheckSource, useDeleteSource, useUpdateSource, useWebhookSecret } from "./api";
import { messages } from "./messages";
import { SourceDialog, updateBody } from "./source-dialog";

const isWebhook = (source: Source) => SOURCE_KIND_INFO[source.kind].delivery === "webhook";

function Status({ source }: { source: Source }) {
  const t = useT(messages);
  const format = useFormatter();
  if (!source.status)
    return (
      <span className="text-muted-foreground flex items-center gap-1 text-sm">
        <CircleHelp className="size-4" aria-hidden />
        {t("notChecked")}
      </span>
    );
  return (
    <div className="space-y-0.5 text-sm">
      <span
        className={source.status.ok ? "flex items-center gap-1" : "text-destructive flex items-center gap-1"}
      >
        {source.status.ok ? (
          <CircleCheck className="size-4 text-emerald-600" aria-hidden />
        ) : (
          <CircleX className="size-4" aria-hidden />
        )}
        <span className="break-words">{source.status.message}</span>
      </span>
      <span className="text-muted-foreground text-xs">{format.relative(source.status.at)}</span>
    </div>
  );
}

/** Where the app sends its webhook, and a new secret shown once. */
function WebhookDialog(props: { source: Source | null; onClose: () => void }) {
  const t = useT(messages);
  const generate = useWebhookSecret();
  const [secret, setSecret] = useState<string | null>(null);
  const close = () => {
    setSecret(null);
    generate.reset();
    props.onClose();
  };
  const source = props.source;
  return (
    <Dialog open={source !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("webhookTitle", { name: source?.name ?? "" })}</DialogTitle>
          <DialogDescription>
            {source?.kind === "itkb" ? t("webhookDescriptionItkb") : t("webhookDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <p className="text-sm font-medium">{t("webhookUrl")}</p>
          <div className="flex gap-2">
            <code
              className="bg-muted min-w-0 flex-1 rounded-md px-3 py-2 font-mono text-xs break-all"
              data-testid="webhook-url"
            >
              {source?.webhookUrl}
            </code>
            {source?.webhookUrl ? <CopyButton text={source.webhookUrl} /> : null}
          </div>
        </div>
        {secret ? (
          <div className="space-y-1.5">
            <label htmlFor="webhook-secret" className="block text-sm font-medium">
              {t("secretLabel")}
            </label>
            <Alert>
              <AlertDescription>{t("secretOnce")}</AlertDescription>
            </Alert>
            <SecretInput
              // A new secret starts hidden, even when the one before was shown.
              key={secret}
              id="webhook-secret"
              readOnly
              copyable
              value={secret}
              inputClassName="font-mono text-xs"
              data-testid="webhook-secret"
            />
          </div>
        ) : source?.secrets.webhookSecret ? (
          <p className="text-muted-foreground text-sm">
            {t("secretStored", { hint: source.secrets.webhookSecret })}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={generate.isPending || !source}
            onClick={() =>
              source &&
              generate.mutate(source.id, {
                onSuccess: (created) => setSecret(created.webhookSecret),
                onError: (error) => toast.error(errorMessage(error)),
              })
            }
          >
            {generate.isPending ? <Spinner /> : null}
            {source?.secrets.webhookSecret || secret ? t("regenerate") : t("generate")}
          </Button>
          <Button type="button" onClick={close}>
            {t("done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Connect a source": a setup guide per app. */
function ConnectMenu() {
  const t = useT(messages);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>
          <Plus />
          {t("newSource")}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {SOURCE_KINDS.map((kind) => (
          <DropdownMenuItem key={kind} asChild>
            <Link to={`/admin/setup/${kind}`}>{SOURCE_KIND_INFO[kind].label}</Link>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AdminSourcesPage() {
  const t = useT(messages);
  const tc = useT(common);
  const sources = useAdminSources();
  const update = useUpdateSource();
  const remove = useDeleteSource();
  const check = useCheckSource();
  const [editing, setEditing] = useState<Source | null>(null);
  const [deleting, setDeleting] = useState<Source | null>(null);
  const [webhook, setWebhook] = useState<Source | null>(null);
  // The list's copy is newer (e.g. after a new secret), once it has the source.
  const webhookSource = webhook
    ? (sources.data?.items.find((source) => source.id === webhook.id) ?? webhook)
    : null;

  const runCheck = (source: Source) =>
    check.mutate(source.id, {
      onSuccess: (result) =>
        result.ok
          ? toast.success(t("checkOk", { name: source.name, message: result.message }))
          : toast.error(t("checkFailed", { name: source.name, message: result.message })),
      onError: (error) => toast.error(errorMessage(error)),
    });

  return (
    <Page>
      <PageHeader title={t("sourcesTitle")} description={t("sourcesDescription")} actions={<ConnectMenu />} />
      {sources.isLoading ? (
        <LoadingState />
      ) : sources.isError || !sources.data ? (
        <ErrorState error={sources.error} onRetry={() => void sources.refetch()} />
      ) : sources.data.items.length === 0 ? (
        <EmptyState
          icon={<Unplug />}
          title={t("noSources")}
          description={t("noSourcesHint")}
          action={<ConnectMenu />}
        />
      ) : (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colSource")}</TableHead>
                <TableHead>{t("colAccess")}</TableHead>
                <TableHead>{t("colStatus")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("check")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sources.data.items.map((source) => (
                <TableRow key={source.id}>
                  <TableCell className="align-top whitespace-normal">
                    <div className="flex flex-wrap items-center gap-2 font-medium">
                      {source.name}
                      <Badge variant="secondary">{kindLabel(source.kind)}</Badge>
                      {!source.enabled ? <Badge variant="outline">{t("off")}</Badge> : null}
                    </div>
                    <div className="text-muted-foreground font-mono text-xs">{source.slug}</div>
                    {source.stats ? (
                      <div className="text-muted-foreground text-xs">
                        {t("items", { count: source.stats.items })}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="align-top whitespace-normal">
                    <div className="text-sm">
                      {source.accessGroups.length === 0
                        ? t("everyone")
                        : t("groups", { groups: source.accessGroups.join(", ") })}
                    </div>
                    {source.serviceAccess ? (
                      <span className="text-muted-foreground flex items-center gap-1 text-xs">
                        <Bot className="size-3" aria-hidden />
                        {t("bots")}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="max-w-80 align-top whitespace-normal">
                    <Status source={source} />
                  </TableCell>
                  <TableCell className="text-right align-top">
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={check.isPending && check.variables === source.id}
                        onClick={() => runCheck(source)}
                      >
                        {check.isPending && check.variables === source.id ? <Spinner /> : null}
                        {t("check")}
                      </Button>
                      {isWebhook(source) ? (
                        <Button variant="ghost" size="sm" onClick={() => setWebhook(source)}>
                          <Webhook />
                          {t("webhook")}
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          update.reset();
                          setEditing(source);
                        }}
                      >
                        {tc("edit")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive"
                        onClick={() => setDeleting(source)}
                      >
                        {t("remove")}
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      {editing ? (
        <SourceDialog
          open
          source={editing}
          onOpenChange={(open) => !open && setEditing(null)}
          pending={update.isPending}
          error={update.error}
          onSubmit={(form) =>
            update.mutate(
              { id: editing.id, update: updateBody(form) },
              {
                onSuccess: (saved) => {
                  setEditing(null);
                  toast.success(t("saved"));
                  if (!isWebhook(saved)) runCheck(saved);
                },
              },
            )
          }
        />
      ) : null}
      <WebhookDialog source={webhookSource} onClose={() => setWebhook(null)} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t("deleteTitle", { name: deleting?.name ?? "" })}
        description={t("deleteDescription")}
        confirmLabel={t("remove")}
        destructive
        onConfirm={() =>
          deleting &&
          remove.mutateAsync(deleting.id).then(
            () => toast.success(t("deleted")),
            (error: unknown) => {
              toast.error(errorMessage(error));
              throw error;
            },
          )
        }
      />
    </Page>
  );
}
