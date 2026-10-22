---
name: solidjs
description: "Applies SolidJS reactivity and component best practices. Use when editing SolidJS components, signals, stores, JSX control flow, or props."
---

# SolidJS Best Practices

## Quick Reference

| React | SolidJS | Notes |
|-------|---------|-------|
| `useState(0)` | `createSignal(0)` | Returns `[getter, setter]` |
| `count` | `count()` | Must call the getter |
| `useEffect(() => {}, [deps])` | `createEffect(() => {})` | Auto-tracks dependencies |
| `useMemo(() => {}, [deps])` | `createMemo(() => {})` | Auto-tracks, use for expensive computations |
| `useRef()` | `let ref` | Direct variable, no `.current` |
| `{condition && <X />}` | `<Show when={condition}><X /></Show>` | Control flow component |
| `{arr.map(x => <X />)}` | `<For each={arr}>{x => <X />}</For>` | Keyed by reference |
| Component re-renders | Component runs once | JSX expressions update, not the function |

## Critical Pitfalls

### Never Destructure Props

```tsx
// WRONG - Breaks reactivity!
function Greeting(props) {
  const { name } = props;  // Evaluated once, never updates
  return <div>Hello {name}</div>;
}

// CORRECT - Access in JSX (tracking scope)
function Greeting(props) {
  return <div>Hello {props.name}</div>;
}

// CORRECT - Wrap in function for derived value
function Greeting(props) {
  const name = () => props.name;
  return <div>Hello {name()}</div>;
}

// CORRECT - Use splitProps for spreading
function Button(props) {
  const [local, others] = splitProps(props, ["onClick", "children"]);
  return <button onClick={local.onClick} {...others}>{local.children}</button>;
}
```

### Never Destructure Stores

```tsx
const [store, setStore] = createStore({ user: { name: "Alice" } });

// WRONG
const { name } = store.user;  // Breaks reactivity

// CORRECT
const name = () => store.user.name;
// Or just use store.user.name directly in JSX
```

## Fine-Grained Reactivity

SolidJS updates only the specific DOM nodes that depend on changed signals - not entire components.

### Components Run Once

```tsx
function Counter() {
  console.log("This runs ONCE, not on every update");
  const [count, setCount] = createSignal(0);

  return (
    <div>
      {/* Only this text node updates when count changes */}
      <p>Count: {count()}</p>
      <button onClick={() => setCount(c => c + 1)}>+</button>
    </div>
  );
}
```

### Tracking Scopes

Signals only trigger updates when read inside a **tracking scope**:

```tsx
const [count, setCount] = createSignal(0);

// NOT tracked - runs once
console.log(count());

// Tracked - updates when count changes
createEffect(() => console.log(count()));

// Tracked - JSX is a tracking scope
return <span>{count()}</span>;
```

## Derived State (Prefer Over Effects)

### Simple Derived Values - Use Functions

```tsx
const [count, setCount] = createSignal(0);

// Derived state - recalculates on each access
const doubled = () => count() * 2;
const isEven = () => count() % 2 === 0;

return <div>{doubled()} is {isEven() ? "even" : "odd"}</div>;
```

### Expensive Computations - Use createMemo

```tsx
const [items, setItems] = createSignal([]);

// Cached - only recalculates when items change
const total = createMemo(() =>
  items().reduce((sum, item) => sum + item.price, 0)
);

// Multiple accesses don't re-run the computation
return (
  <div>
    <p>Total: {total()}</p>
    <p>With tax: {total() * 1.2}</p>
  </div>
);
```

### When to Use createMemo vs Functions

| Use Function `() => ...` | Use `createMemo()` |
|--------------------------|-------------------|
| Simple/cheap computations | Expensive computations |
| Single access point | Multiple access points |
| Don't need referential equality | Need stable reference |

## Effects - For Side Effects Only

**Don't use createEffect for derived state.** Use it for:
- DOM manipulation outside JSX
- Logging/debugging
- Syncing with external systems
- Subscriptions

```tsx
// WRONG - Use derived state instead
createEffect(() => {
  setDoubled(count() * 2);  // Don't do this!
});

// CORRECT - Side effect (external sync)
createEffect(() => {
  localStorage.setItem("count", count().toString());
});

// CORRECT - Cleanup with onCleanup
createEffect(() => {
  const subscription = subscribe(topic());
  onCleanup(() => subscription.unsubscribe());
});
```

