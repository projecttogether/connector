import { useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import {
  CRM_RECORD_TYPES,
  NOTION_APP_URL,
  type CrmRecordType,
  type Source,
  type SourceCreate,
  type SourceUpdate,
} from "@connector/shared/api/sources";
import {
  NOTION_AUTHORITIES,
  SOURCE_KIND_INFO,
  type NotionAuthority,
  type SourceKind,
} from "@connector/shared/sources";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { SecretInput } from "@/components/ui/secret-input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/i18n";
import { common } from "@/i18n/common";
import { ApiError, errorMessage } from "@/lib/api";
import { messages } from "./messages";
import { emptyNotionDatabase, NotionDatabasesField, type NotionDatabaseRow } from "./notion-databases";

/** The form's values; the request body is built per kind (`createBody`, `updateBody`). */
export type SourceForm = {
  kind: SourceKind;
  name: string;
  slug: string;
  description: string;
  enabled: boolean;
  accessGroups: string;
  serviceAccess: boolean;
  baseUrl: string;
  serviceToken: string;
  ruleSpaces: string;
  allowLinking: boolean;
  apiKey: string;
  types: CrmRecordType[];
  teamGroupPrefix: string;
  /** IT Knowledge Base: sections whose pages rank as rules, comma-separated. */
  ruleSections: string;
  webhookSecret: string;
  integrationSecret: string;
  databases: NotionDatabaseRow[];
  /** Notion's API as stored (set only from the command line, e.g. a proxy); kept as it is. */
  apiUrl: string;
};

const DEFAULT_TYPES: CrmRecordType[] = ["contact", "organization", "deal", "event", "meeting"];

export function emptyForm(kind: SourceKind = "handbook"): SourceForm {
  return {
    kind,
    name: "",
    slug: "",
    description: "",
    enabled: true,
    accessGroups: "",
    serviceAccess: false,
    baseUrl: kind === "notion" ? NOTION_APP_URL : "",
    serviceToken: "",
    ruleSpaces: "",
    allowLinking: true,
    apiKey: "",
    types: DEFAULT_TYPES,
    teamGroupPrefix: "",
    ruleSections: kind === "itkb" ? "policies" : "",
    webhookSecret: "",
    integrationSecret: "",
    databases: [emptyNotionDatabase()],
    apiUrl: "",
  };
}

const isNotionAuthority = (value: unknown): value is NotionAuthority =>
  (NOTION_AUTHORITIES as readonly unknown[]).includes(value);

/** The stored databases of a Notion source; one empty row when there are none. */
function databasesOf(value: unknown): NotionDatabaseRow[] {
  const rows = Array.isArray(value)
    ? value.flatMap((database: unknown) =>
        typeof database === "object" &&
        database !== null &&
        "id" in database &&
        typeof database.id === "string"
          ? [
              {
                id: database.id,
                authority:
                  "authority" in database && isNotionAuthority(database.authority)
                    ? database.authority
                    : ("knowledge" as const),
              },
            ]
          : [],
      )
    : [];
  return rows.length > 0 ? rows : [emptyNotionDatabase()];
}

const list = (value: string) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** The form of a stored source; secret fields start blank (blank keeps them). */
export function formOf(source: Source): SourceForm {
  const config = source.config;
  return {
    ...emptyForm(source.kind),
    name: source.name,
    slug: source.slug,
    description: source.description ?? "",
    enabled: source.enabled,
    accessGroups: source.accessGroups.join(", "),
    serviceAccess: source.serviceAccess,
    baseUrl: text(config.baseUrl),
    ruleSpaces: Array.isArray(config.ruleSpaces) ? (config.ruleSpaces as string[]).join(", ") : "",
    allowLinking: config.allowLinking !== false,
    types: Array.isArray(config.types) ? (config.types as CrmRecordType[]) : DEFAULT_TYPES,
    teamGroupPrefix: text(config.teamGroupPrefix),
    ruleSections: Array.isArray(config.ruleSections) ? (config.ruleSections as string[]).join(", ") : "",
    databases: databasesOf(config.databases),
    apiUrl: text(config.apiUrl),
  };
}

/** A slug from a name: lowercase letters, digits and hyphens, starting with a letter. */
export function slugFrom(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

export function configOf(form: SourceForm): Record<string, unknown> {
  const baseUrl = form.baseUrl.trim();
  switch (form.kind) {
    case "handbook":
      return { baseUrl, ruleSpaces: list(form.ruleSpaces), allowLinking: form.allowLinking };
    case "crm":
      return { baseUrl, types: form.types };
    case "library":
      return { baseUrl, teamGroupPrefix: form.teamGroupPrefix.trim() || null };
    case "itkb":
      return { baseUrl, ruleSections: list(form.ruleSections) };
    case "logbook":
      return { baseUrl };
    case "notion":
      return {
        baseUrl,
        databases: form.databases.map((database) => ({
          id: database.id.trim(),
          authority: database.authority,
        })),
        ...(form.apiUrl ? { apiUrl: form.apiUrl } : {}),
      };
  }
}

function secretOf(form: SourceForm): Record<string, string> {
  const pick = (key: string, value: string) => (value.trim() ? { [key]: value.trim() } : {});
  switch (form.kind) {
    case "handbook":
      return pick("serviceToken", form.serviceToken);
    case "crm":
      return pick("apiKey", form.apiKey);
    case "notion":
      return pick("integrationSecret", form.integrationSecret);
    case "logbook":
    case "library":
    case "itkb":
      return pick("webhookSecret", form.webhookSecret);
  }
}

export function createBody(form: SourceForm): SourceCreate {
  return {
    kind: form.kind,
    slug: form.slug.trim(),
    name: form.name.trim(),
    description: form.description.trim() || null,
    enabled: form.enabled,
    accessGroups: list(form.accessGroups),
    serviceAccess: form.serviceAccess,
    config: configOf(form),
    secret: secretOf(form),
  } as SourceCreate;
}

export function updateBody(form: SourceForm): SourceUpdate {
  const secret = secretOf(form);
  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    enabled: form.enabled,
    accessGroups: list(form.accessGroups),
    serviceAccess: form.serviceAccess,
    config: configOf(form),
    ...(Object.keys(secret).length > 0 ? { secret } : {}),
  };
}

function TextField(props: {
  id: string;
  label: string;
  hint?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  required?: boolean;
  type?: string;
  /** Hidden until shown with the eye button. */
  secret?: boolean;
  placeholder?: string;
  disabled?: boolean;
  autoComplete?: string;
}) {
  const input = {
    id: props.id,
    value: props.value,
    required: props.required,
    disabled: props.disabled,
    placeholder: props.placeholder,
    autoComplete: props.autoComplete ?? "off",
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
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <Field orientation="horizontal">
      <Switch id={props.id} checked={props.checked} onCheckedChange={props.onChange} />
      <div className="space-y-0.5">
        <FieldLabel htmlFor={props.id}>{props.label}</FieldLabel>
        {props.hint ? <FieldDescription>{props.hint}</FieldDescription> : null}
      </div>
    </Field>
  );
}

/** Edits a source; new sources are connected with the setup guides. */
export function SourceDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: Source;
  pending: boolean;
  error: unknown;
  onSubmit: (form: SourceForm) => void;
}) {
  const t = useT(messages);
  const tc = useT(common);
  const [form, setForm] = useState<SourceForm>(() => formOf(props.source));
  const set = <K extends keyof SourceForm>(key: K, value: SourceForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const fields = props.error instanceof ApiError ? (props.error.fields ?? {}) : {};
  const generalError =
    props.error && !(props.error instanceof ApiError && props.error.fields) ? props.error : null;
  const hint = (key: string, fallback: string) =>
    props.source.secrets[key] ? t("stored", { hint: props.source.secrets[key] }) : fallback;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onSubmit(form);
  };
  return (
    <Dialog open={props.open} onOpenChange={(open) => !props.pending && props.onOpenChange(open)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t("editTitle", { name: props.source.name })}</DialogTitle>
            <DialogDescription>{SOURCE_KIND_INFO[form.kind].holds}</DialogDescription>
          </DialogHeader>
          <TextField
            id="source-name"
            label={t("name")}
            hint={t("nameHint")}
            value={form.name}
            required
            error={fields.name}
            onChange={(value) => set("name", value)}
          />
          <TextField
            id="source-slug"
            label={t("slug")}
            hint={t("slugHint")}
            value={form.slug}
            required
            disabled
            onChange={() => undefined}
          />
          <Field data-invalid={Boolean(fields.description)}>
            <FieldLabel htmlFor="source-description">{t("description")}</FieldLabel>
            <Textarea
              id="source-description"
              rows={2}
              value={form.description}
              onChange={(event) => set("description", event.target.value)}
            />
            <FieldDescription>{t("descriptionHint")}</FieldDescription>
          </Field>
          <TextField
            id="source-url"
            label={form.kind === "notion" ? t("notionBaseUrl") : t("baseUrl")}
            hint={form.kind === "notion" ? t("notionBaseUrlHint") : t("baseUrlHint")}
            type="url"
            value={form.baseUrl}
            required
            error={fields["config.baseUrl"]}
            onChange={(value) => set("baseUrl", value)}
          />
          {form.kind === "handbook" ? (
            <>
              <TextField
                id="source-service-token"
                label={t("serviceToken")}
                hint={hint("serviceToken", t("serviceTokenHint"))}
                secret
                value={form.serviceToken}
                error={fields["secret.serviceToken"]}
                onChange={(value) => set("serviceToken", value)}
              />
              <TextField
                id="source-rule-spaces"
                label={t("ruleSpaces")}
                hint={t("ruleSpacesHint")}
                value={form.ruleSpaces}
                placeholder="purpose, policies"
                error={fields["config.ruleSpaces"]}
                onChange={(value) => set("ruleSpaces", value)}
              />
              <SwitchField
                id="source-linking"
                label={t("allowLinking")}
                hint={t("allowLinkingHint")}
                checked={form.allowLinking}
                onChange={(value) => set("allowLinking", value)}
              />
            </>
          ) : null}
          {form.kind === "crm" ? (
            <>
              <TextField
                id="source-api-key"
                label={t("apiKey")}
                hint={hint("apiKey", t("apiKeyHint"))}
                secret
                value={form.apiKey}
                error={fields["secret.apiKey"]}
                onChange={(value) => set("apiKey", value)}
              />
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">{t("types")}</legend>
                <div className="grid grid-cols-2 gap-2">
                  {CRM_RECORD_TYPES.map((type) => (
                    <label key={type} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={form.types.includes(type)}
                        onCheckedChange={(checked) =>
                          set(
                            "types",
                            checked ? [...form.types, type] : form.types.filter((item) => item !== type),
                          )
                        }
                      />
                      {t(`type_${type}`)}
                    </label>
                  ))}
                </div>
                <p className="text-muted-foreground text-sm">{t("typesHint")}</p>
                {fields["config.types"] ? (
                  <p className="text-destructive text-sm">{fields["config.types"]}</p>
                ) : null}
              </fieldset>
            </>
          ) : null}
          {form.kind === "notion" ? (
            <>
              <TextField
                id="source-integration-secret"
                label={t("integrationSecret")}
                hint={hint("integrationSecret", t("integrationSecretHint"))}
                secret
                value={form.integrationSecret}
                error={fields["secret.integrationSecret"]}
                onChange={(value) => set("integrationSecret", value)}
              />
              <NotionDatabasesField
                value={form.databases}
                fields={fields}
                onChange={(value) => set("databases", value)}
              />
            </>
          ) : null}
          {form.kind === "library" ? (
            <TextField
              id="source-team-prefix"
              label={t("teamGroupPrefix")}
              hint={t("teamGroupPrefixHint")}
              value={form.teamGroupPrefix}
              placeholder="/teams"
              error={fields["config.teamGroupPrefix"]}
              onChange={(value) => set("teamGroupPrefix", value)}
            />
          ) : null}
          {form.kind === "itkb" ? (
            <TextField
              id="source-rule-sections"
              label={t("ruleSections")}
              hint={t("ruleSectionsHint")}
              value={form.ruleSections}
              placeholder="policies"
              error={fields["config.ruleSections"]}
              onChange={(value) => set("ruleSections", value)}
            />
          ) : null}
          {SOURCE_KIND_INFO[form.kind].delivery === "webhook" ? (
            <TextField
              id="source-webhook-secret"
              label={t("webhookSecret")}
              hint={hint("webhookSecret", t("webhookSecretHint"))}
              secret
              value={form.webhookSecret}
              error={fields["secret.webhookSecret"]}
              onChange={(value) => set("webhookSecret", value)}
            />
          ) : null}
          <TextField
            id="source-groups"
            label={t("accessGroups")}
            hint={t("accessGroupsHint")}
            value={form.accessGroups}
            placeholder="/staff"
            error={fields.accessGroups}
            onChange={(value) => set("accessGroups", value)}
          />
          <SwitchField
            id="source-service-access"
            label={t("serviceAccess")}
            hint={t("serviceAccessHint")}
            checked={form.serviceAccess}
            onChange={(value) => set("serviceAccess", value)}
          />
          <SwitchField
            id="source-enabled"
            label={t("enabled")}
            checked={form.enabled}
            onChange={(value) => set("enabled", value)}
          />
          {generalError ? (
            <Alert variant="destructive">
              <AlertDescription>{errorMessage(generalError)}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={props.pending}
              onClick={() => props.onOpenChange(false)}
            >
              {tc("cancel")}
            </Button>
            <Button
              type="submit"
              disabled={props.pending || !form.name.trim() || !form.slug.trim() || !form.baseUrl.trim()}
            >
              {props.pending ? <Spinner /> : null}
              {t("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
