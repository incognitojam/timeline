import { createSignal, createUniqueId, For, onMount, Show } from "solid-js";
import { useContacts } from "../lib/queries";
import type { ContactWithStats } from "../lib/types";
import { IconClose } from "../ui/icons";

interface Props {
  selectedContactIds: number[];
  onChange: (contactIds: number[]) => void;
  placeholder?: string;
  /** Offer hidden contacts too, marked as such. */
  includeHidden?: boolean;
  /** Names the search field for screen readers. */
  label?: string;
  autofocus?: boolean;
}

export default function ContactSelector(props: Props) {
  const [search, setSearch] = createSignal("");
  const [isOpen, setIsOpen] = createSignal(false);
  // The highlighted suggestion, moved with the arrow keys and chosen with Enter
  // once the user has typed or moved it, so Enter in a form still submits.
  const [active, setActive] = createSignal(0);
  const [picking, setPicking] = createSignal(false);
  const inputId = createUniqueId();
  const listId = createUniqueId();
  let input: HTMLInputElement | undefined;
  onMount(() => {
    // Inside <Show>, the field is in the document only after this runs.
    if (props.autofocus) queueMicrotask(() => input?.focus());
  });

  const contactsQuery = useContacts(() => ({ includeHidden: props.includeHidden ?? false }));
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
    setActive(0);
    setPicking(false);
  }

  const shown = () => filteredContacts().slice(0, 20);
  const optionId = (index: number) => `${listId}-${index}`;
  const listOpen = () => isOpen() && shown().length > 0;

  function handleRemove(contactId: number) {
    props.onChange(props.selectedContactIds.filter(id => id !== contactId));
  }

  function handleInputKeyDown(e: KeyboardEvent) {
    // Remove last selected contact on backspace when input is empty
    if (e.key === "Backspace" && search() === "" && props.selectedContactIds.length > 0) {
      const newIds = props.selectedContactIds.slice(0, -1);
      props.onChange(newIds);
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setIsOpen(true);
      const last = shown().length - 1;
      setActive((index) => Math.max(0, Math.min(last, index + (e.key === "ArrowDown" ? 1 : -1))));
      setPicking(true);
      document.getElementById(optionId(active()))?.scrollIntoView({ block: "nearest" });
    }
    if (e.key === "Enter" && listOpen() && picking()) {
      const contact = shown()[active()];
      if (contact) {
        e.preventDefault();
        handleSelect(contact);
      }
    }
    // Close dropdown on escape
    if (e.key === "Escape" && listOpen()) {
      e.stopPropagation();
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
                aria-label={`Remove ${contact.display_name}`}
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
          ref={input}
          id={inputId}
          type="text"
          role="combobox"
          aria-label={props.label ?? "Search contacts"}
          aria-autocomplete="list"
          aria-expanded={listOpen()}
          aria-controls={listOpen() ? listId : undefined}
          aria-activedescendant={listOpen() ? optionId(active()) : undefined}
          class="flex-1 min-w-[100px] bg-transparent outline-none text-sm"
          placeholder={props.selectedContactIds.length === 0 ? (props.placeholder || "Search contacts...") : ""}
          value={search()}
          onInput={(e) => {
            setSearch(e.currentTarget.value);
            setActive(0);
            setPicking(true);
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
      <Show when={listOpen()}>
        <div id={listId} role="listbox" class="absolute z-50 w-full mt-1 max-h-48 overflow-auto rounded border border-border bg-background shadow-lg">
          <For each={shown()}>
            {(contact, index) => (
              <button
                type="button"
                id={optionId(index())}
                role="option"
                tabindex="-1"
                aria-selected={index() === active()}
                class="w-full text-left px-3 py-2 hover:bg-accent text-sm"
                classList={{ "bg-accent": index() === active() }}
                onMouseDown={(e) => {
                  // Prevent blur from firing before click
                  e.preventDefault();
                }}
                onClick={() => handleSelect(contact)}
              >
                <div class="font-medium">
                  {contact.display_name}
                  <Show when={contact.hidden}><span class="ml-2 text-xs font-normal text-muted-foreground">Hidden</span></Show>
                </div>
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