## Stores for Nested Data

```tsx
import { createStore, produce } from "solid-js/store";

const [store, setStore] = createStore({
  user: { name: "Alice", settings: { theme: "dark" } },
  items: [{ id: 1, text: "Item 1" }]
});

// Access directly (no getter call)
console.log(store.user.name);

// Update with path syntax
setStore("user", "name", "Bob");
setStore("user", "settings", "theme", "light");
setStore("items", 0, "text", "Updated");

// Add to array
setStore("items", items => [...items, { id: 2, text: "Item 2" }]);

// Mutable-style with produce
setStore(produce(s => {
  s.user.name = "Charlie";
  s.items.push({ id: 3, text: "Item 3" });
}));
```

## Control Flow Components

### Show - Conditional Rendering

```tsx
// Basic usage
<Show when={isLoggedIn()} fallback={<LoginButton />}>
  <UserProfile />
</Show>
```

**Callback form for type narrowing** - avoids `!` assertions:

```tsx
// Without callback - need ! or optional chaining
<Show when={user()}>
  <div>{user()!.name}</div>
</Show>

// With callback - u() is guaranteed non-null
<Show when={user()}>
  {(u) => <div>{u().name}</div>}
</Show>
```

### For - Lists (Keyed by Reference)

```tsx
// For objects - item is stable, index is a signal
<For each={users()} fallback={<div>No users</div>}>
  {(user, index) => (
    <div>#{index()} - {user.name}</div>
  )}
</For>
```

### Index - Lists (Keyed by Index)

```tsx
// For primitives - index is stable, item is a signal
<Index each={names()}>
  {(name, index) => (
    <div>#{index} - {name()}</div>
  )}
</Index>
```

### Switch/Match - Multiple Conditions

```tsx
<Switch fallback={<Default />}>
  <Match when={status() === "loading"}><Loading /></Match>
  <Match when={status() === "error"}><Error /></Match>
  <Match when={status() === "success"}><Success /></Match>
</Switch>
```

## createResource for Async Data

Simpler than Solid Query when you don't need caching/invalidation:

```tsx
import { createResource, Suspense } from "solid-js";

// Basic fetch
const [data] = createResource(fetchUsers);

// With source signal - refetches when userId changes
const [userId, setUserId] = createSignal(1);
const [user, { refetch, mutate }] = createResource(userId, fetchUser);

// Usage
return (
  <Suspense fallback={<Loading />}>
    <Show when={user()}>{(u) => <Profile user={u()} />}</Show>
  </Suspense>
);

// Manual actions
refetch();  // Re-run fetcher
mutate(newData);  // Update without fetching
```

## Props Utilities

### splitProps - Safe "Destructuring"

```tsx
import { splitProps } from "solid-js";

function Button(props) {
  const [local, others] = splitProps(props, ["variant", "children"]);
  return (
    <button class={local.variant} {...others}>
      {local.children}
    </button>
  );
}
```

### mergeProps - Default Values

```tsx
import { mergeProps } from "solid-js";

function Button(props) {
  const merged = mergeProps({ type: "button", variant: "primary" }, props);
  return <button type={merged.type} class={merged.variant} />;
}
```

## Performance Patterns

### batch - Multiple Updates

```tsx
import { batch } from "solid-js";

// Single update cycle
batch(() => {
  setFirstName("Alice");
  setLastName("Doe");
  setAge(30);
});
```

### untrack - Prevent Tracking

```tsx
import { untrack } from "solid-js";

createEffect(() => {
  const tracked = count();  // Tracked
  const untracked = untrack(() => other());  // Not tracked
});
```

### on - Explicit Dependencies

```tsx
import { on } from "solid-js";

// Only run when count changes (name is untracked)
createEffect(on(count, (c) => {
  console.log("Count:", c, "Name:", name());
}));
```

## Lifecycle

```tsx
import { onMount, onCleanup } from "solid-js";

function Component() {
  // After mount (like useEffect with [])
  onMount(() => {
    console.log("Mounted");
    fetchInitialData();
  });

  // On unmount
  onCleanup(() => {
    console.log("Cleanup");
  });

  return <div>...</div>;
}
```

## Official Docs

- [SolidJS Docs](https://docs.solidjs.com/)
- [Reactivity Guide](https://docs.solidjs.com/concepts/intro-to-reactivity)
- [Stores](https://docs.solidjs.com/concepts/stores)
