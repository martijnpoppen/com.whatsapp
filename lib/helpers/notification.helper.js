// ---------------------------------------INIT FUNCTION----------------------------------------------------------
module.exports = class notificationHelper {
    constructor(homey, webhook) {
        this.homey = homey;

        this.setDevices(this.homey.app.deviceList);
        this.init(webhook);
    }

    async setDevices(deviceList) {
        this.homey.app.log('[notificationHelper] - Settings new devices');
        this.deviceList = deviceList;
    }

    async init(webhook) {
        try {
            this.homey.app.log('[notificationHelper] - Init');

            webhook.on('message', (args) => {
                if(this.deviceList.length > 0) {
                    this.handleDeviceNotification(args);
                }
            });
        } catch (err) {
            this.homey.app.error(err);
        }
    }
    // ---------------------------------------NOTIFICATION HELPERS----------------------------------------------------------
    async handleDeviceNotification({ query, body }) {
        const pairedDevices = this.deviceList;

        this.homey.app.log(`[NTFY] - 1. handleDeviceNotification:`, query, body);

        const phone = query.phone;
        const from = body.from;
        const message = body.message;
        const isText = body.type === 'text';

        if (phone && isText) {
            const HomeyDevice = pairedDevices.find(async (HomeyDevice) => {
                const settings = HomeyDevice.getSettings();
                this.homey.app.log(`[NTFY] - 1. Matching phonenumber: ${settings.phone.replace('+', '')} - ${phone}`);

                if (settings.phone.replace('+', '') === phone) {
                    return true;
                }

                return false;
            });

            if(HomeyDevice && HomeyDevice.hasCapability('receive_message')) {
                this.homey.app.log(`[NTFY] - 2. Found Match - ${phone}`);
                this.triggerFlow(HomeyDevice, phone, from, message);
            } else {
                this.homey.app.log(`[NTFY] - 2. No Match - ${phone}`);
            }
        } else {
            this.homey.app.log(`[NTFY] - 2. No Match`);
        }
    }

    async triggerFlow(device, phone, from, message) {
        this.homey.app.log(`[NTFY] - 3. Trigger phone message to: ${phone}`, from, message);
        let tokens = { from: `+${from}`, message: message.toString() };

        const trigger_message_received = this.homey.flow.getDeviceTriggerCard(`trigger_message_received`);
        trigger_message_received
            .trigger(device, tokens)
            .catch(this.error)
            .then(this.homey.app.log(`[NTFY] - 4. ${device.getName()} - Triggered trigger_message_received - tokens: `, tokens));
    }
};
// ---------------------------------------END OF FILE----------------------------------------------------------
