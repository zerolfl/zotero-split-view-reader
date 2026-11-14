interface LegacyCommand {
  id: string;
  name: string;
  label: string;
  callback: () => void;
}

export interface PaletteCommandRegistration {
  id: string;
  name: string;
  description: string;
  run: () => Promise<void>;
}

interface LegacyPrompt {
  promptNode: HTMLElement;
  commands: LegacyCommand[];
  showCommands(commands: LegacyCommand[], clear: boolean): void;
}

export class LegacyCommands {
  private registrations = new Map<LegacyPrompt, LegacyCommand[]>();

  register(win: Window, commands: PaletteCommandRegistration[]): boolean {
    const prompt: LegacyPrompt | undefined = (Zotero as any)._toolkitGlobal
      ?.prompt?.instance;
    if (
      prompt?.promptNode?.ownerDocument !== win.document ||
      !Array.isArray(prompt.commands) ||
      typeof prompt.showCommands !== "function"
    )
      return false;
    let registered = this.registrations.get(prompt);
    if (!registered) {
      registered = commands.map(({ id, name, description, run }) => ({
        id,
        name,
        label: description,
        callback: () => {
          prompt.promptNode.style.display = "none";
          void run().catch((error) => Zotero.logError(error));
        },
      }));
      this.registrations.set(prompt, registered);
    }
    const missing = registered.filter(
      (command) => !prompt.commands.includes(command),
    );
    if (missing.length) {
      prompt.commands.push(...missing);
      if (prompt.promptNode.querySelectorAll(".commands-container").length <= 1)
        prompt.showCommands(prompt.commands, true);
    }
    return true;
  }

  unregister(win?: Window): void {
    for (const [prompt, commands] of this.registrations) {
      if (win && prompt.promptNode.ownerDocument !== win.document) continue;
      prompt.commands = prompt.commands.filter(
        (entry) => !commands.includes(entry),
      );
      for (const command of commands) command.callback = () => {};
      this.registrations.delete(prompt);
    }
  }
}
