const Homey = require('homey');
const { BaileysClass } = require('@bot-wa/bot-wa-baileys');
const path = require('path');

const { sleep, validateUrl } = require('../../lib/helpers');

module.exports = class mainDevice extends Homey.Device {
    async onInit() {
        try {
            this.homey.app.log('[Device] - init =>', this.getName());
            this.setUnavailable(`Connecting to ${this.getName()}`);

            await this.synchronousStart();

            await this.checkCapabilities();
            await this.setWhatsappClient();
        } catch (error) {
            this.homey.app.log(`[Device] ${this.getName()} - OnInit Error`, error);
        }
    }

    async onDeleted() {
        await this.removeWhatsappClient();
    }

    async synchronousStart() {
        const driverData = this.driver;
        const driverDevices = driverData.getDevices();
        const deviceObject = this.getData();

        const sleepIndex = driverDevices.findIndex((device) => {
            const driverDeviceObject = device.getData();
            return deviceObject.id === driverDeviceObject.id;
        });

        await sleep(sleepIndex * 7500);

        this.homey.app.log('[Device] - init - after sleep =>', sleepIndex, this.getName());
    }

    // ------------- API -------------
    async setWhatsappClient() {
        try {
            const deviceObject = this.getData();
            this.homey.app.log(`[Device] - ${this.getName()} => setWhatsappClient`);

            this.WhatsappClient = this.driver.WhatsappClients[deviceObject.id]

            this.listenToWhatsappEvents();
        } catch (error) {
            this.homey.app.log(`[Device] ${this.getName()} - setWhatsappClient - error =>`, error);
        }
    }

    async removeWhatsappClient() {
        if (this.WhatsappClient) {
            this.WhatsappClient.removeAllListeners();
            this.WhatsappClient = null;
        }
    }

    listenToWhatsappEvents() {
        this.WhatsappClient.once('qr', (qr) => {
            this.homey.app.log(`[Device] ${this.getName()} - listenToWhatsappEvents - QR`);

            this.setUnavailable(`Repair device and Scan QR code to connect`);

            this.removeWhatsappClient();
        });

        this.WhatsappClient.once('ready', () => {
            this.homey.app.log(`[Device] ${this.getName()} - listenToWhatsappEvents - Ready`);

            this.setAvailable();
        });

        this.WhatsappClient.once('auth_failure', (error) => {
            this.homey.app.log(`[Device] ${this.getName()} - listenToWhatsappEvents - auth_failure`);

            this.setUnavailable(error);
        });
    }

    async onCapability_SendMessage(params, type) {
        this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage`, { ...params, device: 'LOG' });

        let fileUrl = params.droptoken || params.file || null;
        const fileType = type;
        const message = params.message.length ? params.message : '‎';
        const isGroup = validateUrl(params.recipient);
        const recipient = await this.getRecipient(params.recipient, isGroup);

        if(recipient) {
            await this.isTyping(recipient);
            const data = await this.sendMessage(recipient, message, fileUrl, fileType);

            this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage data`, Object.keys(data).length);

            await this.coolDown();
            return Object.keys(data).length;
        }

        return false;
    }

    async getRecipient(recipient, isGroup) {
        if (!validateMobile(recipient) && !validateUrl(recipient)) {
            throw new Error('Invalid mobile number OR Invalid group invite link');
        } else if (recipient && validateMobile(recipient)) {
            recipient = recipient.replace('+', '');
            recipient = `${recipient}@s.whatsapp.net`;
        } else if (isGroup) {
            const groupJid = recipient.replace(' ', '').split('/').pop();
            this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage - fetching group JID`, groupJid);

            recipient = await this.getStoreValue(groupJid) || null;
            this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage - fetching group JID from store: `, recipient);

            if (!recipient) {
                recipient = await this.WhatsappClient.getGroupWithInvite(groupJid) || null;
                this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage - fetching group JID from WhatsappClient`, recipient);

                if (recipient) {
                    recipient = recipient.id;

                    await this.setStoreValue(groupJid, recipient);
                    this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage - saved group JID to Store`, recipient);
                } else {
                    throw new Error('Could not get group ID. Is the group link correct?');
                }
            }
        }

        return recipient;
    }

    async isTyping(recipient) {
        this.homey.app.log(`[Device] ${this.getName()} - isTyping`, recipient);
        await this.WhatsappClient.sendPresenceUpdate(recipient, 'composing');
        await sleep(2000);
        await this.WhatsappClient.sendPresenceUpdate(recipient, 'paused');
    }

    async sendMessage(recipient, message, fileUrl, fileType) {
        let data = null;

        if (recipient && message && !fileType) {
            this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage sendText`, { recipient, message, fileUrl, fileType });

            data = await this.WhatsappClient.sendText(recipient, message);
        } else if (recipient && fileType) {
            if (!!fileUrl && !!fileUrl.cloudUrl) {
                fileUrl = fileUrl.cloudUrl;
            }

            this.homey.app.log(`[Device] ${this.getName()} - onCapability_SendMessage send${fileType}`, { recipient, message, fileUrl, fileType });

            if (fileType === 'video' || fileType === 'image') {
                data = await this.WhatsappClient.sendMedia(recipient, fileUrl, message);
            } else if (fileType === 'audio') {
                throw new Error('Audio is not supported yet');
            } else if (fileType === 'document') {
                data = await this.WhatsappClient.sendFile(recipient, fileUrl);
            }
        }

        return data;
    }

    async coolDown() {
        return await sleep(1000);
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

            if (oldC.length) {
                this.homey.app.log(`[Device] ${this.getName()} - Got old capabilities =>`, oldC);

                oldC.forEach((c) => {
                    this.homey.app.log(`[Device] ${this.getName()} - updateCapabilities => Remove `, c);
                    this.removeCapability(c);
                });

                await sleep(2000);
            }

            if (newC.length) {
                this.homey.app.log(`[Device] ${this.getName()} - Got new capabilities =>`, newC);

                newC.forEach((c) => {
                    this.homey.app.log(`[Device] ${this.getName()} - updateCapabilities => Add `, c);
                    this.addCapability(c);
                });
                await sleep(2000);
            }
        } catch (error) {
            this.homey.app.log(error);
        }
    }
};
