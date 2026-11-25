import type { HandbookSpaceList } from "@connector/shared/api/sources";
import type { Db } from "../db/client";
import { conflict } from "../http/errors";
import { handbookSpaces } from "./handbook";
import { getSource } from "./service";
import { administerSource } from "./use";

/** Handbook's spaces, for choosing the rule spaces (setup guide, operator command). */
export async function listHandbookSpaces(db: Db, id: string): Promise<HandbookSpaceList> {
  const row = await getSource(db, id);
  if (row.kind !== "handbook") throw conflict("Only Handbook sources have spaces");
  const use = await administerSource(db, row, (_, context) => handbookSpaces(context));
  if (!use.ok) throw conflict(use.error.message);
  return { items: use.value };
}
