import Homey from 'homey';
import { GetGUID, sleep } from '../../lib/helpers/index.mjs';
import whatsappClient from '../../lib/com.whatsapp.api/index.mjs';
import { parsePhoneNumber } from 'libphonenumber-js';

export default class mainDriver extends Homey.Driver {
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
                    if (session) session.showView('loading2');
                }

                if (data.type === 'CODE' && data.clientID === guid) {
                    this.code = data.msg;
                    if (session) await session.emit('code', data.msg);
                }

                if (data.type === 'CLOSED' && data.clientID === guid) {
                    if (session) session.showView('done');
                }
            }, 4000);

            setTimeout(() => {
                this.homey.app.log(`[Driver] ${this.id} - Disabling interval`);
                this.homey.clearInterval(this.onReadyInterval);
            }, 120000);
        } catch (error) {
            this.homey.clearInterval(this.onReadyInterval);
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
        const settings = device.getSettings();
        this.type = 'repair';
        this.device = device;
        this.phonenumber = settings.phonenumber;
        this.tempDB = {};
        this.code = null;

        await device.removeWhatsappClient();

        this.homey.app.log(`[Driver] ${this.id} - unsetting store for :`, device.getName());

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
                if (session) await session.emit('code', this.code);
            }

            if (view === 'loading') {
                if(this.type === 'repair') {
                    const storeData = this.device.getStore();
                    // create a loop with await to unset all store values
            
                    for await(const key of Object.keys(storeData)) {  
                        this.homey.app.log(`[Driver] ${this.id} - unsetting key:`, key);       
                        await this.device.unsetStoreValue(key);
                    }

                    await this.setWhatsappClient(this.guid, this.device);
                }


                if (this.type === 'pair') {
                    await this.setWhatsappClient(this.guid);
                }

                await this.WhatsappClients[this.guid].addDevice(this.phonenumber);

                this.setCheckInterval(session, this.guid);

                await sleep(5000);
                if (this.code.length) {
                    if (session) session.showView('whatsapp_pairing_code');
                }

                await sleep(3000);
                if (session) session.showView('whatsapp_pairing_code');
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
                    if (session) session.showView('done');
                } else {
                    if (session) session.showView('list_devices');
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
