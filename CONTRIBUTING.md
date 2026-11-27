# Contributions

Open a pull request on GitHub. It lands through the merge queue as one squashed
commit once its tests pass. Keep domain state and commands in Fortran, reusable
modelling in FortInk, and reusable UI behaviour in FortUI. Browser adapters may
use JavaScript. Do not move pointer-rate input through semantic toolbar
composition.

Run native document tests, JavaScript model tests, and the affected browser
flows. Generate test PDFs rather than committing binary fixtures. Numerical
comparisons must use equivalent inputs and report timer resolution and
unsupported graphics APIs. Never infer physical Pencil latency from JavaScript
timers or an emulated tablet viewport.

Use a resident `fo gremlin` development session for Fortran changes. Keep
dependency revisions pinned and regenerated numerical expressions reproducible.
