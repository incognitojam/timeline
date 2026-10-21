import Dialog from "../../ui/Dialog";

interface Props {
  isOpen: boolean;
  currentDate: string;
  onClose: () => void;
  onSelectDate: (date: string) => void;
}

export default function GoToDateDialog(props: Props) {
  let inputRef: HTMLInputElement | undefined;

  const handleSubmit = () => {
    if (inputRef?.value) {
      props.onSelectDate(inputRef.value);
      props.onClose();
    }
  };

  return (
    <Dialog open={props.isOpen} onClose={props.onClose} title="Go to date" class="max-w-80">
      <input
        ref={inputRef}
        type="date"
        value={props.currentDate}
        class="w-full px-3 py-2 bg-secondary border border-border rounded text-foreground mb-4"
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            handleSubmit();
          }
        }}
      />
      <div class="flex justify-end gap-2">
        <button class="px-3 py-1.5 text-sm rounded hover:bg-accent" onClick={props.onClose}>
          Cancel
        </button>
        <button
          class="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:bg-primary/90"
          onClick={handleSubmit}
        >
          Go
        </button>
      </div>
    </Dialog>
  );
}
