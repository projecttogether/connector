import { useState, type ChangeEvent, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { ChevronDown } from "lucide-react";
import { CRM_RECORD_TYPES, type Source, type SourceCheck } from "@connector/shared/api/sources";
import { SOURCE_KIND_INFO, type SourceKind } from "@connector/shared/sources";
import { ErrorState, LoadingState } from "@/components/ui/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { SecretInput } from "@/components/ui/secret-input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/i18n";
import { ApiError, errorMessage } from "@/lib/api";
import {
  useAdminSources,
  useCheckSource,
  useCreateSource,
  useHandbookSpaces,
  useUpdateSource,
  useWebhookSecret,
} from "../api";
import { messages as adminMessages } from "../messages";
import { NotionDatabasesField } from "../notion-databases";
import { createBody, emptyForm, formOf, slugFrom, updateBody, type SourceForm } from "../source-dialog";
import { messages } from "./messages";
import { AppLink, baseUrlOf, CopyRow, GuideStep, Outcome, withLink } from "./steps";

const APP_NAMES: Record<SourceKind, string> = {
  handbook: "Handbook",
  crm: "CRM",
  logbook: "Logbook",
  library: "Library",
  notion: "Notion",
  itkb: "IT Knowledge Base",
};

/** Where Notion's integrations are made. */
const NOTION_INTEGRATIONS_URL = "https://www.notion.so/profile/integrations";

const isWebhook = (kind: SourceKind) => SOURCE_KIND_INFO[kind].delivery === "webhook";

/** A free name and short name for a new source: Logbook (`logbook`), else Logbook 2 (`logbook-2`), … */
function freeName(kind: SourceKind, taken: string[]): { name: string; slug: string } {
  for (let index = 1; ; index += 1) {
    const slug = index === 1 ? kind : `${kind}-${index}`;
    if (!taken.includes(slug))
      return { name: index === 1 ? APP_NAMES[kind] : `${APP_NAMES[kind]} ${index}`, slug };
  }
}

/**
 * The setup guide of a source app: where it is, its credentials (Handbook,
 * CRM, Notion and its databases) or its webhook (Logbook, Library), who may
 * use it, and a test or a wait for the first delivery. With `sourceId`, it continues an existing
 * source (e.g. from a problem on the status page).
 */
export function SourceGuide(props: { kind: SourceKind; sourceId?: string; onCreated: (id: string) => void }) {
  const t = useT(messages);
  const sources = useAdminSources();
  // Only the first load waits; later refreshes keep the guide and its state.
  const [initial] = useState(() => props.sourceId ?? null);
  if (sources.isLoading) return <LoadingState />;
  if (sources.isError || !sources.data)
    return <ErrorState error={sources.error} onRetry={() => void sources.refetch()} />;
  const existing = initial ? sources.data.items.find((source) => source.id === initial) : undefined;
  if (initial && !existing) return <p className="text-muted-foreground text-sm">{t("notFound")}</p>;
  return (
    <GuideBody
      kind={existing?.kind ?? props.kind}
      existing={existing}
      takenSlugs={sources.data.items.map((source) => source.slug)}
      onCreated={props.onCreated}
    />
  );
}

function TextField(props: {
  id: string;
  label: string;
  hint?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  type?: string;
  /** Hidden until shown with the eye button. */
  secret?: boolean;
  placeholder?: string;
  disabled?: boolean;
}) {
  const input = {
    id: props.id,
    value: props.value,
    disabled: props.disabled,
    placeholder: props.placeholder,
    autoComplete: "off",
    "aria-invalid": Boolean(props.error),
    onChange: (event: ChangeEvent<HTMLInputElement>) => props.onChange(event.target.value),
  };
  return (
    <Field data-invalid={Boolean(props.error)}>
      <FieldLabel htmlFor={props.id}>{props.label}</FieldLabel>
      {props.secret ? <SecretInput {...input} /> : <Input type={props.type ?? "text"} {...input} />}
      {props.hint ? <FieldDescription>{props.hint}</FieldDescription> : null}
      {props.error ? <FieldError>{props.error}</FieldError> : null}
    </Field>
  );
}

function SwitchField(props: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <Field orientation="horizontal">
      <Switch id={props.id} checked={props.checked} onCheckedChange={props.onChange} />
      <div className="space-y-0.5">
        <FieldLabel htmlFor={props.id}>{props.label}</FieldLabel>
        <FieldDescription>{props.hint}</FieldDescription>
      </div>
    </Field>
  );
}

