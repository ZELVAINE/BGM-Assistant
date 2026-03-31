browser.browserAction.onClicked.addListener(async (tab) => {
  if (!tab.url || !tab.url.includes('play.basketball-gm.com/l/')) return;
  browser.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
});
