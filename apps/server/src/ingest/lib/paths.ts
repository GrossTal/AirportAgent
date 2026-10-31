import path from "node:path";

export const ROOT_DIR = path.resolve(import.meta.dirname, "../../../../..");
export const RAW_DIR = path.join(ROOT_DIR, "data", "raw"); // downloaded source files, gitignored
export const SEED_DIR = path.join(ROOT_DIR, "data", "seed"); // processed snapshot, committed
