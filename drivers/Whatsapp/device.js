const Homey = require('homey');
const WhatsappClient = require('../../lib/textmebot/whatsapp');
const { sleep, validateMobile, validateUrl } = require('../../lib/helpers');

module.exports = class mainDevice extends Homey.Device {
    async onInit() {
        try {
            this.homey.app.log('[Device] - init =>', this.getName());
            this.setUnavailable(`Connecting to ${this.getName()}`);

            await this.checkCapabilities();
            await this.setWhatsappClient();

            await this.setAvailable();
        } catch (error) {
            this.homey.app.log(`[Device] ${this.getName()} - OnInit Error`, error);
        }
    }

    async onAdded() {
        this.homey.app.setDevice(this);
    }

    onDeleted() {
        const deviceObject = this.getData();
        this.homey.app.removeDevice(deviceObject.id);
    }

    async onSettings({ oldSettings, newSettings, changedKeys }) {
        this.homey.app.log(`[Device] ${this.getName()} - oldSettings`, oldSettings);
        this.homey.app.log(`[Device] ${this.getName()} - newSettings`, newSettings);

        this.checkCapabilities(newSettings);
        this.setWhatsappWebhook(newSettings.enable_receive_message, newSettings.phone, newSettings.apiKey);
    }

    // ------------- API -------------
    async setWhatsappClient() {
        try {
            const settings = this.getSettings();
            this.homey.app.log(`[Device] - ${this.getName()} => setWhatsappClient`);

            this.WhatsappClient = new WhatsappClient({ apiKey: settings.apiKey });

            this.homey.app.log(`[Device] ${this.getName()} - setWhatsappClient Set webhook`);
            await this.setWhatsappWebhook(settings.enable_receive_message, settings.phone, settings.apiKey);

            await this.setAvailable();
        } catch (error) {
            this.homey.app.log(`[Device] ${this.getName()} - setWhatsappClient - error =>`, error);
        }
    }

    async setWhatsappWebhook(enabled = false, phone, apikey) {
        this.homey.app.log(`[Device] ${this.getName()} - setWhatsappWebhook`, enabled);

        let webhookUrl = null;
        if (enabled) {
            const homeyId = await this.homey.cloud.getHomeyId();
            webhookUrl = `https://webhooks.athom.com/webhook/${Homey.env.WEBHOOK_ID}?homey=${homeyId}&phone=${phone}`;

            this.homey.app.log(`[Device] ${this.getName()} - setWhatsappWebhook connectPhoneNumberToApiKey`);
            await this.WhatsappClient.connectPhoneNumberToApiKey(phone);
        } else {
            this.homey.app.log(`[Device] ${this.getName()} - setWhatsappWebhook disconnectPhoneNumberToApiKey`);
            await this.WhatsappClient.disconnectPhoneNumberToApiKey();
        }

        await this.WhatsappClient.createWebhook(webhookUrl);
    }

    async onCapability_SendMessage(params, type, isGroup = false) {
        try {
            this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage`, { ...params, device: 'LOG' });

            const settings = this.getSettings();
            const message = params.message || ' ';
            let recipient = params.recipient;
            let fileUrl = params.droptoken || params.file || null;
            const fileType = type;
            const isGroup = validateUrl(recipient);

            this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage - isGroup and ValidateMobile`, isGroup, validateMobile(recipient));

            if (!validateMobile(recipient) && !validateUrl(recipient)) {
                throw new Error('Invalid mobile number OR Invalid group invite link');
            }

            if (!!fileUrl && !!fileUrl.cloudUrl) {
                fileUrl = fileUrl.cloudUrl;
            }

            if (recipient && (message || fileUrl)) {
                this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage connectPhoneNumberToApiKey`);

                await this.WhatsappClient.connectPhoneNumberToApiKey(settings.phone);

                if (isGroup) {
                    this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage - fetching group ID`, recipient);
                    const groupLink = recipient.split('/').pop();

                    recipient = await this.WhatsappClient.getGroupId(groupLink);

                    await sleep(7500)
                }

                this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage sendTextMessage`, { recipient, message, fileUrl, fileType });
                const data = await this.WhatsappClient.sendTextMessage(recipient, message, fileUrl, fileType);

                if (!settings.enable_receive_message) {
                    this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage disconnectPhoneNumberToApiKey`);
                    await this.WhatsappClient.disconnectPhoneNumberToApiKey();
                }

                if (data) {
                    // this.setCapabilityValue('measure_updated_at', getCurrentDatetime());
                    return true;
                }

                return true;
            }

            return false;
        } catch (error) {
            this.homey.app.log(error);

            return Promise.reject(error);
        }
    }

    async onCapability_setReceiveMessages(enabled) {
        await this.setSettings({ enable_receive_message: enabled });
        await this.checkCapabilities();
    }

    // ------------- Capabilities -------------
    async checkCapabilities(overrideSettings = null) {
        const settings = overrideSettings ? overrideSettings : this.getSettings();
        const driverManifest = this.driver.manifest;
        let driverCapabilities = driverManifest.capabilities;

        const deviceCapabilities = this.getCapabilities();

        if (!settings.enable_receive_message) {
            driverCapabilities = driverCapabilities.filter((d) => d !== 'receive_message');
        }

        this.homey.app.log(`[Device] ${this.getName()} - Found capabilities =>`, deviceCapabilities);
        this.homey.app.log(`[Device] ${this.getName()} - Driver capabilities =>`, driverCapabilities);

        await this.updateCapabilities(driverCapabilities, deviceCapabilities);

        return true;
    }

    async updateCapabilities(driverCapabilities, deviceCapabilities) {
        try {
            const newC = driverCapabilities.filter((d) => !deviceCapabilities.includes(d));
            const oldC = deviceCapabilities.filter((d) => !driverCapabilities.includes(d));

            this.homey.app.log(`[Device] ${this.getName()} - Got old capabilities =>`, oldC);
            this.homey.app.log(`[Device] ${this.getName()} - Got new capabilities =>`, newC);

            oldC.forEach((c) => {
                this.homey.app.log(`[Device] ${this.getName()} - updateCapabilities => Remove `, c);
                this.removeCapability(c);
            });
            await sleep(2000);
            newC.forEach((c) => {
                this.homey.app.log(`[Device] ${this.getName()} - updateCapabilities => Add `, c);
                this.addCapability(c);
            });
            await sleep(2000);
        } catch (error) {
            this.homey.app.log(error);
        }
    }
};
