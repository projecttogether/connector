import type { z } from "zod";
import {
  crmConfigSchema,
  crmSecretSchema,
  handbookConfigSchema,
  handbookSecretSchema,
  itkbConfigSchema,
  libraryConfigSchema,
  logbookConfigSchema,
  notionConfigSchema,
  notionSecretSchema,
  webhookSecretSchema,
} from "@connector/shared/api/sources";
import type { SourceKind } from "@connector/shared/sources";
import { crmAdapter } from "./crm";
import { handbookAdapter } from "./handbook";
import { itkbAdapter } from "./itkb";
import { libraryAdapter } from "./library";
import { logbookAdapter } from "./logbook";
import { notionAdapter } from "./notion";
import type { Adapter } from "./types";

/** Everything Connector knows about a kind of source. */
export const KINDS: Record<
  SourceKind,
  { adapter: Adapter; config: z.ZodType<Record<string, unknown>>; secret: z.ZodType<Record<string, unknown>> }
> = {
  handbook: { adapter: handbookAdapter, config: handbookConfigSchema, secret: handbookSecretSchema },
  crm: { adapter: crmAdapter, config: crmConfigSchema, secret: crmSecretSchema },
  notion: { adapter: notionAdapter, config: notionConfigSchema, secret: notionSecretSchema },
  logbook: { adapter: logbookAdapter, config: logbookConfigSchema, secret: webhookSecretSchema },
  library: { adapter: libraryAdapter, config: libraryConfigSchema, secret: webhookSecretSchema },
  itkb: { adapter: itkbAdapter, config: itkbConfigSchema, secret: webhookSecretSchema },
};

export function isSourceKind(value: string): value is SourceKind {
  return value in KINDS;
}
