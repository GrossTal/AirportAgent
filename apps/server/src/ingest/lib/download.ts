import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import { RAW_DIR } from "./paths.js";

/** Downloads `url` to data/raw/<relPath> once; later runs reuse the cached file. */
export async function downloadCached(url: string, relPath: string): Promise<string> {
  const dest = path.join(RAW_DIR, relPath);
  if (existsSync(dest)) return dest;

  await mkdir(path.dirname(dest), { recursive: true });
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}): ${url}`);

  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body as ReadableStream), createWriteStream(tmp));
  await rename(tmp, dest);
  return dest;
}

export async function urlExists(url: string): Promise<boolean> {
  const res = await fetch(url, { method: "HEAD" });
  return res.ok;
}
