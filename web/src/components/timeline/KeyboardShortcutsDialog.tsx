import Dialog from "../../ui/Dialog";

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

const shortcuts = [
  { keys: ["t"], description: "Go to today" },
  { keys: ["g"], description: "Go to specific date" },
  { keys: ["p", "←"], description: "Previous day" },
  { keys: ["n", "→"], description: "Next day" },
  { keys: ["m"], description: "Toggle map" },
  { keys: ["s"], description: "Toggle AI summary" },
  { keys: ["j"], description: "Toggle journal" },
  { keys: ["?"], description: "Show keyboard shortcuts" },
];

export default function KeyboardShortcutsDialog(props: Props) {
  return (
    <Dialog open={props.isOpen} onClose={props.onClose} title="Keyboard shortcuts" class="max-w-80">
      <div class="space-y-2">
        {shortcuts.map((shortcut) => (
          <div class="flex items-center justify-between">
            <span class="text-muted-foreground">{shortcut.description}</span>
            <div class="flex gap-1">
              {shortcut.keys.map((key, i) => (
                <>
                  {i > 0 && <span class="text-muted-foreground text-xs">or</span>}
                  <kbd class="px-2 py-0.5 text-xs bg-secondary border border-border rounded">
                    {key}
                  </kbd>
                </>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div class="mt-4 flex justify-end">
        <button class="px-3 py-1.5 text-sm rounded hover:bg-accent" onClick={props.onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}
