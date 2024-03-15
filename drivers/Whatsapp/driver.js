const Homey = require('homey');
const { GetGUID, sleep } = require('../../lib/helpers');
const whatsappClient = require('../../lib/com.whatsapp.api');
const { parsePhoneNumber } = require('libphonenumber-js');

module.exports = class mainDriver extends Homey.Driver {
    async onInit() {
        this.homey.app.log('[Driver] - init', this.id);
        this.homey.app.log(`[Driver] - version`, Homey.manifest.version);
        this.WhatsappClients = [];
        this.homeyCloudId = await this.homey.cloud.getHomeyId();
        this.tempDB = {};

        const devices = this.getDevices();

        devices.forEach(async (device) => {
            const deviceObject = device.getData();
            await this.setWhatsappClient(deviceObject.id, device);
        });
    }

    async setWhatsappClient(deviceId, device = null) {
        this.WhatsappClients[deviceId] = new whatsappClient({
            deviceId,
            homeyData: {
                driver: this,
                device
            }
        });

        return this.WhatsappClients[deviceId];
    }

    async setCheckInterval(session, guid) {
        try {
            this.onReadyInterval = this.homey.setInterval(async () => {
                const data = await this.WhatsappClients[guid].getData();

                this.homey.app.log(`[Driver] ${this.id} - setCheckInterval - ${data.type}`);

                if (data.type === 'READY' && data.clientID === guid) {
                    if(session)  session.showView('loading2');
                }

                if (data.type === 'CODE' && data.clientID === guid) {
                    this.code = data.msg;
                    await session.emit('code', data.msg);
                }

                if (data.type === 'CLOSED' && data.clientID === guid) {
                    if(session) session.showView('done');
                }
            }, 4000);

            setTimeout(() => {
                this.homey.app.log(`[Driver] ${this.id} - Disabling interval`);
                this.homey.clearInterval(this.onReadyInterval);
            }, 120000);
        } catch (error) {
            this.homey.app.error(`[Driver] ${this.id} error`, error);
        }
    }

    async resetInterval() {
        this.homey.app.log(`[Driver] ${this.id} - ResetInterval - Disabling interval`);
        this.homey.clearInterval(this.onReadyInterval);
    }


    async onPair(session) {
        this.type = 'pair';
        this.device = null;
        this.tempDB = {};
        this.code = null;

        this.setPairingSession(session);
    }

    async onRepair(session, device) {
        this.type = 'repair';
        this.device = device;
        this.tempDB = {};
        this.code = null;

        await device.removeWhatsappClient();

        this.homey.app.log(`[Driver] ${this.id} - unsetting store for :`, device.getName());
        const storeData = device.getStore();
        Object.keys(storeData).forEach((storeKey) => {
            device.unsetStoreValue(storeKey);
        });

        this.setPairingSession(session);
    }

    async setPairingSession(session) {
        const deviceObject = this.device && this.device.getData();

        this.guid = this.device ? deviceObject.id : `${this.homeyCloudId}_${GetGUID()}`;

        session.setHandler('showView', async (view) => {
            this.homey.app.log(`[Driver] ${this.id} - currentView:`, { view, type: this.type });

            if (view === 'whatsapp_consent') {
                const devices = this.getDevices();
                if (devices.length >= 2 && this.type === 'pair') {
                    session.showView('whatsapp_max');

                    return false;
                }
            }

            if (view === 'whatsapp_pairing_code') {
                await session.emit('code', this.code);
            }

            if (view === 'loading') {
                if (this.type === 'repair') await this.setWhatsappClient(this.guid, this.device);
                if (this.type === 'pair') await this.setWhatsappClient(this.guid);
                await this.WhatsappClients[this.guid].addDevice(this.phonenumber);

                this.setCheckInterval(session, this.guid);

                await sleep(5000);
                if (this.code.length) {
                    session.showView('whatsapp_pairing_code');
                }

                await sleep(3000);
                session.showView('whatsapp_pairing_code');
            }

            if (view === 'loading2') {
                this.resetInterval();

                this.results = [
                    {
                        name: `Whatsapp`,
                        data: {
                            id: this.guid
                        },
                        settings: {
                            phonenumber: this.phonenumber
                        }
                    }
                ];

                this.homey.app.log(`[Driver] ${this.id} - Found devices - `, this.results);

                if (this.results.length && this.type === 'repair') {
                    if (this.device) {
                        this.device.setSettings({
                            phonenumber: this.phonenumber
                        });

                        await this.device.setWhatsappClient();
                    }
                    session.showView('done');
                } else {
                    session.showView('list_devices');
                }
            }
        });

        session.setHandler('list_devices', async () => {
            return this.results;
        });

        session.setHandler('set_phone', async ({ number }) => {
            const phoneNumber = parsePhoneNumber(number);
            console.log(parsePhoneNumber(number));
            if (!phoneNumber.isValid()) {
                return false;
            }

            this.phonenumber = phoneNumber.number.replace('+', '');
            this.phonenumber = this.phonenumber.replace(' ', '');
            this.phonenumber = this.phonenumber.replace(' ', '');
            this.phonenumber = this.phonenumber.replace(' ', '');

            return true;
        });
    }
};
