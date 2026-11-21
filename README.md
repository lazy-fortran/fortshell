# FortShell

A browser ink notebook with a Fortran document model and
[FortUI](https://github.com/lazy-fortran/fortui) controls.
[Source](https://code.tugraz.at/yard/fortshell).
[Open the notebook](https://ink.sloppy.at/).

Several documents stay open at once, for example a deck and a whiteboard per
course. **Doc <** and **Doc >** or Shift+Left and Shift+Right switch between
them without loading, and **New doc** starts another. Opening a file starts a
new document unless the shown one is empty.
Write on an A4 landscape page, advance past the final page to create another,
insert a blank page after the shown one, for example between slides of a deck,
annotate a PDF, or export a vector PDF and an editable `.fortshell` notebook.
Undo, redo, stroke erasing, a lasso that selects strokes to move or delete,
pressure, zoom, and immediate keyboard command entry are available. Pens and
mice write. Fingers never write: one finger scrolls and two pinch to zoom.
Clearing a page, moving and deleting a selection each undo in one step. Pen,
colour and width are kept with the notebook.
The default black pen is 1.5 mm. Six pen colours are available, and ink that
leaves the page is clipped at its edge. Before tapering, pressure sets the width
between 18 and 100 percent of the selected size. An isolated tap has a
minimum raster radius of one display pixel. The notebook retains raw pressure.

The longer-term application is a unified AI-native shell for terminals,
browsers, tablets, desktops, and phones. This first slice has no AI service or
terminal notebook interface. Slideshow integration follows the ink notebook.

## Build

Native tests need a Fortran compiler and fpm or fo. Browser builds also need
Node.js, LFortran with its Emscripten runtime, and the Emscripten SDK.

```sh
fo test
npm ci
export FORTUI_PATH=/path/to/fortui
export FORTINK_PATH=/path/to/fortink
export EMSDK_PATH=/path/to/emsdk
tools/build-wasm.sh
npm run build:web
npm run serve
```

Check out FortUI and FortInk at the revisions recorded in `web/fortui.rev` and
`web/fortink.rev` before building. The LFortran runtime must be at
`../lib/lfortran_runtime_wasm_emcc.o` relative to the directory containing the
LFortran executable. Open `http://127.0.0.1:4178`. Serve `build/web` over HTTPS
for use on another device.
The default LFortran profile is `--fast --no-fast-math`. Set
`FORTUI_WEB_FFLAGS=''` for the standard compiler profile when comparing builds.

```sh
npm test
npx playwright install chromium webkit
npm run test:browser
npm run benchmark
npm run benchmark:latency
```

The browser suite exercises Chromium, WebKit, and an iPad viewport. Viewport
emulation does not verify an actual iPad, Apple Pencil, palm rejection by its
digitizer, or display latency. WebGPU tests require a real adapter and report
an explicit skip when none is available.

## Ink and comparisons

[FortInk](https://code.tugraz.at/yard/fortink) owns the pressure and position
model. FortSym and FortGen generate its numerical leaf. Fortran owns strokes,
pages, dimensions, and undo history. FortUI composes controls. Its direct
pointer surface delivers coalesced samples without recomposing controls for
each pen point. Browser predictions extend the same temporary outline and are never saved.
They are replaced by measured samples and expire after 16 ms without new input.
Clear page removes the current page's ink. Update app saves pending ink and
loads an available application update without closing the notebook.

JavaScript handles browser events, graphics APIs, storage, and the PDF
libraries. PDF.js renders imported pages. pdf-lib preserves original PDF page
content and adds vector ink.

**Ink comparison**, in the overflow menu with Clear page, offers the same model in JavaScript and Fortran WebAssembly,
raw input, and the independent perfect-freehand outline as a Canvas 2D
reference. Canvas 2D, WebGL2, and WebGPU share cubic stroke outlines with
tapered round caps and round joins at sharp turns. A local curve fit reduces
transverse jitter in the centreline while preserving deliberate corners.
An unsupported explicitly selected renderer reports an error. Device loss
reports a switch to Canvas 2D with retained document data.

**Run comparison** measures processing with boundary copies, numerical parity,
paired timing intervals, renderer submission, and the next animation frame.
The downloadable JSON records browser details and unsupported backends.
These measurements do not measure Pencil-to-display latency. Renderer timings
separate a full 1200-sample redraw from four-sample incremental frames.
Interactive drawing caches outline chunks and replaces only the affected region,
so stationary samples cannot darken antialiased edges. Results include the observed
browser timer resolution. A zero duration can mean below that resolution.

**Record drawing latency** measures the live pointer, document and rendering
path while drawing. **Drawing timings** downloads median, 95th percentile,
99th percentile and maximum times for input processing, waiting to draw, and
drawing submission. Recording is optional and bounded in memory. Its overhead
is included. The report excludes GPU completion and display scanout. The
drawing selector compares default immediate submission with animation-frame batching.
The latency benchmark drives this path with automated mouse input in paired,
reversed orders for both languages and all renderers. It never opens the
user's working notebook.

## Latency contract

Application authors use Fortran. Platform adapters may use C or JavaScript
behind that interface when measurements justify it, with no additional
third-party runtime or framework dependencies for latency work. Keep pointer
input independent of semantic control composition, disk writes and exports.

Optimize the largest measured contributor first. Assess overhead against
complete interaction latency on the target platform, including occasional
stalls. About 1 percent is acceptable. A 10 percent regression requires a fix.
An isolated filter timing cannot establish either threshold. Physical
pen-to-display measurements on the target device are needed before claiming
parity with a native notebook application.

## Hosting

`tools/build-server.sh` builds the server for the Debian host in a Debian 13
container, with the Fortran runtime linked statically. `sh tools/deploy.sh`
then installs it with the built `build/web` directory, runs it as the
`fortshell` user under systemd, validates nginx, and provisions HTTPS with the
existing Certbot. `FORTSHELL_SSH_TARGET` selects the SSH destination. DNS for
`ink.sloppy.at` must already point to that host. Deployment retains the
previous release of the application and of the server.

`fortshell serve`, built on [fortweb](https://code.tugraz.at/yard/fortweb),
answers every request behind nginx: the application files and the document
API below `/api`. Documents live in `/srv/fortshell/data`. The first
deployment writes the login token to `/root/fortshell-login-token`. Opening
`https://ink.sloppy.at/#login=TOKEN` once signs a browser in for a year.

```sh
fortshell init --data DIR        # prints a new login token
fortshell serve --data DIR --web build/web --listen 127.0.0.1:4180
```

## Saving

The browser keeps the current notebook in IndexedDB through a dedicated worker.
Database operations run outside the drawing thread. Pending changes coalesce
for 750 ms. Stroke checkpoints write only new sample tails. Idle tabs perform
no periodic writes. Long strokes checkpoint during input. Save failures retain
pending data and show a retry message. Original PDF bytes are stored once.
An exclusive browser lock prevents another tab from overwriting the same
working notebook. A second tab opens after the first closes and it is reloaded.

Every local write also enters an outbox in the same database transaction.
Outbox batches go to the server in order and leave the outbox only after the
server has written them to disk, so offline ink goes up once the network
returns. The server keeps an append-only log per notebook and ignores a
repeated batch. A signed-in browser on another device loads the notebook from
the server and follows its changes. Writes to the same item resolve in favour
of the later write.

The status indicator shows **Saved** once the server holds everything,
**Saved locally** with the number of batches waiting for the server otherwise,
and a sign-in note for a browser without a session. Browser storage alone
remains subject to platform eviction. Download **Notebook**
for a portable editable copy. Each document has its own browser database and
its own server log.

The `.fortshell` format is versioned JSON containing page dimensions in
millimetres, stroke metadata, raw samples `[x, y, seconds, pressure]`, and an
optional base64 PDF. The engine and geometry revision identify each stroke's
pipeline. Strokes saved before geometry revisions use the original fit.
Keep existing revisions reproducible when changing the model or geometry.
Erasing and vector PDF export use the fitted outline shown in the notebook.
PDF export preserves the content of imported pages as vectors where possible.
