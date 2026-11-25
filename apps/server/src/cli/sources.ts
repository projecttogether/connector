import { sourceCreateSchema, sourceUpdateSchema, type Source } from "@connector/shared/api/sources";
import { SOURCE_KIND_INFO, type SourceKind } from "@connector/shared/sources";
import { getDb } from "../db/client";
import { parseWith } from "../http/errors";
import { checkSource } from "../sources/health";
import {
  createSource,
  deleteSource,
  getSource,
  isWebhookKind,
  listSources,
  sourceView,
  updateSource,
} from "../sources/service";
import { listHandbookSpaces } from "../sources/spaces";
import { UsageError } from "./io";
import type { Setting, SettingRow } from "./settings";

/** What each kind's secret is called in the list. */
const SECRET_LABELS: Record<SourceKind, string> = {
  handbook: "service token",
  crm: "API key",
  notion: "integration secret",
  logbook: "webhook secret",
  library: "webhook secret",
  itkb: "webhook secret",
};

/** What the Sources page shows at a glance; never a secret. */
function row(source: Source): SettingRow {
  const hints = [
    `${SOURCE_KIND_INFO[source.kind].label} "${source.name}" (${source.slug})`,
    URL.parse(String(source.config.baseUrl))?.origin ?? "no address",
    source.accessGroups.length > 0 ? `groups ${source.accessGroups.join(", ")}` : "everyone signed in",
  ];
  if (source.serviceAccess) hints.push("open to service tokens");
  if (!source.enabled) hints.push("off");
  // Each kind has one secret field.
  const [hint] = Object.values(source.secrets);
  hints.push(`${hint === undefined ? "no " : ""}${SECRET_LABELS[source.kind]}${hint ? ` ${hint}` : ""}`);
  if (source.webhookUrl) {
    hints.push(`webhook ${source.webhookUrl}`);
    const last = source.stats?.lastDeliveryAt;
    hints.push(last ? `items ${source.stats!.items}, last delivery ${last}` : "no delivery yet");
  }
  const { status } = source;
  if (status) hints.push(`status ${status.ok ? "ok" : "failed"} ${status.at}`);
  return { name: "sources", id: source.id, state: hint === undefined ? "incomplete" : "set", hints };
}

const SHOW_USAGE = "cli settings show sources [--id <id> [--spaces]]";

/** `sources`: the connected apps, a list (Administration → Sources, /api/v1/admin/sources). */
export const sources: Setting = {
  name: "sources",
  label: "the connected apps, one entry per source (Administration → Sources)",
  async rows() {
    const list = await listSources(getDb());
    if (list.length === 0) return [{ name: "sources", state: "not set", hints: ["no sources"] }];
    return list.map(row);
  },
  // `--spaces`: Handbook's spaces, for the rule spaces in the body.
  showOptions: { options: { spaces: { type: "boolean" } }, usage: SHOW_USAGE },
  async show(id, { spaces }) {
    if (id === undefined) {
      if (spaces) throw new UsageError("Give the Handbook source's --id.", SHOW_USAGE);
      return { items: await listSources(getDb()) };
    }
    const db = getDb();
    return spaces ? listHandbookSpaces(db, id) : sourceView(db, await getSource(db, id));
  },
  async apply(actor, body, id) {
    const db = getDb();
    if (id !== undefined) {
      return { json: await updateSource(db, actor, id, parseWith(sourceUpdateSchema, body)) };
    }
    const created = await createSource(db, actor, parseWith(sourceCreateSchema, body));
    const needsSecret = isWebhookKind(created.kind) && Object.keys(created.secrets).length === 0;
    return {
      json: created,
      note:
        `Connected the source ${created.name}. ID: ${created.id}` +
        (needsSecret
          ? `\nNext: (umask 077; set -C; docker compose exec -T web cli tokens create webhook-secret --source ${created.id} > secret.txt), then the secret and the URL ${created.webhookUrl} in ${SOURCE_KIND_INFO[created.kind].label}.`
          : ""),
    };
  },
  async remove(actor, id) {
    const db = getDb();
    const { name } = await getSource(db, id);
    await deleteSource(db, actor, id);
    return `Removed the source ${name} and everything Connector kept of it.`;
  },
  test: (id) => checkSource(getDb(), id),
};
