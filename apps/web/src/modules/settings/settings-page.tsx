import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Bot, CircleCheck, CircleX, KeyRound, Link2, Plus, UsersRound } from "lucide-react";
import type { ConnectedApp, Token } from "@connector/shared/api/tokens";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Page, PageHeader } from "@/components/ui/page";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AboutCard, AppearanceCard, KeyboardShortcutsCard } from "@/components/ui/settings-cards";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { OrganizationLogo } from "@/components/brand";
import { useT } from "@/i18n";
import { errorMessage } from "@/lib/api";
import { useFormatter } from "@/lib/format";
import { commitUrl, REPOSITORY_URL } from "@/lib/repository";
import { useTheme } from "@/lib/theme";
import { useMaybeMe } from "@/hooks/use-me";
import { useSources } from "@/modules/search/api";
import {
  useAbout,
  useConnectedApps,
  useCreateToken,
  useDisconnectApp,
  useLinks,
  useRevokeToken,
  useStartLink,
  useTokens,
  useUnlink,
} from "./api";
import { messages } from "./messages";
import { CreateTokenDialog, TokenSecretDialog } from "./token-dialogs";

function LinksCard() {
  const t = useT(messages);
  const format = useFormatter();
  const links = useLinks();
  const sources = useSources();
  const start = useStartLink();
  const unlink = useUnlink();
  const [removing, setRemoving] = useState<{ slug: string; name: string } | null>(null);
  const linkable = (sources.data?.items ?? []).filter((source) => source.linkable);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Link2 className="size-4" aria-hidden />
          {t("linksTitle")}
        </CardTitle>
        <CardDescription>{t("linksDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        {links.isLoading || sources.isLoading ? (
          <LoadingState />
        ) : links.isError || !links.data ? (
          <ErrorState error={links.error} onRetry={() => void links.refetch()} />
        ) : linkable.length === 0 && links.data.items.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("noLinkable")}</p>
        ) : (
          <ul className="divide-y">
            {[
              ...links.data.items.map((link) => ({ slug: link.source, name: link.sourceName, link })),
              ...linkable
                .filter((source) => !links.data.items.some((link) => link.source === source.slug))
                .map((source) => ({ slug: source.slug, name: source.name, link: null })),
            ].map((entry) => (
              <li key={entry.slug} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div>
                  <div className="font-medium">{entry.name}</div>
                  <div className="text-muted-foreground text-sm">
                    {entry.link
                      ? `${entry.link.label ? t("linkedAs", { label: entry.link.label }) : t("linkedSince")} · ${format.dateTime(entry.link.createdAt)}`
                      : t("notLinked")}
                  </div>
                </div>
                {entry.link ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setRemoving({ slug: entry.slug, name: entry.name })}
                  >
                    {t("unlink")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={start.isPending}
                    onClick={() =>
                      start.mutate(entry.slug, { onError: (error) => toast.error(errorMessage(error)) })
                    }
                  >
                    <Link2 />
                    {t("link")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t("unlinkTitle", { name: removing?.name ?? "" })}
        description={t("unlinkDescription")}
        confirmLabel={t("unlink")}
        destructive
        onConfirm={() =>
          removing &&
          unlink.mutateAsync(removing.slug).then(
            () => toast.success(t("unlinked")),
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

function GroupsCard() {
  const t = useT(messages);
  const me = useMaybeMe();
  const groups = me?.groups ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UsersRound className="size-4" aria-hidden />
          {t("groupsTitle")}
        </CardTitle>
        <CardDescription>{t("groupsDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        {groups.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("noGroups")}</p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {groups.map((group) => (
              <Badge key={group} variant="outline" className="font-normal">
                {group}
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TokensCard() {
  const t = useT(messages);
  const format = useFormatter();
  const tokens = useTokens();
  const create = useCreateToken();
  const revoke = useRevokeToken();
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<Token | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4" aria-hidden />
          {t("tokensTitle")}
        </CardTitle>
        <CardDescription>{t("tokensDescription")}</CardDescription>
        <CardAction>
          <Button
            size="sm"
            onClick={() => {
              create.reset();
              setCreating(true);
            }}
          >
            <Plus />
            {t("newToken")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {tokens.isLoading ? (
          <LoadingState />
        ) : tokens.isError || !tokens.data ? (
          <ErrorState error={tokens.error} onRetry={() => void tokens.refetch()} />
        ) : tokens.data.items.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("noTokens")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colName")}</TableHead>
                <TableHead>{t("colToken")}</TableHead>
                <TableHead>{t("colLastUsed")}</TableHead>
                <TableHead>{t("colExpires")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("revoke")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.data.items.map((token) => (
                <TableRow key={token.id}>
                  <TableCell className="font-medium whitespace-normal">
                    {token.name}
                    <div className="text-muted-foreground text-xs font-normal">
                      {t("colCreated")} {format.dateTime(token.createdAt)}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{token.prefix}</TableCell>
                  <TableCell>{token.lastUsedAt ? format.relative(token.lastUsedAt) : t("notUsed")}</TableCell>
                  <TableCell>{token.expiresAt ? format.dateTime(token.expiresAt) : t("never")}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => setRevoking(token)}>
                      {t("revoke")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      {creating ? (
        <CreateTokenDialog
          open
          onOpenChange={setCreating}
          title={t("createTokenTitle")}
          description={t("createTokenDescription")}
          nameHint={t("tokenNameHint")}
          pending={create.isPending}
          error={create.error}
          onCreate={(input) =>
            create.mutate(input, {
              onSuccess: (created) => {
                setCreating(false);
                setSecret(created.secret);
                toast.success(t("tokenCreated"));
              },
            })
          }
        />
      ) : null}
      <TokenSecretDialog secret={secret} onClose={() => setSecret(null)} />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={t("revokeTitle", { name: revoking?.name ?? "" })}
        description={t("revokeDescription")}
        confirmLabel={t("revoke")}
        destructive
        onConfirm={() =>
          revoking &&
          revoke.mutateAsync(revoking.id).then(
            () => toast.success(t("revoked")),
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

function AppsCard() {
  const t = useT(messages);
  const format = useFormatter();
  const apps = useConnectedApps();
  const disconnect = useDisconnectApp();
  const [removing, setRemoving] = useState<ConnectedApp | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="size-4" aria-hidden />
          {t("appsTitle")}
        </CardTitle>
        <CardDescription>{t("appsDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        {apps.isLoading ? (
          <LoadingState />
        ) : apps.isError || !apps.data ? (
          <ErrorState error={apps.error} onRetry={() => void apps.refetch()} />
        ) : apps.data.items.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("noApps")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colApp")}</TableHead>
                <TableHead>{t("colRedirect")}</TableHead>
                <TableHead>{t("colConnected")}</TableHead>
                <TableHead>{t("colLastUsed")}</TableHead>
                <TableHead>
                  <span className="sr-only">{t("disconnect")}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {apps.data.items.map((app) => (
                <TableRow key={app.id}>
                  <TableCell className="font-medium whitespace-normal">{app.clientName}</TableCell>
                  <TableCell className="font-mono text-xs">{app.redirectHost}</TableCell>
                  <TableCell>{format.dateTime(app.createdAt)}</TableCell>
                  <TableCell>{app.lastUsedAt ? format.relative(app.lastUsedAt) : t("notUsed")}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="sm" onClick={() => setRemoving(app)}>
                      {t("disconnect")}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={t("disconnectTitle", { name: removing?.clientName ?? "" })}
        description={t("disconnectDescription")}
        confirmLabel={t("disconnect")}
        destructive
        onConfirm={() =>
          removing &&
          disconnect.mutateAsync(removing.id).then(
            () => toast.success(t("disconnected")),
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

export function SettingsPage(props: { linked?: string; linkError?: string }) {
  const t = useT(messages);
  const { theme, setTheme } = useTheme();
  const sources = useSources();
  const version = useAbout().data?.version;
  const linkedName = props.linked
    ? (sources.data?.items.find((source) => source.slug === props.linked)?.name ?? props.linked)
    : null;
  return (
    <Page className="max-w-5xl">
      <PageHeader title={t("title")} description={t("description")} />
      {linkedName ? (
        <Alert>
          <CircleCheck />
          <AlertDescription>{t("linkedDone", { name: linkedName })}</AlertDescription>
        </Alert>
      ) : null}
      {props.linkError ? (
        <Alert variant="destructive">
          <CircleX />
          <AlertDescription>{t("linkFailed", { message: props.linkError })}</AlertDescription>
        </Alert>
      ) : null}
      <Alert>
        <Bot />
        <AlertTitle>{t("agentsTitle")}</AlertTitle>
        <AlertDescription>
          <p>
            {t("agentsText")}{" "}
            <Link to="/connect" className="text-link underline-offset-4 hover:underline">
              {t("connectLink")}
            </Link>
          </p>
        </AlertDescription>
      </Alert>
      <AppsCard />
      <LinksCard />
      <TokensCard />
      <GroupsCard />
      <AppearanceCard value={theme} onChange={setTheme} />
      <KeyboardShortcutsCard />
      {/* The software's name, also when an installation renames the app. */}
      <AboutCard
        logo={<OrganizationLogo className="size-10 rounded-md" />}
        text={t("about")}
        version={version}
        versionHref={version ? commitUrl(version) : undefined}
        repositoryUrl={REPOSITORY_URL}
      />
    </Page>
  );
}
