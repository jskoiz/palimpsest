import { drizzle } from "drizzle-orm/d1";
import { getRuntimeEnv } from "../lib/palimpsest/runtime";
import * as schema from "./schema";

export function getDb() {
  return drizzle(getRuntimeEnv().DB, { schema });
}
