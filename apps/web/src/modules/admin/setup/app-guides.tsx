import { useState, type FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import type { ServiceToken, TokenCreated } from "@connector/shared/api/tokens";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/i18n";
import { ApiError, errorMessage } from "@/lib/api";
import { useFormatter } from "@/lib/format";
import { useConnectInfo } from "@/modules/settings/api";
import {
  useAdminSources,
  useAdminStatus,
  useAdminTokens,
  useCreateAdminToken,
  useCreateGroup,
  useGroups,
  useUpdateSource,
  type TokenKind,
} from "../api";
import { messages } from "./messages";
import { CopyRow, GuideStep, Outcome, withLink } from "./steps";

/** Tokens made by a guide expire in a year; the status page warns two weeks before. */
const GUIDE_TOKEN_DAYS = 365;

/**
 * When the token made in this guide was first used. Only that token counts:
 * other tokens of the kind may belong to other systems, or have expired.
 */
function lastUse(tokens: ServiceToken[], created: TokenCreated | null): string | null {
  if (!created) return null;
  return tokens.find((token) => token.id === created.id)?.lastUsedAt ?? null;
}

/** Creates a token of `kind` (shown once) and waits until it is used. */
function useGuideToken(kind: TokenKind, name: string) {
  const [created, setCreated] = useState<TokenCreated | null>(null);
  const tokens = useAdminTokens(kind, {
    poll: (items) => (created && !lastUse(items, created) ? 3000 : false),
  });
  const create = useCreateAdminToken(kind);
  const items = tokens.data?.items ?? [];
  return {
    tokens,
    items,
    created,
    usedAt: lastUse(items, created),
    create: () =>
      create.mutate(
        { name, expiresInDays: GUIDE_TOKEN_DAYS },
        { onSuccess: setCreated, onError: (error) => toast.error(errorMessage(error)) },
      ),
    creating: create.isPending,
  };
}

/** The new token, shown once, or a note that tokens exist. */
function TokenStep(props: {
  number: number;
  title: string;
  text: string;
  existing: string;
  createLabel: string;
  token: ReturnType<typeof useGuideToken>;
}) {
  const t = useT(messages);
  const { token } = props;
  return (
    <GuideStep
      number={props.number}
      title={props.title}
      description={props.text}
      done={token.created !== null}
    >
      {token.created ? (
        <>
          <CopyRow label={t("token")} value={token.created.secret} secret testId="guide-token" />
          <p className="text-muted-foreground text-sm">{t("shownOnce")}</p>
        </>
      ) : (
        <>
          {token.items.length > 0 ? <p className="text-muted-foreground text-sm">{props.existing}</p> : null}
          <Button
            type="button"
            variant={token.items.length > 0 ? "outline" : "default"}
            disabled={token.creating}
            onClick={token.create}
          >
            {token.creating ? <Spinner /> : null}
            {props.createLabel}
          </Button>
        </>
      )}
    </GuideStep>
  );
}

function AddGroupForm() {
  const t = useT(messages);
  const create = useCreateGroup();
  const [name, setName] = useState("");
  const fields = create.error instanceof ApiError ? (create.error.fields ?? {}) : {};
  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate(
      { name: name.trim() },
      {
        onSuccess: () => {
          setName("");
          toast.success(t("groupAdded"));
        },
      },
    );
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
      <Field data-invalid={Boolean(fields.name)} className="min-w-56 flex-1">
        <FieldLabel htmlFor="guide-group">{t("groupName")}</FieldLabel>
        <Input
          id="guide-group"
          value={name}
          maxLength={200}
          placeholder="/staff"
          onChange={(event) => setName(event.target.value)}
        />
        {fields.name ? <FieldError>{fields.name}</FieldError> : null}
      </Field>
      <Button type="submit" variant="outline" disabled={create.isPending || !name.trim()}>
        {create.isPending ? <Spinner /> : null}
        {t("addGroup")}
      </Button>
    </form>
  );
}

