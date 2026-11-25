import admin from "./admin";
import directory from "./directory";
import meta from "./meta";
import proposals from "./proposals";
import search from "./search";
import sources from "./sources";
import status from "./status";
import tokens from "./tokens";

/** Routers mounted under /api/v1. */
export const API_MODULES = [meta, search, proposals, sources, tokens, directory, admin, status];
