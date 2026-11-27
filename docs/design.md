# FortShell design

FortShell replaces Slopshell with one native surface for everything. It is
rebuilt from a small core that is certain, and the first use it must carry is
teaching: presenting decks, writing on a whiteboard and on slides, and
exporting PDFs, without switching between Goodnotes and a browser and without
losing ink.

## Goals kept from Slopshell

Slopshell (Feb to Nov 2026, about 2400 commits, about 190 000 lines of Go and
36 000 of browser code) settled these goals through several pivots:

| Goal | Origin |
| --- | --- |
| Blank canvas when nothing is open, content fills the view, no visible chrome | v0.0.8 tabula rasa, after the v0.0.7 split view with a fixed chat column |
| The artifact, not the app, is the unit of work | design lineage (Star, Raskin, Emacs, Newton) |
| Every artifact is a real file in a real folder | v0.0.9 file-backed canvas |
| No gesture has two meanings in one visible state | gesture truth table |
| Typing always starts a prompt, tap starts voice | v0.1.4, Sep 2026 universal typing |
| AI output is a proposal with explicit control before it applies | object-scoped intent UI |
| Edits patch canonical source, rendered views are derived | live artifacts |
| Durable work runs as Jobs, separate from the conversation | v0.1.9 ontology |

These are kept as principles. The ontology (Chat, Item, Job, Attempt,
Terminal, Location, Artifact), the companion and meeting modes, Zulip, the
source fabric and the agent controller are not carried over. Each returns only
when a feature needs it.

## Problems FortShell removes

- One artifact on the canvas at a time, and opening another reloads it.
- A server round trip and a recompile for each edit.
- Ink works only in a separate annotation mode, and the pen does nothing on a
  blank canvas.
- Whiteboard PDFs from another app land loose and have to be identified.
- A large runtime that is slow to change and redeploy.

## Architecture

Dependencies point inwards only:

```text
domain (Fortran, pure)  <-  operations (Fortran)  <-  adapters (JS, server)
```

- **Domain.** Documents, pages, strokes, page references and the operation
  log. No I/O, no clock, no browser. Tested natively with `fo test`.
- **Operations.** Apply an operation, undo it, derive a page, export a PDF.
  The same code runs natively, in wasm in the browser and on the server.
- **Adapters.** Pointer input, rendering backends, storage, network sync,
  PDF.js, later the Typst compiler and voice. Each adapter is replaceable and
  owns no content.

The core stays small: document store, operation log, page compositor, input
router and a registry of artifact kinds. Everything else registers with it as
a module (artifact kinds, exporters, input methods). Content lives in the
store, never inside a module, so a module can be rebuilt and reloaded while the
documents stay open.

## Data and saving

A document is an append-only log of operations plus snapshots:

```text
op = (document id, sequence number, client id, kind, payload)
```

1. Each stroke tail is written to IndexedDB in the browser (already the case)
   and sent to the server at once.
2. The server appends it to the document's log file and acknowledges the
   sequence number. Unacknowledged operations stay queued and are resent after
   a reconnect. The page shows an unsaved marker only while something is
   unacknowledged.
3. The server never overwrites a log. Snapshots and PDFs are derived files and
   can always be regenerated from the log.
4. Two devices editing the same document merge by operation, not by file.

The server writes each document into its folder, for example
`lv/plasma/2026/whiteboard/05-single-particle-motion.fortshell`, with the PDF
next to it. The file name comes from the document, so nothing is sorted by
hand.

## Pages and references

Everything shown is a sequence of pages. A page is either a page of its own
document (whiteboard, notebook) or a reference to a page of another artifact
(deck slide, PDF page) with an ink layer on top.

```text
page = own(page id) | ref(artifact id, page key)
```

The page key of a deck slide is its slide label and build step, so ink stays
on the right slide when the deck is rebuilt or reordered. Until the decks have
labels, the key is the slide title and step from the existing presenter
manifest. A blank page can be inserted between any two pages. Interleaving
deck slides and whiteboard pages therefore needs no extra container.

## First slice: classroom presentation

Built only from parts already in use:

- **Decks** are read from the presenter build that `scripts/build-present.py`
  already produces (`public/present/<stem>/manifest.json` with one SVG per
  page and kinds `static`, widget and animation). No Typst runs in FortShell
  yet.
- **Several artifacts stay open.** Every open deck and whiteboard keeps its
  rendered pages in memory, so switching is immediate.
- **Ink everywhere.** The pen always writes: on a blank canvas it starts a new
  whiteboard, on a slide it writes on that slide. Fingers scroll, swipe to the
  next page and pinch. There is no annotation mode.
- **Presenting.** Full-screen page view with step-by-step build-up from the
  per-step pages. A second window follows the presenter for the projector.
- **Export.** One click writes the annotated deck PDF and the whiteboard PDF
  to the course folder.
- **No loss.** Server-side saving as above. Checked by killing the browser and
  the network during writing in the browser tests.

## Later steps

1. Decks as live Typst artifacts, compiled in the browser, edited by source
   patches (text and math, move and resize, insert, delete and reorder slides,
   build steps, figure and widget swap).
2. Widgets and animations as live pages, with Fortran wasm kernels.
3. Voice: spoken requests write formulas onto the canvas, from prepared board
   notes first.
4. Self-editing: an agent changes FortShell's own source from inside, the
   module is rebuilt and reloaded into a staging channel, and accepting it
   promotes the release. The deployment already keeps timestamped releases,
   which makes rollback one link change. DeepSeek Harness (dsh) shows the
   module side: everything is a plugin composed from ordered layers, with hot
   reload of the composition. Its published documents describe neither agent
   self-editing nor rollback, so that part is ours to design.
