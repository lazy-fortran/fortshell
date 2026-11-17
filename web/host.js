addToLibrary({
  fortshell_action: function(action, value) {
    globalThis.fortshellHost?.(action, value);
  },
});
