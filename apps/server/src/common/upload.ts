import { BadRequestException } from '@nestjs/common';
import { tmpdir } from 'os';
import { resolve, sep } from 'path';

/**
 * The temp-file path multer wrote an upload to, checked to be inside the OS temp
 * directory before anything reads or deletes it. Multer picks the name itself, so
 * this should always pass; it is a guard against a path ever arriving from elsewhere.
 */
export function tempUploadPath(file: { path?: unknown } | undefined, field = 'file'): string {
  const p = file?.path;
  if (typeof p !== 'string' || !p) throw new BadRequestException(`Upload the file in the "${field}" field.`);
  const root = resolve(tmpdir());
  const full = resolve(p);
  if (!full.startsWith(root + sep)) throw new BadRequestException('The upload was not stored where expected.');
  return full;
}
