console.log("WAMP Inspector: devtools page loaded");

chrome.devtools.panels.create(
  "WAMP Inspector",
  "icons/devtools-icon.svg",
  "src/devtools/panel.html",
  (panel) => {
    console.log("WAMP Inspector: panel created", panel);
  },
);
