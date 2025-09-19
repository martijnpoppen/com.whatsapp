'use strict';

module.exports = {
    setWidgetInstance: async function ({ homey, body }) {
        try {
            const { widgetId, deviceId, dataId } = body;
            const device = await homey.app.getDeviceById(deviceId);

            if (device) {
                return device.setWidgetInstance(widgetId, dataId);
            }

            return false;
        } catch (error) {
            console.error(`setWidgetInstance - Error: ${error.message}`);
            throw new Error('Failed to set widget instance');
        }
    },
    getWidgetInstance: async function ({ homey, body }) {
        try {
            const { widgetId, deviceId, dataId } = body;
            const device = await homey.app.getDeviceById(deviceId);

            if (device) {
                return device.getWidgetInstance(dataId);
            }

            return false;
        } catch (error) {
            console.error(`getWidgetInstance - Error: ${error.message}`);
            throw new Error('Failed to set widget instance');
        }
    }
};
