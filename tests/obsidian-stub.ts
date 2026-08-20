export type App = object;

export interface CachedMetadata {
  frontmatter?: Record<string, unknown>;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  minAppVersion: string;
  description: string;
  author: string;
  isDesktopOnly: boolean;
}

export class Notice {
  constructor(
    readonly message: string,
    readonly timeout?: number,
  ) {}
}

export class TFile {
  readonly name: string;
  readonly basename: string;
  readonly extension: string;

  constructor(readonly path: string) {
    this.name = path.split("/").at(-1) ?? path;
    const separator = this.name.lastIndexOf(".");
    this.basename = separator === -1 ? this.name : this.name.slice(0, separator);
    this.extension = separator === -1 ? "" : this.name.slice(separator + 1);
  }
}

export class Plugin {
  settings?: unknown;

  constructor(
    readonly app: App,
    readonly manifest: PluginManifest,
  ) {}

  onload(): Promise<void> | void {}

  onunload(): void {}

  addSettingTab(_tab: unknown): void {}

  addCommand(_command: unknown): void {}

  registerEvent(_event: unknown): void {}

  register(_cleanup: () => void): void {}

  registerEditorExtension(_extension: unknown): void {}

  registerMarkdownPostProcessor(_processor: unknown): void {}

  async loadData(): Promise<unknown> {
    return null;
  }

  async saveData(_data: unknown): Promise<void> {}
}

export class PluginSettingTab {
  readonly containerEl = { empty() {} };

  constructor(
    readonly app: App,
    readonly plugin: Plugin,
  ) {}

  display(): void {}
}

export const editorInfoField = {} as unknown;

export function setIcon(_parent: unknown, _iconId: string): void {}

export class Modal {
  constructor(readonly app: App) {}

  open(): void {}

  close(): void {}
}

export class SecretComponent {}

export class Setting {}

export type DropdownComponent = object;

export async function requestUrl(_request: unknown): Promise<never> {
  throw new Error("Tests must inject a Google transport");
}
