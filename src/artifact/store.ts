import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { CapabilityArtifactSchema, type CapabilityArtifact } from "./schema.js";

const DEFAULT_ARTIFACTS_DIR = path.resolve(process.cwd(), "artifacts");

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export class ArtifactStore {
  constructor(private readonly dir: string = DEFAULT_ARTIFACTS_DIR) {
    mkdirSync(this.dir, { recursive: true });
  }

  private filePath(name: string): string {
    return path.join(this.dir, `${slugify(name)}.json`);
  }

  /** Saves an artifact, validating it against the schema first. Overwrites any prior version file. */
  save(artifact: CapabilityArtifact): string {
    const validated = CapabilityArtifactSchema.parse(artifact);
    const dest = this.filePath(validated.name);
    writeFileSync(dest, JSON.stringify(validated, null, 2), "utf-8");
    return dest;
  }

  load(fileOrName: string): CapabilityArtifact {
    const filePath = existsSync(fileOrName) ? fileOrName : this.filePath(fileOrName);
    const raw = readFileSync(filePath, "utf-8");
    return CapabilityArtifactSchema.parse(JSON.parse(raw));
  }

  /** Returns full, directly-loadable paths (not bare filenames — `load()` expects
   * either a real path or a raw capability name to slugify, and a bare filename like
   * "foo.json" is neither: existsSync() misses it relative to cwd, and slugify() would
   * mangle its own ".json" into "_json.json"). */
  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.join(this.dir, f));
  }
}
