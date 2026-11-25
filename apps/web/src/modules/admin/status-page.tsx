import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { Bot, CircleCheck, CircleX, Network, Plus, RefreshCw, TriangleAlert, Unplug } from "lucide-react";
import type { AdminStatus, Problem, SourceHealth } from "@connector/shared/api/status";
import { SOURCE_KINDS, SOURCE_KIND_INFO } from "@connector/shared/sources";
import { Page, PageHeader } from "@/components/ui/page";
import { SourceStateBadge } from "@/components/source-state";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { useT } from "@/i18n";
import { errorMessage } from "@/lib/api";
import { useFormatter } from "@/lib/format";
import { cn } from "@/components/ui/utils";
import { kindLabel } from "@/modules/home/home-page";
import { useAdminStatus, useCheckSource } from "./api";
import { messages } from "./messages";

/** Where a source's guide is: its kind's guide, continuing the source. */
const guideOf = (source: Pick<SourceHealth, "kind" | "id">) => ({
  to: `/admin/setup/${source.kind}`,
  search: { source: source.id },
});

function ProblemAction({ problem, status }: { problem: Problem; status: AdminStatus }) {
  const t = useT(messages);
  if (problem.area === "source") {
    const source = status.sources.find((item) => item.id === problem.sourceId);
    if (!source) return null;
    const guide = guideOf(source);
    return (
      <Button asChild size="sm" variant="outline">
        <Link to={guide.to} search={guide.search}>
          {t("fix_source")}
        </Link>
      </Button>
    );
  }
  const to = {
    directory: "/admin/directory",
    scim: "/admin/setup/iam",
    people: "/admin/people",
    "service-tokens": "/admin/service-tokens",
  }[problem.area];
  return (
    <Button asChild size="sm" variant="outline">
      <Link to={to} search={problem.area === "people" ? { q: "conflict.invalid" } : undefined}>
        {t(`fix_${problem.area}`)}
      </Link>
    </Button>
  );
}

