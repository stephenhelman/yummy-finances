import { SEED_RULES } from "@/lib/rules/seed";
import { USER_RULES } from "@/lib/rules/user-rules";

/** Every rule that is persisted to the database: the seed rules plus the owner's confirmed rules. */
export const ALL_RULES = [...SEED_RULES, ...USER_RULES];
