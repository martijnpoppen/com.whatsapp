const Homey = require('homey');
const { GetGUID, sleep } = require('../../lib/helpers');
const whatsappClient = require('../../lib/api/whatsapp');

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
            await this.setWhatsappClient(deviceObject.id);
        });
    }

    async setWhatsappClient(deviceId) {
        this.WhatsappClients[deviceId] = new whatsappClient({
            deviceId,
            url: Homey.env.API
        });

        return this.WhatsappClients[deviceId];
    }

    async setCheckInterval(session, guid) {
        this.onReadyInterval = this.homey.setInterval(async () => {
            const data = await this.WhatsappClients[guid].getData();

            if (data.type === 'READY' && data.clientID === guid) {
                session.showView('loading2');
            }

            if (data.type === 'QR' && data.clientID === guid) {
                await session.emit('qr', data.msg);
            }
        }, 4000);

        setTimeout(() => {
            this.homey.clearInterval(this.onReadyInterval);
        }, 30000);
    }

    async onPair(session) {
        this.type = 'pair';
        this.device = null;

        this.setPairingSession(session);
    }

    async onRepair(session, device) {
        this.type = 'repair';
        this.device = device;

        this.homey.app.log(`[Driver] ${this.id} - unsetting store for :`, device.id);
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

            if (view === 'whatsapp_qr') {
                await session.emit('qr', this.qr);
            }

            if (view === 'loading') {
                await this.setWhatsappClient(this.guid);
                await this.WhatsappClients[this.guid].addDevice();

                this.setCheckInterval(session, this.guid);

                await sleep(5000);
                session.showView('whatsapp_qr');
            }

            if (view === 'loading2') {
                this.homey.clearInterval(this.onReadyInterval);

                this.results = [
                    {
                        name: `Whatsapp`,
                        data: {
                            id: this.guid
                        }
                    }
                ];

                this.homey.app.log(`[Driver] ${this.id} - Found devices - `, this.results);

                if (this.results.length && this.type === 'repair') {
                    if (this.device) {
                        this.device.setWhatsappClient();
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
    }
};
