import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Must match `fontFamily` on OG layout for Satori / `ImageResponse`.
 */
export const INCONSOLATA_FAMILY = 'Inconsolata';

/**
 * Resolve the directory containing `Inconsolata-*.ttf` static fonts.
 * Order: `INCONSOLATA_OG_FONT_DIR` → `~/Documents/tether/Inconsolata/static` → vendored `fonts/inconsolata-static`.
 */
export function resolveInconsolataStaticDir(): string {
  const fromEnv = process.env.INCONSOLATA_OG_FONT_DIR;
  if (fromEnv && existsSync(fromEnv)) {
    return fromEnv;
  }
  const homeStatic = join(homedir(), 'Documents', 'tether', 'Inconsolata', 'static');
  if (existsSync(homeStatic)) {
    return homeStatic;
  }
  const vendored = join(process.cwd(), 'fonts', 'inconsolata-static');
  if (existsSync(vendored)) {
    return vendored;
  }
  throw new Error(
    'Inconsolata fonts not found for OG images. Set INCONSOLATA_OG_FONT_DIR, ' +
      'install fonts under ~/Documents/tether/Inconsolata/static, or add TTFs to fonts/inconsolata-static/.',
  );
}

/**
 * Load Inconsolata TTFs for `next/og` (weights used: 400 description, 800 title).
 */
export async function getInconsolataOgFonts() {
  const dir = resolveInconsolataStaticDir();
  const [regular, semiBold, extraBold] = await Promise.all([
    readFile(join(dir, 'Inconsolata-Regular.ttf')),
    readFile(join(dir, 'Inconsolata-SemiBold.ttf')),
    readFile(join(dir, 'Inconsolata-ExtraBold.ttf')),
  ]);

  return [
    { name: INCONSOLATA_FAMILY, data: regular, weight: 400 as const, style: 'normal' as const },
    { name: INCONSOLATA_FAMILY, data: semiBold, weight: 600 as const, style: 'normal' as const },
    { name: INCONSOLATA_FAMILY, data: extraBold, weight: 800 as const, style: 'normal' as const },
  ];
}
