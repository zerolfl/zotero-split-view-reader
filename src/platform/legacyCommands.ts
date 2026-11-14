interface LegacyCommand {
  id: string;
  name: string;
  label: string;
  callback: () => void;
}

interface LegacyPrompt {
  promptNode: HTMLElement;
  commands: LegacyCommand[];
  showCommands(commands: LegacyCommand[], clear: boolean): void;
}

export class LegacyCommands {
  private registrations = new Map<LegacyPrompt, LegacyCommand>();

  register(win: Window, id: string, name: string, run: () => void): boolean {
    const prompt: LegacyPrompt | undefined = (Zotero as any)._toolkitGlobal
      ?.prompt?.instance;
    if (
      prompt?.promptNode?.ownerDocument !== win.document ||
      !Array.isArray(prompt.commands) ||
      typeof prompt.showCommands !== "function"
    )
      return false;
    let command = this.registrations.get(prompt);
    if (!command) {
      command = {
        id,
        name,
        label: "Split-View Reader",
        callback: () => {
          prompt.promptNode.style.display = "none";
          run();
        },
      };
      this.registrations.set(prompt, command);
    }
    if (!prompt.commands.includes(command)) {
      prompt.commands.push(command);
      if (prompt.promptNode.querySelectorAll(".commands-container").length <= 1)
        prompt.showCommands(prompt.commands, true);
    }
    return true;
  }

  unregister(win?: Window): void {
    for (const [prompt, command] of this.registrations) {
      if (win && prompt.promptNode.ownerDocument !== win.document) continue;
      prompt.commands = prompt.commands.filter((entry) => entry !== command);
      command.callback = () => {};
      this.registrations.delete(prompt);
    }
  }
}
