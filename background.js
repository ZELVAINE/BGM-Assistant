browser.browserAction.onClicked.addListener(tab => {
  if (tab.url && tab.url.includes('play.basketball-gm.com/l/')) {
    browser.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
  }
});
