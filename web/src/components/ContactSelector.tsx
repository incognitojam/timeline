import { createSignal, For, Show } from "solid-js";
import { useContacts } from "../lib/queries";
import type { ContactWithStats } from "../lib/types";
import { IconClose } from "../ui/icons";

interface Props {
  selectedContactIds: number[];
  onChange: (contactIds: number[]) => void;
  placeholder?: string;
}

export default function ContactSelector(props: Props) {
  const [search, setSearch] = createSignal("");
  const [isOpen, setIsOpen] = createSignal(false);

  const contactsQuery = useContacts();
  const allContacts = () => contactsQuery.data ?? [];

  const selectedContacts = () => {
    return props.selectedContactIds
      .map(id => allContacts().find(c => c.id === id))
      .filter((c): c is ContactWithStats => c !== undefined);
  };

  const filteredContacts = () => {
    const selected = new Set(props.selectedContactIds);
    const s = search().toLowerCase();
    return allContacts().filter(c =>
      !selected.has(c.id) && (!s || c.display_name.toLowerCase().includes(s))
    );
  };

  function handleSelect(contact: ContactWithStats) {
    props.onChange([...props.selectedContactIds, contact.id]);
    setSearch("");
  }

  function handleRemove(contactId: number) {
    props.onChange(props.selectedContactIds.filter(id => id !== contactId));
  }

  function handleInputKeyDown(e: KeyboardEvent) {
    // Remove last selected contact on backspace when input is empty
    if (e.key === "Backspace" && search() === "" && props.selectedContactIds.length > 0) {
      const newIds = props.selectedContactIds.slice(0, -1);
      props.onChange(newIds);
    }
    // Close dropdown on escape
    if (e.key === "Escape") {
      setIsOpen(false);
    }
  }

  const isLoadingSelected = () =>
    contactsQuery.isLoading && props.selectedContactIds.length > 0;

  return (
    <div class="relative">
      {/* Selected contacts as chips + input */}
      <div
        class="flex flex-wrap gap-1 min-h-[42px] px-3 py-2 rounded border border-border bg-background cursor-text"
        onClick={() => {
          setIsOpen(true);
          // Focus the input
          const input = document.getElementById("contact-search-input");
          input?.focus();
        }}
      >
        <Show when={isLoadingSelected()}>
          <span class="text-sm text-muted-foreground py-0.5">Loading contacts...</span>
        </Show>
        <For each={selectedContacts()}>
          {(contact) => (
            <span class="inline-flex items-center gap-1 px-2 py-0.5 bg-primary/10 text-primary text-sm rounded">
              {contact.display_name}
              <button
                type="button"
                class="hover:text-primary/70"
                onClick={(e) => {
                  e.stopPropagation();
                  handleRemove(contact.id);
                }}
              >
                <IconClose class="w-3 h-3" />
              </button>
            </span>
          )}
        </For>
        <input
          id="contact-search-input"
          type="text"
          class="flex-1 min-w-[100px] bg-transparent outline-none text-sm"
          placeholder={props.selectedContactIds.length === 0 ? (props.placeholder || "Search contacts...") : ""}
          value={search()}
          onInput={(e) => {
            setSearch(e.currentTarget.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          onBlur={() => {
            // Delay closing to allow click events on dropdown
            setTimeout(() => setIsOpen(false), 200);
          }}
          onKeyDown={handleInputKeyDown}
        />
      </div>

      {/* Dropdown */}
      <Show when={isOpen() && filteredContacts().length > 0}>
        <div class="absolute z-50 w-full mt-1 max-h-48 overflow-auto rounded border border-border bg-background shadow-lg">
          <For each={filteredContacts().slice(0, 20)}>
            {(contact) => (
              <button
                type="button"
                class="w-full text-left px-3 py-2 hover:bg-accent text-sm"
                onMouseDown={(e) => {
                  // Prevent blur from firing before click
                  e.preventDefault();
                }}
                onClick={() => handleSelect(contact)}
              >
                <div class="font-medium">{contact.display_name}</div>
                <Show when={contact.notes}>
                  <div class="text-xs text-muted-foreground truncate">{contact.notes}</div>
                </Show>
              </button>
            )}
          </For>
          <Show when={filteredContacts().length > 20}>
            <div class="px-3 py-2 text-xs text-muted-foreground">
              {filteredContacts().length - 20} more contacts...
            </div>
          </Show>
        </div>
      </Show>

      {/* No results message */}
      <Show when={isOpen() && search() && filteredContacts().length === 0 && !contactsQuery.isLoading}>
        <div class="absolute z-50 w-full mt-1 px-3 py-2 rounded border border-border bg-background shadow-lg text-sm text-muted-foreground">
          No contacts found
        </div>
      </Show>
    </div>
  );
}
