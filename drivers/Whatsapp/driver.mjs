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

    stopCheckInterval(ctx) {
        if (ctx._checkInterval) {
            ctx.homey.clearInterval(ctx._checkInterval);
            ctx._checkInterval = null;
        }
    }

    async setCheckInterval(ctx, session, guid) {
        // Idempotent: the pairing-code view triggers a showView on the driver
        // as well as being reached from the poll below, and restarting the
        // interval there used to reset the poll on every re-render.
        if (ctx._checkInterval) return;

        ctx._checkInterval = ctx.homey.setInterval(async () => {
            try {
                ctx.homey.app.log(`[Driver] ${ctx.id} - setCheckInterval - poll`, { guid });

                if (!ctx.WhatsappClients[guid]) {
                    ctx.homey.app.log(`[Driver] ${ctx.id} - setCheckInterval - client gone, stopping`);
                    ctx.stopCheckInterval(ctx);
                    return;
                }

                const data = await ctx.WhatsappClients[guid].getData();

                // getData() returns false while the client is still starting up.
                if (!data || data.clientID !== guid) return;

                ctx.homey.app.log(`[Driver] ${ctx.id} - setCheckInterval - ${data.type}`, data);

                if (data.type === 'READY') {
                    ctx.stopCheckInterval(ctx);
                    if (session) return session.showView('loading2');
                }

                if (data.type === 'CODE') {
                    const isNewCode = ctx.code !== data.msg;
                    ctx.code = data.msg;
                    ctx.pairError = null;

                    if (!session) return;

                    // Push it, but the view also pulls it via `get_pairing_code`
                    // once its listener is actually attached — session.emit() is
                    // fire-and-forget and is dropped when the target view has not
                    // finished loading, which is why the code never showed up.
                    if (isNewCode) session.emit('code', data.msg);

                    if (!ctx.codeShown) {
                        ctx.codeShown = true;
                        // Show the view once. It used to be re-shown on every
                        // poll (clientInfo stays CODE until the user pairs),
                        // which reloaded the page every 4s and wiped whatever
                        // had just been rendered into it.
                        await session.showView('whatsapp_pairing_code');
                    }

                    // Deliberately keep polling: after the user types the code
                    // into WhatsApp we still need READY (or ERROR) to move on.
                    return;
                }

                if (data.type === 'ERROR') {
                    ctx.pairError = data.msg || 'Pairing failed';
                    ctx.stopCheckInterval(ctx);
                    if (session) session.emit('pair_error', ctx.pairError);
                    return;
                }

                if (data.type === 'CLOSED') {
                    ctx.stopCheckInterval(ctx);
                    if (session) return session.showView('done');
                }
            } catch (error) {
                ctx.homey.app.error(`[Driver] ${ctx.id} setCheckInterval error`, error);
                ctx.stopCheckInterval(ctx);
            }
        }, 4000);
    }

    async onPair(session) {
        this.type = 'pair';
        this.device = null;
        this.code = null;
        this.codeShown = false;
        this.pairError = null;

        this.stopCheckInterval(this);

        this.setPairingSession(session);
    }

    async onRepair(session, device) {
        const settings = device.getSettings();
        this.type = 'repair';
        this.device = device;
        this.phonenumber = settings.phonenumber;
        this.code = null;
        this.codeShown = false;
        this.pairError = null;

        // Clear any running check interval from a previous pairing/repair
        this.stopCheckInterval(this);

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
                this.homey.app.log(`[Driver] ${this.id} - pairing code view`, { guid: this.guid, hasCode: !!this.code });

                // Best-effort push. The view pulls via `get_pairing_code` as
                // soon as its script runs, which is the path we actually rely
                // on — this handler fires while the view is still loading, so
                // an emit here has nothing listening on the other end yet.
                if (this.code) session.emit('code', this.code);

                await this.setCheckInterval(this, session, this.guid);
            }

            if (view === 'loading') {
                this.code = null;
                this.codeShown = false;
                this.pairError = null;

                await this.setWhatsappClient(this.guid, this.device); // don't send device during repair. we need a fresh client

                // forceNewSession: wipe /userdata/auth/<guid> before connecting.
                // Without it Baileys loads the existing creds.json, sees
                // `registered === true` and never calls requestPairingCode.
                await this.WhatsappClients[this.guid].addDevice(this.phonenumber, true);
                await this.setCheckInterval(this, session, this.guid);
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

        // The pairing-code view asks for the code itself once it is mounted.
        // session.emit() is fire-and-forget with no buffering, so any push that
        // happens before the view finished loading is silently lost; pulling
        // removes that race entirely.
        session.setHandler('get_pairing_code', async () => {
            return { code: this.code || null, error: this.pairError || null };
        });

        session.setHandler('disconnect', async () => {
            this.homey.app.log(`[Driver] ${this.id} - pair session disconnected`);
            this.stopCheckInterval(this);
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
