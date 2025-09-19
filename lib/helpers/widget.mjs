export const checkWidgets = (widgetHeartbeats) => {
    const now = Date.now();
    const timeout = 2 * 60 * 1000; // 2 minutes without heartbeat = removed/closed

    for (const [widgetId, lastSeen] of Object.entries(widgetHeartbeats)) {
      if (now - lastSeen > timeout) {
        console.log(`Widget ${widgetId} is gone (last seen ${new Date(lastSeen)})`);
        delete widgetHeartbeats[widgetId];
        // You could emit an event or store this in persistent storage here
      }
    }

    return widgetHeartbeats;
  }