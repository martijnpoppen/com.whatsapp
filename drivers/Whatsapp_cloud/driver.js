const Homey = require('homey');
const whatsappClient = require('../../lib/api/whatsapp');
const { GetGUID } = require('../../lib/helpers');

module.exports = class mainDriver extends Homey.Driver {
    onInit() {
        this.homey.app.log('[Driver] - init', this.id);
        this.homey.app.log(`[Driver] - version`, Homey.manifest.version);
        this.WhatsappClients = [];

        const devices = this.getDevices();

        devices.forEach(async (device) => {
            const deviceObject = device.getData();
            await this.setWhatsappClient(deviceObject.id);
        });
    }

    setWhatsappClient(deviceId) {
        this.WhatsappClients[deviceId] = new whatsappClient({
            deviceId
        });

        return this.WhatsappClients[deviceId];
    }

    async onPair(session) {
        this.type = 'pair';
        this.device = null;

        this.setPairingSession(session);
    }

    async onRepair(session, device) {
        this.type = 'repair';
        this.device = device;

        this.setPairingSession(session);
    }

    async setPairingSession(session) {
        const homeyCloudId = await this.homey.cloud.getHomeyId();
        const deviceObject = this.device && this.device.getData();

        this.guid = this.device ? deviceObject.id : `${homeyCloudId}_${GetGUID()}`;

        this.onReadyInterval = this.homey.setInterval(async () => {
            const data = await this.WhatsappClients[this.guid].addDevice();
            console.log(data);
            if (data.type === 'READY' && data.clientID === this.guid) {
                session.showView('loading2');
            }

            if (data.type === 'QR' && data.clientID === this.guid) {
                await session.emit('qr', data.msg);
            }
        }, 2000);

        session.setHandler('showView', async (view) => {
            this.homey.app.log(`[Driver] ${this.id} - currentView:`, { view, type: this.type });

            if (view === 'whatsapp_consent') {
                this.consent = false;

                const devices = this.getDevices();
                if (devices.length >= 2 && this.type === 'pair') {
                    this.cancelPairing = true;
                    session.showView('whatsapp_max');
                    return false;
                } else {
                    await this.setWhatsappClient(this.guid);
                }
            }

            if (view === 'whatsapp_qr') {
                await session.emit('qr', this.qr);
            }

            if (view === 'loading') {
                this.consent = true;

                const data = await this.WhatsappClients[this.guid].addDevice();

                if (data.type === 'QR' && data.clientID === this.guid) {
                    this.qr = data.msg;
                    session.showView('whatsapp_qr');
                }

                if (data.type === 'ERROR' && data.clientID === this.guid) {
                    session.showView('done');
                }
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
