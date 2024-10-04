'use strict';

const Homey = require('homey');
const flowActions = require('./lib/flows/actions');

class App extends Homey.App {
    log() {
        console.log.bind(this, '[log]').apply(this, arguments);
    }

    error() {
        console.error.bind(this, '[error]').apply(this, arguments);
    }

    // -------------------- INIT ----------------------

    async onInit() {
        this.log(`${this.homey.manifest.id} - ${this.homey.manifest.version} started...`);

        await flowActions.init(this.homey);

        this.sendNotifications();
    }

    async sendNotifications() {
        try {
            // const ntfy2023100401 = `[Whatsapp] (1/2) - Good news. This app version doesn't require the cloud server anymore`;
            // const ntfy2023100402 = `[Whatsapp] (2/2) - The complete connection is now running natevely on your Homey.`;

            // await this.homey.notifications.createNotification({
            //     excerpt: ntfy2023100402
            // });

            // await this.homey.notifications.createNotification({
            //     excerpt: ntfy2023100401
            // });
        } catch (error) {
            this.log('sendNotifications - error', console.error());
        }
    }

    async getWidgetChatInstance(widgetId) {
        const driver = this.homey.drivers.getDriver('Whatsapp');
        const devices = driver.getDevices();
        const device = devices.find(device => device.getStoreValue(`widget-instance-${widgetId}`));

        if(device) {
            const storeValue = device.getStoreValue(`widget-instance-${widgetId}`);
            device.cleanupWidgetInstanceDuplicates(`widget-instance-${widgetId}`, storeValue)

            return storeValue
        }

        return null;
    }

    async setWidgetChatInstance(widgetId, jid) {
        const driver = this.homey.drivers.getDriver('Whatsapp');
        const devices = driver.getDevices();
        
        devices.forEach(device => {
            device.setStoreValue(`widget-instance-${widgetId}`, jid);
        });
    }

    async getWidgetChats(jid) {
        const driver = this.homey.drivers.getDriver('Whatsapp');
        const devices = driver.getDevices();
        const device = devices.find(device => device.getStoreValue(`widget-chat-${jid}`));

        return device ? device.getStoreValue(`widget-chat-${jid}`) : null;
    }

    // async cleanupWidgetInstances() {
    //     const widget = await this.homey.dashboards.getWidget('chat');
    //     const instances = widget.getInstances();

    //   console.log(instances);
    // }
}

module.exports = App;