function GuideBody(props: {
  kind: SourceKind;
  existing?: Source;
  takenSlugs: string[];
  onCreated: (id: string) => void;
}) {
  const t = useT(messages);
  const ta = useT(adminMessages);
  const { kind } = props;
  const app = APP_NAMES[kind];
  const webhook = isWebhook(kind);

  const [form, setForm] = useState<SourceForm>(() =>
    props.existing ? formOf(props.existing) : { ...emptyForm(kind), ...freeName(kind, props.takenSlugs) },
  );
  const [slugTouched, setSlugTouched] = useState(Boolean(props.existing));
  const [sourceId, setSourceId] = useState<string | null>(props.existing?.id ?? null);
  const [check, setCheck] = useState<SourceCheck | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof SourceForm>(key: K, value: SourceForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const create = useCreateSource();
  const update = useUpdateSource();
  const runCheck = useCheckSource();
  const rotate = useWebhookSecret();

  // After a secret made in this guide, only deliveries and statuses recorded
  // after it took effect (server time) count.
  const [since, setSince] = useState<string | null>(null);
  const fresh = (item: Source | undefined) => {
    const last = item?.stats?.lastDeliveryAt;
    return Boolean(last && (!since || last > since));
  };
  const working = (item: Source | undefined) => fresh(item) && item?.status?.ok !== false;
  // While a webhook source has no working delivery, the sources are polled.
  const sources = useAdminSources({
    poll: (items) => {
      const item = items.find((candidate) => candidate.id === sourceId);
      return webhook && item && !working(item) ? 3000 : false;
    },
  });
  const source = sourceId ? sources.data?.items.find((item) => item.id === sourceId) : undefined;
  const delivered = working(source);
  const refused = Boolean(source?.status && !source.status.ok && (!since || source.status.at > since));
  const [tests, setTests] = useState(0);

  const fields = error instanceof ApiError ? (error.fields ?? {}) : {};
  const generalError = error && !(error instanceof ApiError && error.fields) ? error : null;
  const [optionsOpen, setOptionsOpen] = useState(false);
  const base = baseUrlOf(form.baseUrl);
  const storedHint = (key: string) =>
    source?.secrets[key] ? t("stored", { hint: source.secrets[key] }) : undefined;

  /** Creates the source or saves its settings; returns its ID, or null when that failed. */
  const save = async (): Promise<string | null> => {
    setError(null);
    try {
      let id = sourceId;
      if (!id) {
        id = (await create.mutateAsync(createBody(form))).id;
        setSourceId(id);
        props.onCreated(id);
      } else {
        await update.mutateAsync({ id, update: updateBody(form) });
      }
      // Secrets are sent once; blank keeps them from now on.
      setForm((current) => ({
        ...current,
        serviceToken: "",
        apiKey: "",
        webhookSecret: "",
        integrationSecret: "",
      }));
      return id;
    } catch (failure) {
      setError(failure);
      if (failure instanceof ApiError && (failure.fields?.slug || failure.fields?.name)) setOptionsOpen(true);
      return null;
    }
  };

  const connectLive = async () => {
    setBusy(true);
    setCheck(null);
    const id = await save();
    if (id) {
      try {
        setCheck(await runCheck.mutateAsync(id));
        setTests((count) => count + 1);
      } catch (failure) {
        setError(failure);
      }
    }
    setBusy(false);
  };

  const connectWebhook = async () => {
    setBusy(true);
    const id = await save();
    const hasSecret = Boolean(source?.secrets.webhookSecret) || secret !== null;
    if (id && !hasSecret) {
      try {
        const created = await rotate.mutateAsync(id);
        setSince(created.createdAt);
        setSecret(created.webhookSecret);
      } catch (failure) {
        setError(failure);
      }
    }
    setBusy(false);
  };

  const newSecret = () => {
    if (!sourceId) return;
    rotate.mutate(sourceId, {
      onSuccess: (created) => {
        setSince(created.createdAt);
        setSecret(created.webhookSecret);
      },
      onError: (failure) => toast.error(errorMessage(failure)),
    });
  };

  // The latest test: this session's, else the last stored check.
  const tested: SourceCheck | null =
    check ?? (source?.status && !webhook ? { ok: source.status.ok, message: source.status.message } : null);
  const connected = Boolean(source) && tested?.ok === true;

  let number = 0;
  const next = () => (number += 1);

  const whereStep = (
    <GuideStep
      number={next()}
      title={t("whereTitle", { app })}
      description={kind === "notion" ? t("whereDescriptionNotion") : t("whereDescription")}
      done={Boolean(source)}
    >
      <TextField
        id="setup-url"
        label={t("address")}
        type="url"
        value={form.baseUrl}
        placeholder={kind === "notion" ? "https://www.notion.so/example-org" : `https://${kind}.example.org`}
        error={fields["config.baseUrl"]}
        onChange={(value) => set("baseUrl", value)}
      />
      <Collapsible open={optionsOpen} onOpenChange={setOptionsOpen}>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="-ml-2">
            <ChevronDown
              className={optionsOpen ? "rotate-180 transition-transform" : "transition-transform"}
            />
            {t("moreOptions")}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-4 pt-2">
          <TextField
            id="setup-name"
            label={t("name")}
            hint={t("nameHint")}
            value={form.name}
            error={fields.name}
            onChange={(value) => {
              set("name", value);
              if (!slugTouched) set("slug", slugFrom(value));
            }}
          />
          <TextField
            id="setup-slug"
            label={t("slug")}
            hint={t("slugHint")}
            value={form.slug}
            disabled={Boolean(sourceId)}
            error={fields.slug}
            onChange={(value) => {
              setSlugTouched(true);
              set("slug", value);
            }}
          />
          <Field>
            <FieldLabel htmlFor="setup-description">{t("description")}</FieldLabel>
            <Textarea
              id="setup-description"
              rows={2}
              value={form.description}
              onChange={(event) => set("description", event.target.value)}
            />
            <FieldDescription>{t("descriptionHint")}</FieldDescription>
          </Field>
        </CollapsibleContent>
      </Collapsible>
    </GuideStep>
  );

  const credentialStep =
    kind === "handbook" ? (
      <GuideStep number={next()} title={t("handbookTokenTitle")} done={connected}>
        <p className="text-sm">
          {withLink(
            t("handbookTokenText"),
            <AppLink href={base ? `${base}/admin/service-tokens` : null}>{t("handbookTokenLink")}</AppLink>,
          )}
        </p>
        <TextField
          id="setup-token"
          label={t("serviceToken")}
          secret
          value={form.serviceToken}
          hint={storedHint("serviceToken")}
          error={fields["secret.serviceToken"]}
          onChange={(value) => set("serviceToken", value)}
        />
      </GuideStep>
    ) : kind === "crm" ? (
      <GuideStep number={next()} title={t("crmKeyTitle")} done={connected}>
        <p className="text-sm">
          {withLink(
            t("crmKeyText"),
            <AppLink href={base ? `${base}/admin/api-keys` : null}>{t("crmKeyLink")}</AppLink>,
          )}
        </p>
        <p className="text-muted-foreground text-sm">{t("crmKeySees")}</p>
        <TextField
          id="setup-api-key"
          label={t("apiKey")}
          secret
          value={form.apiKey}
          hint={storedHint("apiKey")}
          error={fields["secret.apiKey"]}
          onChange={(value) => set("apiKey", value)}
        />
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">{t("types")}</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {CRM_RECORD_TYPES.map((type) => (
              <label key={type} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={form.types.includes(type)}
                  onCheckedChange={(checked) =>
                    set("types", checked ? [...form.types, type] : form.types.filter((item) => item !== type))
                  }
                />
                {ta(`type_${type}`)}
              </label>
            ))}
          </div>
          {fields["config.types"] ? (
            <p className="text-destructive text-sm">{fields["config.types"]}</p>
          ) : null}
        </fieldset>
      </GuideStep>
    ) : kind === "notion" ? (
      <>
        <GuideStep number={next()} title={t("notionIntegrationTitle")} done={connected}>
          <p className="text-sm">
            {withLink(
              t("notionIntegrationText"),
              <AppLink href={NOTION_INTEGRATIONS_URL}>{t("notionIntegrationLink")}</AppLink>,
            )}
          </p>
          <p className="text-muted-foreground text-sm">{t("notionIntegrationSees")}</p>
          <TextField
            id="setup-integration-secret"
            label={t("integrationSecret")}
            secret
            value={form.integrationSecret}
            hint={storedHint("integrationSecret")}
            error={fields["secret.integrationSecret"]}
            onChange={(value) => set("integrationSecret", value)}
          />
        </GuideStep>
        <GuideStep
          number={next()}
          title={t("notionDatabasesTitle")}
          description={t("notionDatabasesDescription")}
          done={connected}
        >
          <NotionDatabasesField
            value={form.databases}
            fields={fields}
            hint={t("notionDatabasesHint")}
            onChange={(value) => set("databases", value)}
          />
        </GuideStep>
      </>
    ) : null;

  const accessStep = (
    <GuideStep
      number={next()}
      title={t("accessTitle")}
      description={t("accessDescription")}
      done={webhook ? Boolean(source) : connected}
    >
      <TextField
        id="setup-groups"
        label={t("accessGroups")}
        hint={t("accessGroupsHint")}
        value={form.accessGroups}
        placeholder="/staff"
        error={fields.accessGroups}
        onChange={(value) => set("accessGroups", value)}
      />
      {kind === "itkb" ? (
        <TextField
          id="setup-rule-sections"
          label={t("ruleSections")}
          hint={t("ruleSectionsHint")}
          value={form.ruleSections}
          placeholder="policies"
          error={fields["config.ruleSections"]}
          onChange={(value) => set("ruleSections", value)}
        />
      ) : null}
      {kind === "library" ? (
        <TextField
          id="setup-team-prefix"
          label={t("teamGroupPrefix")}
          hint={t("teamGroupPrefixHint")}
          value={form.teamGroupPrefix}
          placeholder="/teams"
          error={fields["config.teamGroupPrefix"]}
          onChange={(value) => set("teamGroupPrefix", value)}
        />
      ) : null}
      {kind === "handbook" ? (
        <SwitchField
          id="setup-linking"
          label={t("allowLinking")}
          hint={t("allowLinkingHint")}
          checked={form.allowLinking}
          onChange={(value) => set("allowLinking", value)}
        />
      ) : null}
      <SwitchField
        id="setup-bots"
        label={t("serviceAccess")}
        hint={t("serviceAccessHint")}
        checked={form.serviceAccess}
        onChange={(value) => set("serviceAccess", value)}
      />
      {generalError ? (
        <Alert variant="destructive">
          <AlertDescription>{errorMessage(generalError)}</AlertDescription>
        </Alert>
      ) : null}
      {webhook ? (
        <Button
          type="button"
          disabled={busy || !form.baseUrl.trim() || !form.slug.trim()}
          onClick={() => void connectWebhook()}
        >
          {busy ? <Spinner /> : null}
          {busy ? t("connecting") : source ? ta("save") : t("connect")}
        </Button>
      ) : null}
    </GuideStep>
  );

  if (webhook) {
    const webhookUrl = source?.webhookUrl ?? "";
    const storedSecret = source?.secrets.webhookSecret;
    return (
      <div className="space-y-4">
        {whereStep}
        {accessStep}
        <GuideStep number={next()} title={t("sendTitle", { app })} done={delivered} locked={!source}>
          <p className="text-sm">
            {kind === "itkb"
              ? t("sendTextItkb")
              : withLink(
                  t("sendText", { app }),
                  <AppLink href={base ? `${base}/admin/integrations` : null}>{t("sendLink")}</AppLink>,
                )}
          </p>
          <CopyRow label={t("fieldWebhookUrl")} value={webhookUrl} testId="webhook-url" />
          {secret ? (
            <>
              <CopyRow
                // A new secret starts hidden, even when the one before was shown.
                key={secret}
                label={t("fieldSigningSecret")}
                value={secret}
                secret
                testId="webhook-secret"
              />
              <p className="text-muted-foreground text-sm">{t("shownOnce")}</p>
            </>
          ) : (
            <>
              {storedSecret ? (
                <p className="text-muted-foreground text-sm">{t("sendStored", { hint: storedSecret })}</p>
              ) : null}
              <Button type="button" variant="outline" disabled={rotate.isPending} onClick={newSecret}>
                {rotate.isPending ? <Spinner /> : null}
                {t("newSecret")}
              </Button>
            </>
          )}
          {kind === "itkb" ? null : (
            <p className="text-muted-foreground text-sm">{t("sendEnvironment", { app })}</p>
          )}
        </GuideStep>
        <GuideStep number={next()} title={t("waitTitle")} done={delivered} locked={!source}>
          {refused && source?.status ? (
            <Outcome state="failed" title={t("deliveryFailed", { app })}>
              {source.status.message}
            </Outcome>
          ) : delivered && source ? (
            <Outcome state="ok" title={t("received", { app })}>
              {t("receivedText", {
                message: source.status?.message ?? "",
                items: ta("items", { count: source.stats?.items ?? 0 }),
              })}
            </Outcome>
          ) : (
            <Outcome state="waiting" title={t("waiting", { app })}>
              <p>{kind === "itkb" ? t("waitingHintItkb") : t("waitingHint", { app })}</p>
            </Outcome>
          )}
          {delivered ? (
            <Button asChild>
              <Link to="/admin">{t("toStatus")}</Link>
            </Button>
          ) : null}
        </GuideStep>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {whereStep}
      {credentialStep}
      {accessStep}
      <GuideStep
        number={next()}
        title={t("testTitle")}
        description={t("testDescription", { app })}
        done={connected}
      >
        <Button
          type="button"
          disabled={busy || !form.baseUrl.trim() || !form.slug.trim()}
          onClick={() => void connectLive()}
        >
          {busy ? <Spinner /> : null}
          {busy ? t("testing") : source ? t("saveAndTest") : t("connectAndTest")}
        </Button>
        {tested && source && !busy ? (
          tested.ok ? (
            <Outcome state="ok" title={t("testOk")}>
              {tested.message}
            </Outcome>
          ) : (
            <Outcome state="failed" title={t("testFailed", { app })}>
              <p>{tested.message}</p>
              <p>{t("testFailedHint")}</p>
            </Outcome>
          )
        ) : null}
      </GuideStep>
      {kind === "handbook" ? (
        <RuleSpacesStep
          // A new test may have fixed the token: read the spaces again.
          key={tests}
          number={next()}
          sourceId={source ? sourceId : null}
          selected={form.ruleSpaces}
          onSave={async (ruleSpaces) => {
            if (!sourceId || !source) return;
            // Only the rule spaces change: unsaved edits above (e.g. the address) stay unsaved.
            await update.mutateAsync({ id: sourceId, update: { config: { ...source.config, ruleSpaces } } });
            set("ruleSpaces", ruleSpaces.join(", "));
            toast.success(t("ruleSpacesSaved"));
            // A missing rule space fails the check; test again with the new ones.
            setCheck(await runCheck.mutateAsync(sourceId));
          }}
        />
      ) : null}
      {connected ? (
        <Button asChild>
          <Link to="/admin">{t("toStatus")}</Link>
        </Button>
      ) : null}
    </div>
  );
}

