export function moveMouse(x: number, y: number): string {
  return `Input simulator placeholder: move mouse to (${x}, ${y})`;
}

export function clickMouse(button: "left" | "right" | "middle"): string {
  return `Input simulator placeholder: click ${button}`;
}

export function typeText(text: string): string {
  return `Input simulator placeholder: typed ${text.length} characters`;
}

export function shortcut(keys: string[]): string {
  return `Input simulator placeholder: shortcut ${keys.join("+")}`;
}

export function emergencyStop(): string {
  return "Input simulator emergency stop triggered";
}
