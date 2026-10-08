const PAGE = browser.runtime.getURL("graph.html");

browser.browserAction.onClicked.addListener(async () => {
  const [existing] = await browser.tabs.query({ url: PAGE });
  if (existing) {
    await browser.tabs.update(existing.id, { active: true });
    await browser.windows.update(existing.windowId, { focused: true });
  } else {
    await browser.tabs.create({ url: PAGE });
  }
});
