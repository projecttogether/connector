import type { ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { MAX_NOTION_DATABASES } from "@connector/shared/api/sources";
import { AUTHORITY_LABELS, NOTION_AUTHORITIES, type NotionAuthority } from "@connector/shared/sources";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/i18n";
import { messages } from "./messages";

/** One database as the admin types it: its link or ID, and its level in the source order. */
export type NotionDatabaseRow = { id: string; authority: NotionAuthority };

export const emptyNotionDatabase = (): NotionDatabaseRow => ({ id: "", authority: "knowledge" });

/** The databases of a Notion source (source dialog, setup guide). */
export function NotionDatabasesField(props: {
  value: NotionDatabaseRow[];
  onChange: (value: NotionDatabaseRow[]) => void;
  /** The request's field errors (`config.databases…`). */
  fields: Record<string, string>;
  hint?: ReactNode;
}) {
  const t = useT(messages);
  const rows = props.value;
  const change = (index: number, row: Partial<NotionDatabaseRow>) =>
    props.onChange(rows.map((current, at) => (at === index ? { ...current, ...row } : current)));
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{t("notionDatabases")}</legend>
      <p className="text-muted-foreground text-sm">{props.hint ?? t("notionDatabasesHint")}</p>
      <ul className="space-y-2">
        {rows.map((row, index) => {
          const number = index + 1;
          const error =
            props.fields[`config.databases.${index}.id`] ?? props.fields[`config.databases.${index}`];
          return (
            // Rows have no identity of their own; their values are controlled.
            <li key={index} className="space-y-1">
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  aria-label={t("notionDatabaseLink", { number })}
                  placeholder="https://www.notion.so/…"
                  value={row.id}
                  autoComplete="off"
                  aria-invalid={Boolean(error)}
                  className="sm:flex-1"
                  onChange={(event) => change(index, { id: event.target.value })}
                />
                <div className="flex gap-2">
                  <Select
                    value={row.authority}
                    onValueChange={(value) => change(index, { authority: value as NotionAuthority })}
                  >
                    <SelectTrigger
                      aria-label={t("notionDatabaseLevel", { number })}
                      className="w-full sm:w-44"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {NOTION_AUTHORITIES.map((authority) => (
                        <SelectItem key={authority} value={authority}>
                          {AUTHORITY_LABELS[authority]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("notionDatabaseRemove", { number })}
                    disabled={rows.length === 1}
                    onClick={() => props.onChange(rows.filter((_, at) => at !== index))}
                  >
                    <X />
                  </Button>
                </div>
              </div>
              {error ? <FieldError>{error}</FieldError> : null}
            </li>
          );
        })}
      </ul>
      {props.fields["config.databases"] ? <FieldError>{props.fields["config.databases"]}</FieldError> : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={rows.length >= MAX_NOTION_DATABASES}
        onClick={() => props.onChange([...rows, emptyNotionDatabase()])}
      >
        <Plus />
        {t("notionDatabaseAdd")}
      </Button>
    </fieldset>
  );
}
