# Error vs throw in JavaScript — recap

## The key insight

`Error` (the class) and `throw` (the statement) are **two completely independent things** that are usually used together by convention.

- **`Error`** is just a regular JavaScript object. `new Error("x")` builds an object with `.message`, `.name`, and `.stack`. Nothing magic happens at construction.
- **`throw`** is a control-flow statement that unwinds the call stack until some `catch` (or promise rejection handler) grabs the thrown value.

You can use either one without the other.

## Returning an Error is not throwing

```js
function foo() {
  return new Error("foo");   // returns an Error object as a value
}

try {
  const res = foo();
  if (res instanceof Error) {
    console.log("Error returned");   // ← this runs
  }
} catch (err) {
  console.log("Error thrown");        // ← this does NOT run
}
// Output: "Error returned"
```

Same applies to async:

```js
async function foo() { return new Error("foo"); }  // resolves WITH an Error
async function bar() { throw new Error("bar");  }  // REJECTS with an Error

await foo();   // → Error object, no rejection
await bar();   // → throws, must be caught
```

## `throw` works with any value

The throw statement doesn't care whether the value is an Error:

```js
throw "boom";              // throw a string
throw 42;                  // throw a number
throw { code: 500 };       // throw a plain object
throw new Error("boom");   // throw an Error (idiomatic)
```

In every case, `catch(e)` receives whatever you threw. The reason we conventionally throw `Error` instances is purely practical:

1. `.message` and `.stack` make debugging tractable.
2. `instanceof Error` lets callers narrow what they caught.
3. Stack traces are captured at construction time (helpful even before you throw).

## Why this matters: errors as values

Because `Error` is just data, you can pass it around without unwinding the stack. Several patterns rely on this:

### DataLoader / micro-batching contract

```ts
type BatchFn<T, R> = (items: T[]) => Promise<(R | Error)[]>;

// example
const batchFn = async (ids: string[]) =>
  ids.map((id) => users[id] ?? new Error(`user ${id} not found`));
```

The batch function returns one result *per* item. Per-item failures are inline as `Error` values, not thrown — so a single missing user doesn't blow up the whole batch. The batcher inspects each slot:

```ts
if (result instanceof Error) entry.reject(result);
else                          entry.resolve(result);
```

If JavaScript auto-threw on returned Errors, this pattern wouldn't exist.

### GraphQL execution

`graphql-js` and Apollo's server runtime have a special convention: if a resolver *returns* an `Error` instance, the engine treats it as a field error in the response — equivalent to throwing. This is a library convention, not language behavior, and it's where DataLoader's inline-Error idea came from.

### Result-type / Rust-style error handling

```ts
type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

function parseConfig(input: string): Result<Config> {
  try {
    return { ok: true, value: JSON.parse(input) };
  } catch (e) {
    return { ok: false, error: e as Error };
  }
}
```

Caller handles the error as a normal branch — no `try/catch` needed at every level.

## When to throw vs. when to return

| Situation | Prefer |
|---|---|
| Programmer error / contract violation (impossible to recover) | `throw` |
| Expected failure that callers will likely handle (parse error, not-found, validation) | return as value |
| API boundary where callers expect synchronous control flow | `throw` (idiomatic JS) |
| Batch / list processing where individual failures must not abort siblings | return per-item Error |
| Crossing a network / serialization boundary | return — throwables don't serialize well |

A useful rule of thumb: **`throw` is for control flow; returning an Error is for data.** If the caller *always* needs to handle this case, making it a return value makes it impossible to forget. If only some callers need to handle it, throwing lets the rest bubble up.

## Quick reference

```js
// ── Throwing ──
throw new Error("x");                           // sync — caught by try/catch
async function f() { throw new Error("x"); }    // async — promise REJECTS
return Promise.reject(new Error("x"));          // explicit rejection (same effect)

// ── Returning ──
return new Error("x");                          // sync — caller gets value
async function f() { return new Error("x"); }   // async — promise RESOLVES with Error
Promise.resolve(new Error("x"));                // resolves with Error value

// ── Detecting ──
result instanceof Error                          // true for Error and subclasses
error?.message                                   // the human string
error?.stack                                     // captured at construction
```

## Common gotchas

- `Promise.resolve(new Error("x"))` is **not** a rejection. The promise resolves with an Error object as its value.
- `catch(e)` does not require `e` to be an Error — it can be anything that was thrown. Always narrow with `instanceof Error` before reaching into `.message`.
- Errors caught across `await` lose nothing — stack traces survive because V8 captures the trace at construction, not at throw time.
- Returning `Promise.reject(...)` from an async function still rejects the surrounding promise, even though you used `return`. The async wrapper unwraps rejected promises and re-rejects.