/** Handbook only: the spaces whose pages rank first (purpose and rules). */
function RuleSpacesStep(props: {
  number: number;
  sourceId: string | null;
  selected: string;
  onSave: (ruleSpaces: string[]) => Promise<void>;
}) {
  const t = useT(messages);
  const spaces = useHandbookSpaces(props.sourceId);
  const initial = props.selected
    .split(",")
    .map((slug) => slug.trim())
    .filter(Boolean);
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const current = chosen ?? initial;
  // Rule spaces Handbook no longer has (renamed or removed) can be unticked.
  const missing = spaces.data
    ? initial.filter((slug) => !spaces.data.items.some((space) => space.slug === slug))
    : [];
  const choices = [
    ...(spaces.data?.items ?? []),
    ...missing.map((slug) => ({ slug, name: t("missingSpace") })),
  ];
  return (
    <GuideStep
      number={props.number}
      title={t("ruleSpacesTitle")}
      description={t("ruleSpacesDescription")}
      locked={!props.sourceId}
      done={Boolean(props.sourceId) && initial.length > 0 && chosen === null}
    >
      {spaces.isLoading ? (
        <LoadingState />
      ) : spaces.isError || !spaces.data ? (
        <ErrorState error={spaces.error} onRetry={() => void spaces.refetch()} />
      ) : choices.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("noSpaces")}</p>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            {choices.map((space) => (
              <label key={space.slug} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={current.includes(space.slug)}
                  onCheckedChange={(checked) =>
                    setChosen(
                      checked ? [...current, space.slug] : current.filter((slug) => slug !== space.slug),
                    )
                  }
                />
                <span>
                  {space.name} <span className="text-muted-foreground font-mono text-xs">{space.slug}</span>
                </span>
              </label>
            ))}
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={saving || chosen === null}
            onClick={() => {
              setSaving(true);
              props
                .onSave(current)
                .then(() => setChosen(null))
                .catch((failure: unknown) => toast.error(errorMessage(failure)))
                .finally(() => setSaving(false));
            }}
          >
            {saving ? <Spinner /> : null}
            {t("ruleSpacesSave")}
          </Button>
        </>
      )}
    </GuideStep>
  );
}
