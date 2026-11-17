#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
ink=${FORTINK_PATH:-$root/../fortink}
ui=${FORTUI_PATH:?set FORTUI_PATH to the pinned FortUI checkout}
out=${1:-$root/build/web}
mkdir -p "$out"
export FORTUI_WEB_SOURCES="$ink/src/generated/ink_filter_leaf.f90 $ink/src/fortink.f90 $ink/web/abi.f90 $root/src/fortshell_document.f90 $root/web/fortshell_app.f90"
export FORTUI_WEB_JS="$root/web/host.js"
export FORTUI_WEB_FFLAGS="${FORTUI_WEB_FFLAGS---fast --no-fast-math}"
exports='_fs_reset,_fs_begin,_fs_append,_fs_finish,_fs_count,_fs_current,_fs_pages,_fs_page,_fs_next,_fs_previous,_fs_visible,_fs_toggle,_fs_undo,_fs_redo,_fs_size,_fs_data,_fs_meta,_fs_input,_fs_output,_fs_width,_fs_tool,_fs_dimensions,_fs_set_dimensions,_fs_stroke_page,_fs_can_undo,_fs_can_redo,_fi_input,_fi_output,_fi_reset,_fi_process'
export FORTUI_WEB_LDFLAGS="-O3 -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32 -sEXPORTED_FUNCTIONS=_main,_fortui_web_step,_fortui_web_key,$exports"
"$ui/web/build.sh" "$root/web/main.f90" "$out"
printf '%s\n' "FortUI $(git -C "$ui" rev-parse HEAD 2>/dev/null || printf source)" > "$out/toolchain.txt"
printf '%s\n' "FortUI requested: $(cat "$root/web/fortui.rev")" "FortInk requested: $(cat "$root/web/fortink.rev")" >> "$out/toolchain.txt"
printf '%s\n' "LFortran flags: ${FORTUI_WEB_FFLAGS:-default}" >> "$out/toolchain.txt"
"${LFORTRAN:-lfortran}" --version >> "$out/toolchain.txt"
"${EMCC:-${EMSDK_PATH}/upstream/emscripten/emcc}" --version >> "$out/toolchain.txt"
