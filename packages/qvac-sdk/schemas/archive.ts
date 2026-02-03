import { z } from "zod";

export const SUPPORTED_ARCHIVE_EXTENSIONS = [
  ".tar",
  ".tar.gz",
  ".tgz",
] as const;

export const archiveTypeSchema = z.enum(["tar", "tar.gz"]);

export const filenameToArchiveTypeSchema = z
  .string()
  .transform((filename): ArchiveType | null => {
    const lower = filename.toLowerCase();
    if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
    if (lower.endsWith(".tar")) return "tar";
    return null;
  });

export type ArchiveType = z.infer<typeof archiveTypeSchema>;