5. Conversation, tracked items and background jobs, as far as they are still
   needed then.

## Decks and interactive content

Typst stays the deck source. It provides math typesetting, computed content
(loops, JSON data, derived numbers), the handout PDF and readable diffs, and
11 decks already use it. pptx or reveal.js lose either the math, the diffs or
the print output.

The typesetter is a replaceable adapter behind one interface: source in, pages
out, and for each page its objects with their source spans. Editing works
only through that interface.

- **Now:** the Typst compiler in wasm (typst.ts) in a worker, if it is fast
  enough on the iPad. This is measured first on the largest deck.
- **Target:** [tx](https://github.com/lazy-fortran/tx), our Fortran typesetter,
  whose content tree `doc_t` and Typst source writer fit this interface. tx
  does not yet run the decks: `theme.typ` uses Typst functions with named
  arguments, `state`, `context`, `place`, `json` and loops, which the tx
  reader does not evaluate. tx also has no wasm build yet, because its PDF
  path uses Cairo, FreeType and HarfBuzz. Its Fortran SVG backend is the
  starting point there.

Typst never carries interactivity. A deck declares a live region, FortShell
places the live module into the rectangle that Typst reports, and the PDF
keeps the poster:

```typst
#live("tokamak-exb", at: (1, 12), poster: "tokamak-exb.png")
```

- A live module receives its region, its parameters and the clock, and draws
  into the region. It owns no saved content.
- Existing self-contained HTML widgets run unchanged in a sandboxed frame.
  New modules are FortUI code in Fortran wasm, with the same kernels as the
  cluster codes (MILCA).
- Animations are live modules that step in time. MP4 export stays for video.
- Input follows the same rule as everywhere: the pen writes on top of the
  module, fingers operate it.

## Serving and sync

FortShell runs at ink.sloppy.at, presented from the iPad alone. One Fortran
binary, `fortshell serve`, serves everything. Its HTTP layer is the
library **fortweb**, which serves HTTP/1.1 and server-sent events (SSE) from
Fortran over POSIX sockets through `iso_c_binding` and runs crash-isolated
worker processes.

fortweb has no upstream dependencies: only the C library and the kernel,
reached through `iso_c_binding`. It contains:

- sockets, HTTP/1.1, SSE, static files with correct types and caching
- TLS 1.3 server, minimal modern profile: X25519, ECDSA P-256 certificate
  (Let's Encrypt), AES-128-GCM and ChaCha20-Poly1305, SHA-256 and HKDF
- sessions, scoped tokens stored as hashes, passkey (WebAuthn) verification,
  which uses the same P-256 and SHA-256 code as TLS

The TLS code is security-critical. It replaces nginx only after it passes the
RFC 8448 example handshakes, the Wycheproof test vectors and interoperability
tests with Safari, Chromium and curl. Until then nginx terminates TLS in front
of it, as it does today.

The server makes no outbound connections, so it needs no TLS client, no X.509
chain validation and no RSA.

- **Sign-in.** Passkeys with Face ID on the iPad, then a long-lived HttpOnly
  session cookie. Nothing depends on an external sign-in service during a
  lecture. One break-glass token, stored only as a hash.
- **Sync.** The client keeps working offline from IndexedDB. Operations go up
  in batches by POST, idempotent on (client id, sequence number). Changes from
  other devices come down over SSE. No WebSocket is needed.
- **Storage.** One data directory on the server: an append-only log per
  document and derived snapshots and PDFs. The index is rebuilt in memory
  from the logs at start, so no database is needed. It is backed up nightly.
- **Decks in.** The course repositories' `publish.sh` pushes each presenter
  build with a scoped upload token. FortShell keeps every version and
  references the one it shows.
- **PDFs out.** The workstation pulls new exports with a scoped token into
  the course folders in Nextcloud, under their fixed names, and so into the
  student share. The server itself never connects out.
- **Releases.** Timestamped release directories with an atomic switch, as
  today.

Slopshell stays unchanged. FortShell takes over once it covers the work.

## Changes by repository

| Repository | Change for the first slice |
| --- | --- |
| fortweb (new) | HTTP/1.1 parsing and responses and POSIX sockets, static files with path containment, types and validators; SSE; forked worker processes around a handler procedure; random session tokens from `getrandom`. Depends only on fx. |
| fortshell | `fortshell serve` on fortweb: static files, operation log upload, SSE, session sign-in. Client: several open documents, page references with ink, deck artifacts from presenter manifests, hidden toolbar, projector window, server sync. |
| fortui | Nothing yet. The hidden toolbar is composed by FortShell. Floating overlays are FortUI roadmap work and are taken up when FortShell needs more than one toolbar. |
| fortink | Nothing. |
| fx | Nothing. Its SHA-256 serves tokens and validators. |
| course repositories | Later: slide labels in the presenter manifest and pushing presenter builds to FortShell. |
| tx | Later, as described above. |

## Remaining upstream dependencies

| Dependency | Use | Way out |
| --- | --- | --- |
| Typst compiler (wasm) | rendering and editing decks | tx |
| pdf.js | showing imported PDFs | none planned for arbitrary PDFs |
| pdf-lib | PDF export | own PDF writer in Fortran |
| perfect-freehand | ink comparison renderer | remove with the comparison |

The core and the server have none. The remaining ones sit in replaceable
browser adapters.
