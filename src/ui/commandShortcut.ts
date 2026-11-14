type ShortcutEvent = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey" | "isComposing"
>;

export const DEFAULT_COMMAND_SHORTCUT = "Shift+P";

let shortcutCaptureActive = false;

export function setShortcutCaptureActive(active: boolean): void {
  shortcutCaptureActive = active;
}

export function isShortcutCaptureActive(): boolean {
  return shortcutCaptureActive;
}

const MODIFIER_KEYS: Record<string, string> = {
  Ctrl: "ctrlKey",
  Alt: "altKey",
  Shift: "shiftKey",
  Meta: "metaKey",
};

const MODIFIER_KEY_NAMES = new Set(["Control", "Alt", "Shift", "Meta", "OS"]);

function normalizeKey(key: string): string {
  if (key === " ") return "Space";
  if (key === "+") return "Plus";
  return key.length === 1 ? key.toUpperCase() : key;
}

export function formatShortcut(event: ShortcutEvent): string | null {
  if (
    event.isComposing ||
    event.key === "Escape" ||
    event.key === "Dead" ||
    event.key === "Unidentified" ||
    MODIFIER_KEY_NAMES.has(event.key)
  )
    return null;

  const modifiers = [
    event.ctrlKey && "Ctrl",
    event.altKey && "Alt",
    event.shiftKey && "Shift",
    event.metaKey && "Meta",
  ].filter(Boolean);
  if (!modifiers.length || !event.key) return null;

  return [...modifiers, normalizeKey(event.key)].join("+");
}

export function matchesShortcut(
  event: ShortcutEvent,
  shortcut: string,
): boolean {
  const parts = shortcut.split("+");
  const key = parts.pop();
  if (!key) return false;

  const enabled = new Set<string>();
  for (const part of parts) {
    if (!Object.hasOwn(MODIFIER_KEYS, part) || enabled.has(part)) return false;
    enabled.add(part);
  }
  if (!enabled.size) return false;

  const expectedKey = key === "Space" ? " " : key === "Plus" ? "+" : key;
  if (
    normalizeKey(event.key).toLowerCase() !==
    normalizeKey(expectedKey).toLowerCase()
  )
    return false;

  return Object.entries(MODIFIER_KEYS).every(
    ([modifier, property]) =>
      Boolean(event[property as keyof ShortcutEvent]) === enabled.has(modifier),
  );
}
