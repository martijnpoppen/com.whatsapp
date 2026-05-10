import Homey from 'homey';
import { GetGUID, sleep } from '../../lib/helpers/index.mjs';
import whatsappClient from '../../lib/com.whatsapp.api/index.mjs';
import { parsePhoneNumberWithError } from 'libphonenumber-js';

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
        if (this.WhatsappClients[deviceId]) {
            delete this.WhatsappClients[deviceId];
        }

        this.WhatsappClients[deviceId] = new whatsappClient({
            deviceId,
            homeyData: {
                driver: this,
                device,
                app: this.homey.app
            }
        });
    }

    async setCheckInterval(ctx, session, guid) {
        // Clear any previous polling interval
        if (ctx._checkInterval) {
            ctx.homey.clearInterval(ctx._checkInterval);
            ctx._checkInterval = null;
        }

        ctx._checkInterval = ctx.homey.setInterval(async () => {
            try {
                ctx.homey.app.log(`[Driver] ${ctx.id} - setCheckInterval - poll`, { guid });

                if (!ctx.WhatsappClients[guid]) {
                    ctx.homey.app.log(`[Driver] ${ctx.id} - setCheckInterval - client gone, stopping`);
                    ctx.homey.clearInterval(ctx._checkInterval);
                    ctx._checkInterval = null;
                    return;
                }

                const data = await ctx.WhatsappClients[guid].getData();

                ctx.homey.app.log(`[Driver] ${ctx.id} - setCheckInterval - ${data.type}`, data);

                if (data.type === 'READY' && data.clientID === guid) {
                    ctx.homey.clearInterval(ctx._checkInterval);
                    ctx._checkInterval = null;
                    if (session) return session.showView('loading2');
                }

                if (data.type === 'CODE' && data.clientID === guid) {
                    ctx.code = data.msg;
                    ctx.homey.clearInterval(ctx._checkInterval);
                    ctx._checkInterval = null;
                    if (session) return await session.emit('code', data.msg);
                }

                if (data.type === 'CLOSED' && data.clientID === guid) {
                    ctx.homey.clearInterval(ctx._checkInterval);
                    ctx._checkInterval = null;
                    if (session) return session.showView('done');
                }
            } catch (error) {
                ctx.homey.app.error(`[Driver] ${ctx.id} setCheckInterval error`, error);
                ctx.homey.clearInterval(ctx._checkInterval);
                ctx._checkInterval = null;
            }
        }, 4000);
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

        // Clear any running check interval from a previous pairing/repair
        if (this._checkInterval) {
            this.homey.clearInterval(this._checkInterval);
            this._checkInterval = null;
        }

        await device.removeWhatsappClient();

        this.setPairingSession(session);
    }

    async setPairingSession(session) {
        const deviceObject = this.device && this.device.getData();

        this.guid = deviceObject ? deviceObject.id : `${this.homeyCloudId}_${GetGUID()}`;

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
                console.log('show pairing code view', { guid: this.guid, code: this.code });
                if (session) await session.emit('code', this.code);
                await this.setCheckInterval(this, session, this.guid);
            }

            if (view === 'loading') {
                await this.setWhatsappClient(this.guid, this.device); // don't send device during repair. we need a fresh client

                await this.WhatsappClients[this.guid].addDevice(this.phonenumber);
                await this.setCheckInterval(this, session, this.guid);

                session.showView('whatsapp_pairing_code');
            }

            if (view === 'loading2') {
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
            const phoneNumber = parsePhoneNumberWithError(number);
            console.log(parsePhoneNumberWithError(number));
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
}
