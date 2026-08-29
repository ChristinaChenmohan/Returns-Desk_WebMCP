# WebMCP throwaway probe

This directory is a disposable technical-spike harness. It is not production code and must not be imported by the application.

The probe checks the native browser surface on a real localhost origin:

- six static tool registrations;
- discovery of `readOnlyHint` and `untrustedContentHint`;
- registration cleanup through `AbortController`;
- execution cancellation propagation through `AbortSignal`;
- mutation result followed by version-aware Case re-fetch and UI rendering.

Run `node serve.mjs`, then launch Chrome with WebMCP testing features and open `http://127.0.0.1:8123/probe.html`.

