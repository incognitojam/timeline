import * as KDialog from "@kobalte/core/dialog";
import { type JSX, Show } from "solid-js";
import { IconClose } from "./icons";

interface DialogProps {
  open: boolean;
  /** Called for every close intent: Escape, backdrop click, or the close button. */
  onClose: () => void;
  title: JSX.Element;
  /** Optional subtitle rendered under the title (also the dialog's aria-description). */
  description?: JSX.Element;
  /** Panel width override, e.g. "max-w-[480px]"; the panel never exceeds the viewport. */
  class?: string;
  children: JSX.Element;
}

/**
 * Modal dialog. Content mounts fresh on each open, so children can
 * initialise local state from props at mount time.
 */
export default function Dialog(props: DialogProps) {
  return (
    <KDialog.Root open={props.open} onOpenChange={(open) => !open && props.onClose()}>
      <KDialog.Portal>
        <KDialog.Overlay class="fixed inset-0 z-50 bg-black/50" />
        <KDialog.Content
          class={`fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2 w-[calc(100vw-2rem)] max-h-[90vh] overflow-y-auto rounded-lg border border-border bg-popover text-popover-foreground p-6 shadow-lg ${props.class ?? "max-w-96"}`}
        >
          <div class="mb-4 pr-8">
            <KDialog.Title class="text-lg font-semibold">{props.title}</KDialog.Title>
            <Show when={props.description}>
              <KDialog.Description class="text-xs text-muted-foreground">
                {props.description}
              </KDialog.Description>
            </Show>
          </div>
          {props.children}
          {/* Rendered after the content so the first tab stop (and Kobalte's
              initial focus) is the content itself, not the close button. */}
          <KDialog.CloseButton
            class="absolute right-4 top-4 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            <IconClose class="w-5 h-5" />
          </KDialog.CloseButton>
        </KDialog.Content>
      </KDialog.Portal>
    </KDialog.Root>
  );
}
