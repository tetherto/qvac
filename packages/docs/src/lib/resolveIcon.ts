import { createElement } from "react";
import { icons } from "lucide-react";

export function resolveIcon(icon?: string) {
  if (!icon) return undefined;
  if (icon in icons) return createElement(icons[icon as keyof typeof icons]);
  return undefined;
}
