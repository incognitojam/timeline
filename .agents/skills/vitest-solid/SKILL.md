---
name: vitest-solid
description: "Tests SolidJS components with Vitest and @solidjs/testing-library. Use when adding or fixing frontend tests for SolidJS components, signals, or async UI behavior."
---

# Testing SolidJS with Vitest

## Quick Reference

| React Testing Library | SolidJS Testing Library |
|-----------------------|------------------------|
| `render(<Component />)` | `render(() => <Component />)` |
| `rerender(<Component newProp />)` | Use signals to update props |
| `result.current.count` | `result.count()` (call signal) |
| Often need `waitFor` | Usually synchronous |
| `QueryErrorResetBoundary` | Native `<ErrorBoundary>` |

## Setup

### Install Dependencies

```bash
npm i -D vitest jsdom @solidjs/testing-library @testing-library/user-event @testing-library/jest-dom
```

### Vitest Config

```typescript
// vitest.config.ts
import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  resolve: {
    // Critical for avoiding "multiple Solid instances" errors
    conditions: ["development", "browser"],
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./test/setup.ts"],
  },
});
```

### Setup File

```typescript
// test/setup.ts
import "@testing-library/jest-dom/vitest";
```

## Critical: Render Takes a Function

```tsx
// WRONG - React style
render(<MyComponent prop="value" />);

// CORRECT - SolidJS style
render(() => <MyComponent prop="value" />);
```

## Testing Reactive Updates

**There is no `rerender()` in Solid.** Use signals to update props:

```tsx
import { createSignal } from "solid-js";
import { render } from "@solidjs/testing-library";

test("updates when signal changes", () => {
  const [count, setCount] = createSignal(0);

  const { getByText } = render(() => <Counter count={count()} />);

  expect(getByText("Count: 0")).toBeInTheDocument();

  setCount(5);  // Component updates automatically

  expect(getByText("Count: 5")).toBeInTheDocument();
});
```

## Reactive Changes Are Synchronous

Unlike React, you rarely need `waitFor` or `findBy` for reactive updates:

```tsx
test("synchronous updates", () => {
  const [value, setValue] = createSignal("initial");
  const { getByText } = render(() => <Display value={value()} />);

  expect(getByText("initial")).toBeInTheDocument();

  setValue("updated");

  // No waitFor needed - update is synchronous
  expect(getByText("updated")).toBeInTheDocument();
});
```

### When You DO Need Async

- Router navigation (lazy-loaded routes)
- `createResource` / Suspense
- Transitions
- setTimeout/setInterval effects

```tsx
test("async resource", async () => {
  const { findByText } = render(() => <UserProfile />);

  // findBy for async content
  expect(await findByText("User Name")).toBeInTheDocument();
});
```

## Testing Effects with testEffect

For testing `createEffect`, use `testEffect` instead of polling with `waitFor`:

```tsx
import { testEffect } from "@solidjs/testing-library";
import { createSignal, createEffect } from "solid-js";

test("effect runs on signal change", () => {
  const [value, setValue] = createSignal(0);

  return testEffect((done) => {
    createEffect((run: number = 0) => {
      if (run === 0) {
        expect(value()).toBe(0);
        setValue(1);
      } else if (run === 1) {
        expect(value()).toBe(1);
        done();  // Signal completion
      }
      return run + 1;
    });
  });
});
```

## Testing Hooks with renderHook

```tsx
import { renderHook } from "@solidjs/testing-library";

function useCounter(initial = 0) {
  const [count, setCount] = createSignal(initial);
  const increment = () => setCount(c => c + 1);
  return { count, increment };
}

test("useCounter hook", () => {
  const { result } = renderHook(() => useCounter(5));

  // Note: signals must be called
  expect(result.count()).toBe(5);

  result.increment();

  expect(result.count()).toBe(6);
});
```

## User Interactions

```tsx
import { render, screen } from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";

test("form submission", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn();

  render(() => <LoginForm onSubmit={onSubmit} />);

  await user.type(screen.getByLabelText("Email"), "test@example.com");
  await user.type(screen.getByLabelText("Password"), "password123");
  await user.click(screen.getByRole("button", { name: /submit/i }));

  expect(onSubmit).toHaveBeenCalledWith({
    email: "test@example.com",
    password: "password123",
  });
});
```

## Mocking

### Mocking Stores

```tsx
let mockValue = 0;

vi.mock("../../stores/app-store", () => ({
  appState: {
    get counter() { return mockValue; },
  },
}));

beforeEach(() => {
  mockValue = 0;  // Reset between tests
});

test("reads from store", () => {
  mockValue = 42;
  const { getByText } = render(() => <StoreConsumer />);
  expect(getByText("42")).toBeInTheDocument();
});
```

### Context Wrapper

```tsx
test("with context", () => {
  const wrapper = (props) => (
    <ThemeContext.Provider value="dark">
      {props.children}
    </ThemeContext.Provider>
  );

  render(() => <ThemedComponent />, { wrapper });
});
```

### Mocking Modules

```tsx
vi.mock("../../lib/api", () => ({
  fetchUser: vi.fn().mockResolvedValue({ name: "Test User" }),
}));
```

## Router Testing

Router tests always need async first query:

```tsx
import { render } from "@solidjs/testing-library";
import { Route } from "@solidjs/router";

test("route renders", async () => {
  const { findByText } = render(
    () => <Route path="/user/:id" component={UserPage} />,
    { location: "/user/123" }
  );

  // Always use findBy for initial router render
  expect(await findByText("User 123")).toBeInTheDocument();
});
```

## Common Patterns

### Testing Show/When

```tsx
test("conditional rendering", () => {
  const [show, setShow] = createSignal(false);

  const { queryByText, getByText } = render(() => (
    <Show when={show()} fallback={<span>Hidden</span>}>
      <span>Visible</span>
    </Show>
  ));

  expect(getByText("Hidden")).toBeInTheDocument();
  expect(queryByText("Visible")).not.toBeInTheDocument();

  setShow(true);

  expect(queryByText("Hidden")).not.toBeInTheDocument();
  expect(getByText("Visible")).toBeInTheDocument();
});
```

### Testing For Lists

```tsx
test("list rendering", () => {
  const [items, setItems] = createSignal(["a", "b"]);

  const { getAllByRole } = render(() => (
    <ul>
      <For each={items()}>{item => <li>{item}</li>}</For>
    </ul>
  ));

  expect(getAllByRole("listitem")).toHaveLength(2);

  setItems(["a", "b", "c"]);

  expect(getAllByRole("listitem")).toHaveLength(3);
});
```

## Troubleshooting

### "Multiple instances of Solid" Error

Ensure your vitest config has:

```typescript
resolve: {
  conditions: ["development", "browser"],
}
```

### Tests Hang or Timeout

- Check for unresolved promises in effects
- Use `testEffect` with `done()` for effect testing
- Avoid `waitFor` for synchronous reactive updates

### Component Not Updating

- Ensure you're using signals, not static values
- Remember: no `rerender()` - use signals to drive updates

## Official Docs

- [Solid Docs - Testing](https://docs.solidjs.com/guides/testing)
- [GitHub - solidjs/solid-testing-library](https://github.com/solidjs/solid-testing-library)
- [Testing Library - Solid API](https://testing-library.com/docs/solid-testing-library/api/)
