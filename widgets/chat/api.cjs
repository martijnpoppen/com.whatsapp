'use strict';

module.exports = {
    getWidgetChatInstance: function ({ homey, query }) {
        return homey.app.getWidgetChatInstance(query.widgetId);
    },
    setWidgetChatInstance: function ({ homey, query }) {
        return homey.app.setWidgetChatInstance(query.widgetId, query.jid);
    },
    getWidgetChats: function ({ homey, query }) {
        return homey.app.getWidgetChats(query.jid);
    }
};