function ProblemsCard({ status }: { status: AdminStatus }) {
  const t = useT(messages);
  if (status.problems.length === 0)
    return (
      <Card className="border-emerald-600/40">
        <CardHeader className="flex flex-row items-center gap-3">
          <CircleCheck className="size-5 shrink-0 text-emerald-600" aria-hidden />
          <div className="space-y-1">
            <CardTitle>{t("allGood")}</CardTitle>
            <CardDescription>{t("allGoodText")}</CardDescription>
          </div>
        </CardHeader>
      </Card>
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("problemsTitle")}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y" aria-label={t("problemsTitle")}>
          {status.problems.map((problem) => (
            <li
              key={problem.key}
              className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start"
            >
              <div className="flex min-w-0 flex-1 gap-3">
                {problem.severity === "error" ? (
                  <CircleX className="text-destructive mt-0.5 size-4 shrink-0" aria-label="Error" />
                ) : (
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" aria-label="Warning" />
                )}
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-sm font-medium">{problem.title}</p>
                  <p className="text-muted-foreground text-sm break-words">{problem.detail}</p>
                </div>
              </div>
              <div className="pl-7 sm:pl-0">
                <ProblemAction problem={problem} status={status} />
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function SourceTile({ source }: { source: SourceHealth }) {
  const t = useT(messages);
  const format = useFormatter();
  const guide = guideOf(source);
  return (
    <Card className="gap-3" data-testid={`source-${source.slug}`}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {source.name}
          <Badge variant="secondary">{kindLabel(source.kind)}</Badge>
        </CardTitle>
        <CardAction>
          <SourceStateBadge state={source.state} />
        </CardAction>
      </CardHeader>
      <CardContent className="text-muted-foreground space-y-1 text-sm">
        {source.status ? (
          <p className={cn("break-words", !source.status.ok && "text-destructive")}>
            {source.status.message} · {format.relative(source.status.at)}
          </p>
        ) : null}
        {source.delivery === "webhook" ? (
          <p>
            {t("items", { count: source.items ?? 0 })} ·{" "}
            {source.lastDeliveryAt
              ? t("lastDelivery", { when: format.relative(source.lastDeliveryAt) })
              : t("noDelivery")}
          </p>
        ) : null}
        <p>
          {source.requests.total > 0
            ? t("requests24h", { total: source.requests.total, failed: source.requests.failed })
            : t("requests24hNone")}
        </p>
      </CardContent>
      <CardFooter className="mt-auto">
        <Button asChild size="sm" variant="ghost" className="-ml-2">
          <Link to={guide.to} search={guide.search}>
            {t("setUp")}
          </Link>
        </Button>
      </CardFooter>
    </Card>
  );
}

function ConnectTile({ kind }: { kind: (typeof SOURCE_KINDS)[number] }) {
  const t = useT(messages);
  return (
    <Card className="gap-3 border-dashed" data-testid={`connect-${kind}`}>
      <CardHeader>
        <CardTitle className="text-base">{SOURCE_KIND_INFO[kind].label}</CardTitle>
        <CardAction>
          <Badge variant="outline" className="text-muted-foreground">
            {t("notConnected")}
          </Badge>
        </CardAction>
        <CardDescription>{SOURCE_KIND_INFO[kind].holds}</CardDescription>
      </CardHeader>
      <CardFooter className="mt-auto">
        <Button asChild size="sm">
          <Link to={`/admin/setup/${kind}`}>
            <Plus />
            {t("connectApp")} {kindLabel(kind)}
          </Link>
        </Button>
      </CardFooter>
    </Card>
  );
}

function IdentityCard({ status }: { status: AdminStatus }) {
  const t = useT(messages);
  const format = useFormatter();
  const { directory, scim } = status;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Network className="size-4" aria-hidden />
          {t("identityTitle")}
        </CardTitle>
        <CardDescription>
          {t("peopleCount", { count: directory.people })} · {t("groupsCount", { count: directory.groups })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="space-y-1">
          <p className="font-medium">{t("keycloakSync")}</p>
          {directory.mode === "oidc" ? (
            <p className="text-muted-foreground">{t("oidcOnly")}</p>
          ) : directory.lastSync ? (
            <p className={directory.lastSync.ok ? "text-muted-foreground" : "text-destructive"}>
              {t(directory.lastSync.ok ? "syncedAt" : "syncFailed", {
                when: format.relative(directory.lastSync.at),
                message: directory.lastSync.message,
              })}
            </p>
          ) : (
            <p className="text-muted-foreground">{t("neverSynced")}</p>
          )}
        </div>
        <Separator />
        <div className="space-y-1">
          <p className="font-medium">{t("scimHeading")}</p>
          {scim.tokens === 0 && scim.people === 0 ? (
            <p className="text-muted-foreground">{t("scimNone")}</p>
          ) : (
            <>
              <p className="text-muted-foreground">
                {t("scimSummary", { tokens: scim.tokens, people: scim.people })}
              </p>
              <p
                className={
                  scim.lastRequest && !scim.lastRequest.ok ? "text-destructive" : "text-muted-foreground"
                }
              >
                {scim.lastRequest
                  ? t("scimLast", {
                      when: format.relative(scim.lastRequest.at),
                      message: scim.lastRequest.message,
                    })
                  : t("scimNever")}
              </p>
            </>
          )}
        </div>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline">
          <Link to="/admin/setup/iam">{t("setUpIam")}</Link>
        </Button>
        <Button asChild size="sm" variant="ghost">
          <Link to="/admin/directory">{t("fix_directory")}</Link>
        </Button>
      </CardFooter>
    </Card>
  );
}

function AgentsCard({ status }: { status: AdminStatus }) {
  const t = useT(messages);
  const format = useFormatter();
  const { agents } = status;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="size-4" aria-hidden />
          {t("agentsTitle")}
        </CardTitle>
        <CardDescription>
          {t("week")}:{" "}
          {t("weekText", {
            requests: agents.week.requests,
            people: agents.week.people,
            bots: agents.week.bots,
            failed: agents.week.failed,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="space-y-1">
          <p className="font-medium">{t("connectedApps")}</p>
          {agents.apps.length === 0 ? (
            <p className="text-muted-foreground">{t("noApps")}</p>
          ) : (
            <ul className="text-muted-foreground space-y-0.5">
              {agents.apps.map((app) => (
                <li key={app.name}>
                  <span className="text-foreground">{app.name}</span> ·{" "}
                  {t("appPeople", { count: app.people })}
                  {app.lastUsedAt ? ` · ${format.relative(app.lastUsedAt)}` : null}
                </li>
              ))}
            </ul>
          )}
        </div>
        <Separator />
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1">
          <dt className="font-medium">{t("personalTokens")}</dt>
          <dd className="text-muted-foreground">{agents.personalTokens}</dd>
          <dt className="font-medium">{t("botTokens")}</dt>
          <dd className="text-muted-foreground">
            {agents.serviceLastUsedAt
              ? t("botsLast", {
                  count: agents.serviceTokens,
                  when: format.relative(agents.serviceLastUsedAt),
                })
              : t("botsNever", { count: agents.serviceTokens })}
          </dd>
        </dl>
      </CardContent>
      <CardFooter className="flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline">
          <Link to="/admin/setup/support-agent">{t("setUpSupportAgent")}</Link>
        </Button>
        <Button asChild size="sm" variant="ghost">
          <Link to="/admin/activity">{t("openActivity")}</Link>
        </Button>
        <Button asChild size="sm" variant="ghost">
          <Link to="/connect">{t("howToConnect")}</Link>
        </Button>
      </CardFooter>
    </Card>
  );
}

/** Administration → Status: problems first, then sources, directory and agents. */
export function AdminStatusPage() {
  const t = useT(messages);
  const status = useAdminStatus({ poll: 30_000 });
  const check = useCheckSource();
  const [checking, setChecking] = useState(false);

  const checkAll = (data: AdminStatus) => {
    const live = data.sources.filter((source) => source.enabled && source.delivery === "live");
    setChecking(true);
    Promise.all(live.map((source) => check.mutateAsync(source.id)))
      .then((results) => {
        const failing = results.filter((result) => !result.ok).length;
        if (failing > 0) toast.error(t("checkedFailing", { count: live.length, failing }));
        else toast.success(t("checkedSources", { count: live.length }));
      })
      .catch((error: unknown) => toast.error(errorMessage(error)))
      .finally(() => setChecking(false));
  };

  const data = status.data;
  const missing = data
    ? SOURCE_KINDS.filter((kind) => !data.sources.some((source) => source.kind === kind))
    : [];
  return (
    <Page className="max-w-6xl">
      <PageHeader
        title={t("statusTitle")}
        description={t("statusDescription")}
        actions={
          data && data.sources.some((source) => source.enabled && source.delivery === "live") ? (
            <Button variant="outline" disabled={checking} onClick={() => checkAll(data)}>
              {checking ? <Spinner /> : <RefreshCw />}
              {checking ? t("checkingSources") : t("checkSources")}
            </Button>
          ) : null
        }
      />
      {status.isLoading ? (
        <LoadingState />
      ) : status.isError || !data ? (
        <ErrorState error={status.error} onRetry={() => void status.refetch()} />
      ) : (
        <>
          <ProblemsCard status={data} />
          <section className="space-y-3" aria-labelledby="status-sources">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="status-sources" className="flex items-center gap-2 text-lg font-semibold">
                <Unplug className="size-4" aria-hidden />
                {t("sourcesSection")}
              </h2>
              <Button asChild size="sm" variant="ghost">
                <Link to="/admin/sources">{t("manageSources")}</Link>
              </Button>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {data.sources.map((source) => (
                <SourceTile key={source.id} source={source} />
              ))}
              {missing.map((kind) => (
                <ConnectTile key={kind} kind={kind} />
              ))}
            </div>
            <p className="text-muted-foreground text-xs">
              {data.sourceChecks.minutes
                ? t("checkedEvery", { minutes: data.sourceChecks.minutes })
                : t("checksOff")}
            </p>
          </section>
          <div className="grid gap-4 lg:grid-cols-2">
            <IdentityCard status={data} />
            <AgentsCard status={data} />
          </div>
        </>
      )}
    </Page>
  );
}
