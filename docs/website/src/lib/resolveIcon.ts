import { createElement } from "react";
import { icons } from "lucide-react";
import {
  SiElectron,
  SiExpo,
  SiPython,
  SiTypescript,
} from "@icons-pack/react-simple-icons";

/**
 * Brand marks the site may draw, beyond Lucide's set. An icon reaches this
 * resolver as a string — written in a page's frontmatter, in a `meta.json`, or
 * beside a sidebar entry declared in the source — so this list is what keeps
 * the icon set a decision rather than a dependency's surface area.
 *
 * Sized here because a Lucide glyph carries its own default and these do not.
 */
const brandIcons = { SiElectron, SiExpo, SiPython, SiTypescript };

/**
 * The one place a string becomes an icon element. Both declaration sites reach
 * it — Fumadocs' `icon` hook for an entry a collection declares in its
 * content, and `custom-tree.ts` for a collection that declares its navigation
 * in the source — so the two can never disagree about what the site can draw.
 *
 * A name in neither set resolves to nothing, leaving the entry without an icon
 * rather than failing the build.
 */
export function resolveIcon(icon?: string) {
  if (!icon) return undefined;
  if (icon in brandIcons) {
    return createElement(brandIcons[icon as keyof typeof brandIcons], {
      className: "h-4 w-4",
    });
  }
  if (icon in icons) return createElement(icons[icon as keyof typeof icons]);
  return undefined;
}
