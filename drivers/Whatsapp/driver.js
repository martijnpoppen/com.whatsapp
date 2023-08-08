const Homey = require('homey');
const path = require('path');
const { BaileysClass } = require('@bot-wa/bot-wa-baileys');

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
            await this.setWhatsappClientListeners(device, deviceObject.id);
        });
    }

    setWhatsappClient(deviceId) {
        this.WhatsappClients[deviceId] = new BaileysClass({
            name: deviceId,
            dir: `${path.resolve(__dirname, '/userdata/')}/`,
            plugin: false
        });

        return this.WhatsappClients[deviceId];
    }

    setWhatsappClientListeners(device = null, deviceId) {
        this.WhatsappClients[deviceId].once('qr', (qr) => {
            if (deviceId === this.guid) {
                this.qr = qr;
                this.homey.app.log(`[Driver] - setWhatsappClientListeners - QR`);
            }

            if (device) {
                this.homey.app.log(`[Device] ${device.getName()} - setWhatsappClientListeners - QR`);
                device.setUnavailable(`Repair device and Scan QR code to connect`);
            }
        });

        this.WhatsappClients[deviceId].once('ready', () => {
            if (deviceId === this.guid) {
                this.whatsappReady = true;
                this.homey.app.log(`[Driver] - setWhatsappClientListeners - Ready`);
            }

            if (device) {
                this.homey.app.log(`[Device] ${device.getName()} - setWhatsappClientListeners - Ready`);
                device.setAvailable();
            }
        });

        this.WhatsappClients[deviceId].once('auth_failure', (error) => {
            if (device) {
                this.homey.app.log(`[Device] ${device.getName()} - setWhatsappClientListeners - auth_failure`);
                device.setUnavailable(error);
            } else {
                this.homey.app.log(`[Driver]- setWhatsappClientListeners - auth_failure`);
            }
        });
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
        this.deviceObject = this.device && this.device.getData();
        this.guid = this.device ? this.deviceObject.id : GetGUID();

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
                    await this.setWhatsappClientListeners(null, this.guid);

                    this.onQRInterval = setInterval(() => {
                        if (this.qr && this.consent) {
                            session.showView('whatsapp_qr');
                        }
                    }, 2000);

                    this.onReadyInterval = setInterval(() => {
                        if (this.whatsappReady) {
                            session.showView('loading2');
                        }
                    }, 2000);
                }
            }

            if (view === 'whatsapp_qr') {
                clearInterval(this.onQRInterval);

                await session.emit('qr', this.qr);

                this.qr = null;
            }

            if (view === 'loading') {
                this.consent = true;

                if (this.qr) {
                    session.showView('whatsapp_qr');
                }
            }

            if (view === 'loading2') {
                clearInterval(this.onQRInterval);
                clearInterval(this.onReadyInterval);
                this.whatsappReady = null;

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