/** IAM provisions people and fills groups over SCIM 2.0. */
export function IamGuide() {
  const t = useT(messages);
  const format = useFormatter();
  const token = useGuideToken("scim", "IAM");
  const status = useAdminStatus({ poll: token.usedAt ? undefined : 10_000 });
  const groups = useGroups();
  if (status.isLoading || groups.isLoading || token.tokens.isLoading) return <LoadingState />;
  if (status.isError || !status.data)
    return <ErrorState error={status.error} onRetry={() => void status.refetch()} />;
  const groupNames = (groups.data?.items ?? []).map((group) => group.name);
  const keycloak = status.data.directory.mode === "keycloak";
  return (
    <div className="space-y-4">
      <GuideStep
        number={1}
        title={t("groupsTitle")}
        description={t("groupsText")}
        done={groupNames.length > 0}
      >
        {keycloak ? <p className="text-muted-foreground text-sm">{t("groupsKeycloak")}</p> : null}
        <p className="text-sm">
          {groupNames.length === 0
            ? t("groupsNone")
            : t("groupsSome", {
                names:
                  groupNames.slice(0, 8).join(", ") +
                  (groupNames.length > 8 ? ` (+${groupNames.length - 8})` : ""),
              })}
        </p>
        <AddGroupForm />
      </GuideStep>
      <TokenStep
        number={2}
        title={t("scimTokenTitle")}
        text={t("scimTokenText")}
        existing={t("scimTokenExisting", { count: token.items.length })}
        createLabel={t("createScimToken")}
        token={token}
      />
      <GuideStep number={3} title={t("iamTitle")} done={Boolean(token.usedAt)}>
        <p className="text-sm">{withLink(t("iamText"), <strong>{t("iamLink")}</strong>)}</p>
        <div className="space-y-2">
          <CopyRow label={t("fieldName")} value="Connector" />
          <CopyRow label={t("fieldScimUrl")} value={status.data.scim.url} testId="scim-url" />
          {token.created ? (
            <CopyRow label={t("fieldBearer")} value={token.created.secret} secret />
          ) : (
            <CopyRow label={t("fieldBearer")} value={t("valueTokenAbove", { step: 2 })} copy={false} />
          )}
          <CopyRow label={t("fieldUserName")} value={t("valueUserName")} copy={false} />
          <CopyRow label={t("fieldAccessEnds")} value={t("valueAccessEnds")} copy={false} />
          <CopyRow label={t("fieldManageGroups")} value={t("valueOn")} copy={false} />
        </div>
        <p className="text-muted-foreground text-sm">{t("iamDeactivate")}</p>
        <p className="text-sm">{t("iamAfter")}</p>
      </GuideStep>
      <GuideStep
        number={4}
        title={t("iamWaitTitle")}
        done={Boolean(token.usedAt)}
        locked={token.created === null}
      >
        {token.usedAt ? (
          <Outcome state="ok" title={t("iamConnected")}>
            <p>{t("iamConnectedText", { when: format.relative(token.usedAt) })}</p>
            {status.data.scim.lastRequest ? <p>{status.data.scim.lastRequest.message}</p> : null}
          </Outcome>
        ) : (
          <Outcome state="waiting" title={t("iamWaiting")}>
            <p>{t("iamWaitingHint")}</p>
          </Outcome>
        )}
        {token.usedAt ? (
          <Button asChild>
            <Link to="/admin">{t("toStatus")}</Link>
          </Button>
        ) : null}
      </GuideStep>
    </div>
  );
}

const STANDARD_BODY = '{"query": "{{query}}", "limit": "{{limit}}"}';

/** The Support Agent searches Connector as a knowledge source (HTTP search API). */
export function SupportAgentGuide() {
  const t = useT(messages);
  const format = useFormatter();
  const sources = useAdminSources();
  const update = useUpdateSource();
  const token = useGuideToken("service", "Support Agent");
  const appUrl = useConnectInfo().data?.appUrl ?? window.location.origin;
  if (sources.isLoading || token.tokens.isLoading) return <LoadingState />;
  if (sources.isError || !sources.data)
    return <ErrorState error={sources.error} onRetry={() => void sources.refetch()} />;
  const enabled = sources.data.items.filter((source) => source.enabled);
  return (
    <div className="space-y-4">
      <GuideStep
        number={1}
        title={t("botsTitle")}
        description={t("botsText")}
        done={enabled.some((source) => source.serviceAccess)}
      >
        {enabled.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("botsNone")}</p>
        ) : (
          <div className="space-y-3">
            {enabled.map((source) => (
              <label key={source.id} className="flex items-center gap-3 text-sm">
                <Switch
                  checked={source.serviceAccess}
                  disabled={update.isPending && update.variables?.id === source.id}
                  aria-label={t("botAccess", { name: source.name })}
                  onCheckedChange={(checked) =>
                    update.mutate(
                      { id: source.id, update: { serviceAccess: checked } },
                      { onError: (error) => toast.error(errorMessage(error)) },
                    )
                  }
                />
                {source.name}
                <span className="text-muted-foreground font-mono text-xs">{source.slug}</span>
              </label>
            ))}
          </div>
        )}
      </GuideStep>
      <TokenStep
        number={2}
        title={t("serviceTokenTitle")}
        text={t("serviceTokenText")}
        existing={t("serviceTokenExisting", { count: token.items.length })}
        createLabel={t("createServiceToken")}
        token={token}
      />
      <GuideStep number={3} title={t("agentTitle")} done={Boolean(token.usedAt)}>
        <p className="text-sm">{t("agentText")}</p>
        <div className="space-y-2">
          <CopyRow label={t("fieldName")} value="Connector" />
          <CopyRow
            label={t("fieldSearchUrl")}
            value={`${appUrl}/api/v1/knowledge/search`}
            testId="knowledge-url"
          />
          <CopyRow label={t("fieldAuth")} value={t("valueBearer")} copy={false} />
          {token.created ? (
            <CopyRow label={t("fieldBearer")} value={token.created.secret} secret />
          ) : (
            <CopyRow label={t("fieldBearer")} value={t("valueTokenAbove", { step: 2 })} copy={false} />
          )}
          <CopyRow label={`${t("fieldJsonBody")} (${t("valueStandardBody")})`} value={STANDARD_BODY} />
          <CopyRow label={t("fieldResults")} value="results" />
          <CopyRow label={t("fieldTitle")} value="title" />
          <CopyRow label={t("fieldUrl")} value="url" />
          <CopyRow label={t("fieldText")} value="text" />
          <CopyRow label={t("fieldSection")} value="section" />
        </div>
        <p className="text-sm">{t("agentAfter")}</p>
      </GuideStep>
      <GuideStep
        number={4}
        title={t("agentWaitTitle")}
        done={Boolean(token.usedAt)}
        locked={token.created === null}
      >
        {token.usedAt ? (
          <Outcome state="ok" title={t("agentConnected")}>
            {t("agentConnectedText", { when: format.relative(token.usedAt) })}
          </Outcome>
        ) : (
          <Outcome state="waiting" title={t("agentWaiting")}>
            <p>{t("agentWaitingHint")}</p>
          </Outcome>
        )}
        {token.usedAt ? (
          <Button asChild>
            <Link to="/admin">{t("toStatus")}</Link>
          </Button>
        ) : null}
      </GuideStep>
    </div>
  );
}
